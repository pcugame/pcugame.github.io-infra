/** Local acceptance using the production Nginx template, real HTTP auth/serializers and isolated PostgreSQL.
 * Requires DATABASE_URL, PLAYWRIGHT_MODULE_PATH and CHROMIUM_EXECUTABLE. Nothing is deployed externally.
 */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const Fastify = require('fastify');
const cookie = require('@fastify/cookie');
const { serializerCompiler, validatorCompiler } = require('@fastify/type-provider-zod');
import { createIsolatedMigratedDatabase } from '../../apps/api/src/__tests__/helpers/isolated-migrated-database.ts';
import { registerAuth } from '../../apps/api/src/plugins/auth.ts';
import { registerRouteSchemas } from '../../apps/api/src/shared/http-route-schemas.ts';
import { createWebglPlayRepository } from '../../apps/api/src/modules/webgl-play/repository.ts';
import { createWebglPlayService } from '../../apps/api/src/modules/webgl-play/service.ts';
import { createWebglPlayController } from '../../apps/api/src/modules/webgl-play/controller.ts';
import { createFileAccessRepository } from '../../apps/api/src/modules/file-access/repository.ts';
import { createFileAccessController } from '../../apps/api/src/modules/file-access/controller.ts';
import { createDiagnosticRepository } from '../../apps/api/src/modules/webgl-play/diagnostic-repository.ts';
import { createDiagnosticService } from '../../apps/api/src/modules/webgl-play/diagnostic-service.ts';
import { webglContentMetadata } from '../../apps/api/src/modules/webgl/content.ts';
import type { Env } from '../../apps/api/src/config/env.ts';

const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'pcu-build-gateway-'));
const container = 'pcu-build-gateway-' + randomUUID();
const database = await createIsolatedMigratedDatabase(process.env.DATABASE_URL!);
const db = database.createClient();
const objects = new Map<string, { body: Buffer; type: string; encoding?: string }>();
const objectServer = createServer((request, response) => {
	const item = objects.get(decodeURIComponent(request.url!.slice(1)));
	if (!item) {
		response.writeHead(404).end();
		return;
	}
	response.setHeader('Content-Type', item.type);
	if (item.encoding) response.setHeader('Content-Encoding', item.encoding);
	response.end(item.body);
});
const apiOrigin = 'http://127.0.0.1:19112',
	assetsOrigin = 'http://127.0.0.1:19111';
