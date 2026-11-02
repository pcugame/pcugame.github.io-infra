import { openPackageReader } from '../modules/build-package/reader.js';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { validateBoundedZipFile } from '../modules/archive/bounded-zip-validator.js';
import { inspectBuildPackage, isBuildContainer } from '../modules/build-package/inspect.js';
import { defoldArchiveIndex } from '../modules/build-package/defold.js';
import { godotPackStructure } from '../modules/build-package/godot.js';
import { renpyCompiledScript } from '../modules/build-package/renpy.js';
import { makeZip, nativeElfFixture } from './helpers/build-zip.js';
const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function inspect(files: Parameters<typeof makeZip>[0], profile: 'WEBGL' | 'GAME' = 'WEBGL') {
	const dir = await mkdtemp(join(tmpdir(), 'build-engine-'));
	dirs.push(dir);
	const archivePath = join(dir, 'build.zip');
	await writeFile(archivePath, makeZip(files));
	const summary = await validateBoundedZipFile(archivePath, {
		profile,
		allowNestedArchivePath: isBuildContainer,
	});
	return inspectBuildPackage({ archivePath, summary, tempByteLimit: 6 * 1024 ** 3 });
}
describe('bounded engine adapters', () => {
	it('does not interpret a shader src property as a required script URL', async () => {
		const result = await inspect([
			{
				name: 'game.html',
				data: '<canvas></canvas><script>const filter={};filter.src="void main() {}";</script>',
			},
		]);
		expect(result.outcome).toBe('REVIEW');
		expect(result.reasons).not.toEqual(expect.arrayContaining([expect.stringMatching(/^missing:/)]));
	});
	it.each([
		'pc.Application',
		'gdjs.projectData',
		'C3_CreateRuntime',
		'GameMaker_Init',
		'Scene_Boot',
		'Module.runApp',
		'cc.game',
		'renpy',
	])('does not approve the %s name alone', async (hint) => {
		const result = await inspect([
			{
				name: 'index.html',
				data: `<canvas></canvas><script>const documentation=${JSON.stringify(hint)};</script>`,
			},
		]);
		expect(result.outcome).toBe('REVIEW');
	});
	it('resolves framework directory links in memory without creating filesystem links', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'build-link-'));
		dirs.push(dir);
		const archivePath = join(dir, 'app.zip');
		await writeFile(
			archivePath,
			makeZip([
				{ name: 'Framework/Versions/A/program', data: 'actual-runtime' },
				{
					name: 'Framework/Versions/Current',
					data: 'A',
					versionMadeBy: (3 << 8) | 20,
					externalFileAttributes: 0xa1ff0000,
				},
				{
					name: 'Framework/program',
					data: 'Versions/Current/program',
					versionMadeBy: (3 << 8) | 20,
					externalFileAttributes: 0xa1ff0000,
				},
			]),
		);
		const summary = await validateBoundedZipFile(archivePath, { profile: 'GAME' }),
			reader = await openPackageReader(archivePath, summary);
		try {
			expect(reader.entries.has('Framework/Versions/Current/program')).toBe(true);
			expect((await reader.read('Framework/Versions/Current/program')).toString()).toBe('actual-runtime');
			expect((await reader.readRange('Framework/program', 7, 7)).toString()).toBe('runtime');
		} finally {
			reader.close();
		}
	});
	it('rejects a library-only native package', async () => {
		const library = nativeElfFixture();
		library.writeBigUInt64LE(0n, 24);
		const result = await inspect(
			[
				{ name: 'libengine.so', data: library },
				{ name: 'README.txt', data: 'data only' },
			],
			'GAME',
		);
		expect(result.outcome).toBe('REJECT');
	});
	it('checks Defold index references against the real archive size', () => {
		const index = Buffer.alloc(128);
		index.writeUInt32BE(4);
		index.writeUInt32BE(1, 16);
		index.writeUInt32BE(112, 20);
		index.writeUInt32BE(48, 24);
		index.writeUInt32BE(20, 28);
		index.writeUInt32BE(0, 112);
		index.writeUInt32BE(20, 116);
		index.writeUInt32BE(0xffffffff, 120);
		expect(defoldArchiveIndex(index, 128, 20)).toBe(true);
		expect(() => defoldArchiveIndex(index, 128, 19)).toThrow(/exceeds/);
		index.writeUInt32BE(99);
		expect(defoldArchiveIndex(index, 128, 20)).toBe(false);
	});
	it('keeps new/encrypted PCK variants reviewable and rejects invalid compiled script ranges', () => {
		const pck = Buffer.alloc(100);
		pck.write('GDPC');
		pck.writeUInt32LE(99, 4);
		expect(godotPackStructure(pck, pck.length)).toBe('unsupported');
		const rpyc = Buffer.alloc(40);
		rpyc.write('RENPY RPC2');
		rpyc.writeUInt32LE(1, 10);
		rpyc.writeUInt32LE(34, 14);
		rpyc.writeUInt32LE(6, 18);
		expect(renpyCompiledScript(rpyc, 40)).toBe(true);
		rpyc.writeUInt32LE(7, 18);
		expect(() => renpyCompiledScript(rpyc, 40)).toThrow(/ranges/);
	});
});
const root = process.env['ENGINE_FIXTURE_ROOT'];
describe.runIf(!!root)('pinned actual engine exports', () => {
	it.each(['playcanvas', 'defold', 'construct', 'rpgmaker', 'gdevelop-red', 'cocos', 'gamemaker', 'renpy8'])(
		'accepts %s root and custom Korean entry layouts',
		async (name) => {
			for (const variant of ['', '-custom']) {
				const archivePath = join(root!, name + variant + '.zip');
				const summary = await validateBoundedZipFile(archivePath, {
					profile: 'WEBGL',
					allowNestedArchivePath: isBuildContainer,
				});
				const result = await inspectBuildPackage({ archivePath, summary, tempByteLimit: 6 * 1024 ** 3 });
				expect(result.outcome, JSON.stringify(result.reasons)).toBe('PASS');
				expect(result.entryPath).toBe(variant ? 'one/two/한글 배포/game.html' : 'index.html');
			}
		},
		60000,
	);
	it('rejects a removed actual Construct bootstrap dependency', async () => {
		const html = await readFile(join(root!, 'construct/index.html'), 'utf8');
		expect((await inspect([{ name: 'game.html', data: html }])).outcome).toBe('REJECT');
	});
});
