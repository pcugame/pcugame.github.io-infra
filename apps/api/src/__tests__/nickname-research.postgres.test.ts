import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LAB_RESEARCH_PROFILE, LAB_RESEARCH_SYSTEM_PROMPT, LabResultSchema } from '@pcu/contracts';
import { buildApp } from '../app.js';
import { createProductionBackendContext } from '../backend-context.js';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';
import { defaultTestEnv } from './helpers/app-mocks.js';

describe.runIf(process.env.RUN_POSTGRES_INTEGRATION === 'true')('research profile API and independent worker (Fake HTTP Provider)', () => {
	let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>;
	let app: FastifyInstance;
	let worker: ChildProcess;
	let workerClosed: Promise<unknown>;
	let cookie: string;
	let datasetId: string;
	const identity = { weights_sha256: 'a'.repeat(64), chat_template_sha256: 'b'.repeat(64),
		chat_template: 'fake-template', engine_version: 'fake-provider', context_tokens: 3072, kv_cache: 'f16', gpu_layers: 99, seed: 42,
		structured_output_transport: 'rendered-completion-json-schema' };
	const respond = async (req: IncomingMessage, res: ServerResponse) => {
		try {
			let result: unknown;
			const url = new URL(req.url!, 'http://fixture');
			if (url.pathname === '/health') result = { ok: true, busy: false, model: 'fixture-4b', profile: LAB_RESEARCH_PROFILE,
				max_input_tokens: 2048, max_output_tokens: 768, supports_json_schema: true, identity };
			else if (url.pathname === '/config') result = { engines: [], formats: ['json'] };
			else if (url.pathname === '/search') result = { results: [{ title: '합성 검증 자료', url: 'https://example.org/research', content: '가상 닉네임에 대한 합성 설명' }] };
			else {
				const parts: Buffer[] = [];
				for await (const part of req) parts.push(Buffer.from(part));
				const wire = Buffer.concat(parts).toString();
				expect(wire).not.toContain('SECRET_REFERENCE');
				const body = JSON.parse(wire);
				expect(body.weights_sha256).toBe(identity.weights_sha256);
				if (url.pathname === '/tokenize') result = { input_tokens: 500 };
				else {
					const input = JSON.parse(body.prompt);
					expect(Object.keys(input.case)).toEqual(['nickname']);
					const action = body.json_schema.properties.action;
					const output = action ? { action: input.searchOutcomes.length ? 'finish' : 'search',
						query: input.searchOutcomes.length ? null : '가상 표현 뜻', hypotheses: [{ term: '가상 표현', basis: '합성 가설' }] }
						: { schemaVersion: '2', nickname: input.case.nickname, interpretedTerm: null, interpretationStatus: 'unverified_hypothesis', reason: '합성 검증 자료만으로 판단을 유보함',
							score: null, confidence: 0.2, sourceIds: input.sources.map((s: { id: string }) => s.id), abstained: true,
							evidenceChecks: input.sources.map((s: { id: string; snippet: string }) => ({ sourceId: s.id, quote: s.snippet, claim: '합성 설명', relation: 'ordinary_usage' })) };
					result = { text: JSON.stringify(output), input_tokens: 500, output_tokens: 100, seconds: 0.01, finish_reason: 'stop' };
				}
			}
			res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
		} catch { res.writeHead(500).end(); }
	};
	const server = createServer((req, res) => { void respond(req, res); });
	async function api(method: 'GET' | 'POST', path: string, payload?: object, status = 200) {
		const response = await app.inject({ method, url: '/api/lab' + path, payload,
			headers: { origin: 'http://localhost:5173', cookie } });
		expect(response.statusCode, response.body).toBe(status);
		return response.json().data;
	}
	beforeAll(async () => {
		database = await createIsolatedMigratedDatabase(process.env.DATABASE_URL!);
		server.listen(0, '127.0.0.1'); await once(server, 'listening');
		const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
		const env = { LAB_ENABLED: 'true', LAB_MODEL_PROVIDER: 'transformers-generate', LAB_MODEL: 'fixture-4b',
			LAB_MODEL_URL: base, LAB_SEARXNG_URL: base, LAB_GENERATE_PROFILE: LAB_RESEARCH_PROFILE, LAB_CONCURRENCY: '1' };
		const context = await createProductionBackendContext({ ...defaultTestEnv, ...env,
			DATABASE_URL: database.url, LOG_LEVEL: 'fatal', DEV_AUTH_ENABLED: true,
			GOOGLE_CLIENT_IDS: ['test-client-id'], CORS_ALLOWED_ORIGINS: ['http://localhost:5173'] });
		app = await buildApp({ context });
		const login = await app.inject({ method: 'POST', url: '/api/dev/auth/login',
			headers: { origin: 'http://localhost:5173' }, payload: { role: 'BETA_TESTER' } });
		expect(login.statusCode).toBe(200);
		cookie = login.cookies[0]!.name + '=' + login.cookies[0]!.value;
		expect(await api('GET', '/datasets')).toEqual([]);
		datasetId = (await api('POST', '/datasets', { name: 'research fixture', format: 'jsonl', content: JSON.stringify({
			nickname: '가상산책', reference: { expectedReason: 'SECRET_REFERENCE', expectedScore: 50 },
		}) }, 201)).id;
		worker = spawn(process.execPath, ['--import', 'tsx', 'src/benchmark-worker.ts'], {
			cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: 'inherit', env: { ...process.env, ...env, DATABASE_URL: database.url },
		});
		workerClosed = once(worker, 'close');
	}, 60_000);
	afterAll(async () => {
		if (worker && worker.exitCode === null) { worker.kill('SIGTERM'); await workerClosed; }
		await app?.close(); server.closeAllConnections();
		if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
		await database?.close();
	});
	it('serializes the research status, all three modes, pinned prompts, collected links and full traces through authenticated routes and exports', async () => {
		expect(await api('GET', '/status')).toMatchObject({ modelStatus: 'available', agenticRetrieval: true,
			toolSupport: 'unsupported', generationLimits: { maxInputTokens: 2048, maxOutputTokens: 768 } });
		for (const searchMode of ['no_search', 'backend_retrieval', 'agentic_retrieval']) {
			const { runId } = await api('POST', '/runs', { datasetId, size: 1, model: 'fixture-4b', searchMode,
				temperature: 0, maxTokens: 768 }, 202);
			let run;
			for (let tries = 0; tries < 60; tries++) {
				run = await api('GET', '/runs/' + runId);
				if (run.status === 'COMPLETED') break;
				await delay(250);
			}
			expect(run).toMatchObject({ status: 'COMPLETED', success: 1, evaluationProtocol: LAB_RESEARCH_PROFILE,
				systemPrompt: LAB_RESEARCH_SYSTEM_PROMPT, searchMode });
			const { items } = await api('GET', `/runs/${runId}/results`);
			const result = LabResultSchema.parse(items[0]);
			expect(result.output).toMatchObject({ nickname: '가상산책', score: null, abstained: true });
			expect(result.sources).toHaveLength(searchMode === 'no_search' ? 0 : 1);
			expect(JSON.stringify(result.history)).toContain('weights_sha256');
			expect(JSON.stringify(result.history)).not.toContain('SECRET_REFERENCE');
			for (const format of ['json', 'jsonl', 'csv']) {
				const exported = await api('GET', `/runs/${runId}/export?format=${format}`);
				expect(exported.content).toContain('weights_sha256');
				if (searchMode !== 'no_search') expect(exported.content).toContain('https://example.org/research');
			}
			expect((await api('GET', `/runs/${runId}/results?q=missing`)).items).toEqual([]);
		}
	});
});