const config = {
	WEBGL_PLAY_ENABLED: true,
	BUILD_PACKAGE_REVIEW_ENABLED: true,
	API_PUBLIC_URL: apiOrigin,
	WEB_PUBLIC_URL: apiOrigin,
	PUBLIC_ASSET_ORIGIN: assetsOrigin,
	S3_BUCKET_PUBLIC: 'public',
	S3_BUCKET_PROTECTED: 'protected',
	S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT: 'http://127.0.0.1:19114',
	SESSION_COOKIE_NAME: 'sid',
	SESSION_IDLE_MS: 3600000,
	SESSION_TOUCH_MIN_INTERVAL_MS: 60000,
	COOKIE_SECURE: false,
	COOKIE_SAME_SITE: 'lax',
	CORS_ALLOWED_ORIGINS: [apiOrigin],
	FILE_GATEWAY_SECRET: randomUUID(),
} as Env;
const app = Fastify();
let browser: any;
try {
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(serializerCompiler);
	await app.register(cookie);
	await registerAuth(app, {
		config,
		clock: { now: () => new Date() },
		logger: app.log,
		sessions: {
			find: (id) => db.authSession.findUnique({ where: { id }, include: { user: true } }),
			touch: async () => {},
			delete: async (id) => {
				await db.authSession.delete({ where: { id } });
			},
		},
	});
	registerRouteSchemas(app);
	const service = createWebglPlayService(
		createWebglPlayRepository(db),
		config,
		createDiagnosticService(createDiagnosticRepository(db), () => new Date()),
	);
	await app.register(createWebglPlayController(service, config));
	await app.register(
		createFileAccessController(
			createFileAccessRepository(db),
			config,
			() => {},
			() => new Date(),
			undefined,
			undefined,
			service.resolveRuntime,
		),
		{ prefix: '/api' },
	);
	await app.listen({ host: '127.0.0.1', port: 19112 });
	await new Promise<void>((yes) => objectServer.listen(19113, '127.0.0.1', yes));
	const substitutions: Record<string, string> = {
		FILE_GATEWAY_TLS_SERVER_NAME: 'localhost',
		PUBLIC_CORS_ORIGIN_PRIMARY: apiOrigin,
		PUBLIC_CORS_ORIGIN_SECONDARY: 'http://localhost:19112',
		NGINX_LISTEN_PORT: '19111',
		NGINX_RESOLVER: '127.0.0.11',
		FILE_GATEWAY_API_UPSTREAM: apiOrigin,
		FILE_GATEWAY_SECRET: config.FILE_GATEWAY_SECRET!,
		GARAGE_PUBLIC_WEB_UPSTREAM: 'http://127.0.0.1:19113',
		GARAGE_PUBLIC_BUCKET_HOST: 'public.localhost',
		GARAGE_PUBLIC_WEB_TLS_SERVER_NAME: 'localhost',
		WEB_PUBLIC_ORIGIN: apiOrigin,
	};
	const template = await readFile('apps/db/public-origin.nginx.conf.template', 'utf8');
	const rendered = template.replace(/\$\{([A-Z_]+)\}/g, (_match, key) => {
		if (!(key in substitutions)) throw new Error('Missing gateway setting ' + key);
		return substitutions[key]!;
	});
	await writeFile(join(directory, 'default.conf'), rendered);
	await exec('docker', [
		'run',
		'-d',
		'--network',
		'host',
		'--name',
		container,
		'-v',
		`${directory}/default.conf:/etc/nginx/conf.d/default.conf:ro`,
		'nginx:1.27-alpine',
	]);
	let healthy = false;
	for (let i = 0; i < 30; i++) {
		try {
			if ((await fetch(assetsOrigin + '/__pcu_public_health')).status === 204) {
				healthy = true;
				break;
			}
		} catch {}
		await new Promise((yes) => setTimeout(yes, 100));
	}
	if (!healthy) {
		const logs = await exec('docker', ['logs', container]);
		throw new Error('Gateway did not start: ' + logs.stdout + logs.stderr);
	}
	const user = await db.user.create({
		data: { googleSub: randomUUID(), email: randomUUID() + '@test.invalid' },
	});
	const session = await db.authSession.create({
		data: { userId: user.id, expiresAt: new Date(Date.now() + 3600000) },
	});
	const exhibition = await db.exhibition.create({
		data: { year: 2097, title: 'Local build acceptance', visibility: 'PUBLIC' },
	});
	await db.storageBucket.createMany({
		data: [
			{ bucket: 'public', visibility: 'PUBLIC' },
			{ bucket: 'protected', visibility: 'PROTECTED' },
		],
	});
	const playwright = await import(
		pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH!, 'index.mjs')).href
	);
	browser = await playwright.chromium.launch({
		executablePath: process.env.CHROMIUM_EXECUTABLE,
		args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
	});
	const scenarios: Array<{
		name: string;
		entry: string;
		files: Map<string, Buffer>;
		ready?: string;
	}> = [
		{
			name: 'Canvas 2D',
			entry: '게임 시작.html',
			files: new Map<string, Buffer>([
				[
					'게임 시작.html',
					Buffer.from(
						'<!doctype html><canvas id="game" width="200" height="100"></canvas><script type="module" src="game.mjs.gz"></script>',
					),
				],
				[
					'game.mjs.gz',
					gzipSync(`const ctx=document.querySelector('canvas').getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,200,100);
const response=await fetch('game.wasm');await WebAssembly.instantiateStreaming(response);
const memory=new WebAssembly.Memory({initial:1,maximum:1,shared:true});const worker=new Worker('worker.js');
worker.onmessage=event=>{window.fixtureReady=event.data===42&&crossOriginIsolated;};worker.postMessage(memory);
try{await fetch('https://blocked.invalid/data');}catch{window.externalBlocked=true;}`),
				],
				['game.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])],
				[
					'worker.js',
					Buffer.from(
						'onmessage=event=>{const values=new Int32Array(event.data.buffer);Atomics.store(values,0,42);postMessage(Atomics.load(values,0));};',
					),
				],
			]),
		},
	];
	if (process.env.GODOT_FIXTURE_ROOT) {
		const catalog = JSON.parse(await readFile('scripts/build-fixtures/godot-pong.json', 'utf8'));
		const files = new Map<string, Buffer>();
		for (const file of catalog.files)
			files.set(
				file.path === 'index.html' ? 'game.html' : file.path,
				await readFile(join(process.env.GODOT_FIXTURE_ROOT, file.path)),
			);
		scenarios.push({ name: 'Godot Pong', entry: 'game.html', files });
	}
	if (process.env.ENGINE_FIXTURE_ROOT) {
		const readiness: Record<string, string> = {
			renpy8: "window.Module && Module.calledRun === true && !document.getElementById('presplash')",
			gamemaker: "typeof window.GameMaker_Init === 'function' && !!document.querySelector('canvas')",
			playcanvas: 'window.pc && pc.Application.getApplication()?.frame > 3',
			defold: 'window.Module && Module.calledRun === true',
			construct: "window.c3_runtimeInterface && !!document.querySelector('canvas')",
			rpgmaker:
				'window.SceneManager && SceneManager._scene instanceof Scene_Title && SceneManager._scene.isReady()',
			'gdevelop-red': "window.gdjs && !!document.querySelector('canvas')",
			cocos: "window.System && System.import('cc').then(cc => !!cc.director.getScene())",
		};
		for (const name of (process.env.ENGINE_BROWSER_SCENARIOS ?? Object.keys(readiness).join(',')).split(
			',',
		)) {
			const catalog = JSON.parse(await readFile(`scripts/build-fixtures/${name}.json`, 'utf8'));
			const files = new Map<string, Buffer>();
			for (const file of catalog.files)
				files.set(
					file.path === 'index.html' ? 'game.html' : file.path,
					await readFile(join(process.env.ENGINE_FIXTURE_ROOT, name, file.path)),
				);
			scenarios.push({
				name,
				entry: 'game.html',
				files,
				ready: readiness[name],
			});
		}
	}
	for (const scenario of scenarios) {
		const project = await db.project.create({
			data: {
				exhibitionId: exhibition.id,
				creatorId: user.id,
				slug: randomUUID(),
				title: scenario.name,
				status: 'PUBLISHED',
				visibility: 'AUTHENTICATED',
			},
		});
		const asset = await db.asset.create({
			data: {
				projectId: project.id,
				kind: 'WEBGL',
				status: 'READY',
				representations: {
					create: {
						role: 'WEBGL_SOURCE',
						bucket: 'protected',
						objectKey: randomUUID(),
						state: 'READY',
						mimeType: 'application/zip',
					},
				},
			},
			include: { representations: true },
		});
		const id = randomUUID(),
			prefix = `public/webgl/${project.id}/${id}/`;
		const manifest = [];
		for (const [path, body] of scenario.files) {
			const meta = webglContentMetadata(path);
			objects.set(prefix + path, {
				body,
				type: meta.contentType,
				encoding: meta.contentEncoding,
			});
			manifest.push({
				objectKey: prefix + path,
				sizeBytes: String(body.length),
				mimeType: meta.contentType,
				...(meta.contentEncoding ? { contentEncoding: meta.contentEncoding } : {}),
			});
		}
		await db.webglDeployment.create({
			data: {
				id,
				projectId: project.id,
				sourceRepresentationId: asset.representations[0]!.id,
				publicBucket: 'public',
				publicPrefix: prefix,
				entryObjectKey: prefix + scenario.entry,
				state: 'READY',
				objectManifest: { version: 1, objects: manifest },
			},
		});
		await db.project.update({
			where: { id: project.id },
			data: { currentWebglDeploymentId: id },
		});
		const context = await browser.newContext();
		await context.addCookies([{ name: 'sid', value: session.id, url: apiOrigin }]);
		if (scenario.name === 'Canvas 2D')
			await context.addInitScript(() => {
				const original = HTMLCanvasElement.prototype.getContext;
				HTMLCanvasElement.prototype.getContext = function (type: any, ...args: any[]) {
					return type === '2d' ? original.apply(this, [type, ...args] as any) : null;
				} as any;
			});
		const page = await context.newPage();
		const errors: string[] = [];
		page.on('pageerror', (error: Error) => {
			if (/Failed to register a ServiceWorker/.test(error.message) && /403/.test(error.message)) return; // Expected existing gateway policy, not a startup failure.
			errors.push(error.message);
		});
		page.on('console', (message: any) => {
			if (message.type() === 'error') console.error('Browser console:', message.text());
		});
		page.on('requestfailed', (request: any) =>
			console.error('Request failed', new URL(request.url()).pathname, request.failure()),
		);
		page.on('response', async (response: any) => {
			if (response.status() >= 400)
				console.error(
					'HTTP failure',
					response.status(),
					new URL(response.url()).pathname,
					await response.text().catch(() => ''),
				);
		});
		const frameReady = page.waitForEvent('framenavigated', {
			predicate: (frame: any) => frame.url().startsWith(assetsOrigin + '/runtime/'),
			timeout: 20000,
		});
		await page.goto(apiOrigin + `/play/projects/${project.id}`);
		const frame = await frameReady.catch(async (error) => {
			console.error('Shell status:', await page.locator('body').innerText());
			console.error(
				'Browser errors:',
				errors,
				'Frames:',
				page.frames().map((f: any) => f.url()),
			);
			console.error('Gateway logs:', (await exec('docker', ['logs', container])).stdout);
			await page.screenshot({ path: join(directory, 'failed.png') });
			throw error;
		});
		if (!frame) throw new Error('Runtime frame was not opened');
		await frame.waitForFunction(
			scenario.ready ??
				(scenario.name === 'Canvas 2D'
					? 'window.fixtureReady === true && window.externalBlocked === true'
					: "!document.getElementById('status')"),
			{},
			{ timeout: 60000 },
		);
		const sw = await context.request.get(frame.url(), {
			headers: { 'Service-Worker': 'script' },
		});
		if (sw.status() !== 403) throw new Error('Gateway allowed a service worker');
		await page.waitForTimeout(scenario.name === 'cocos' ? 10000 : 2500);
		if (errors.length) throw new Error(errors.join('\n'));
		await page.screenshot({
			path: join(directory, scenario.name.replace(/ /g, '-') + '.png'),
		});
		console.log(
			JSON.stringify({
				scenario: scenario.name,
				browser: browser.version(),
				gateway: 'production Nginx template',
				entry: scenario.entry,
				passed: true,
				screenshot: directory,
			}),
		);
		await context.close();
	}
} finally {
	await browser?.close();
	await exec('docker', ['rm', '-f', container]).catch(() => {});
	await app.close();
	objectServer.close();
	await database.close();
	// Preserve screenshots only when explicitly requested; otherwise remove this run's temporary data.
	if (!process.env.KEEP_BUILD_BROWSER_ARTIFACTS) await rm(directory, { recursive: true, force: true });
}
