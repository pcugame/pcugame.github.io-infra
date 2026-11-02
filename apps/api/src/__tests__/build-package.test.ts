import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { validateBoundedZipFile } from '../modules/archive/bounded-zip-validator.js';
import { inspectBuildPackage, isBuildContainer } from '../modules/build-package/inspect.js';
import { executableFormat } from '../modules/build-package/binary.js';
import { analyzeWebglArchive } from '../modules/webgl/archive.js';
import { makeZip, nativeElfFixture as elf } from './helpers/build-zip.js';
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function archive(bytes: Buffer) {
	const dir = await mkdtemp(join(tmpdir(), 'build-package-test-'));
	directories.push(dir);
	const path = join(dir, 'source.zip');
	await writeFile(path, bytes);
	return path;
}

async function inspect(
	files: Parameters<typeof makeZip>[0],
	profile: 'GAME' | 'WEBGL' = 'GAME',
	selectedEntry?: string,
) {
	const archivePath = await archive(makeZip(files));
	const summary = await validateBoundedZipFile(archivePath, {
		profile,
		allowNestedArchivePath: isBuildContainer,
	});
	return {
		summary,
		result: await inspectBuildPackage({ archivePath, summary, tempByteLimit: 10 * 1024 ** 3, selectedEntry }),
	};
}
function zip64(zip: Buffer) {
	const end = zip.length - 22,
		centralOffset = zip.readUInt32LE(end + 16),
		centralSize = zip.readUInt32LE(end + 12),
		count = zip.readUInt16LE(end + 10);
	const record = Buffer.alloc(56);
	record.writeUInt32LE(0x06064b50);
	record.writeBigUInt64LE(44n, 4);
	record.writeUInt16LE(45, 12);
	record.writeUInt16LE(45, 14);
	record.writeBigUInt64LE(BigInt(count), 24);
	record.writeBigUInt64LE(BigInt(count), 32);
	record.writeBigUInt64LE(BigInt(centralSize), 40);
	record.writeBigUInt64LE(BigInt(centralOffset), 48);
	const locator = Buffer.alloc(20);
	locator.writeUInt32LE(0x07064b50);
	locator.writeBigUInt64LE(BigInt(end), 8);
	locator.writeUInt32LE(1, 16);
	const ending = Buffer.from(zip.subarray(end));
	ending.writeUInt16LE(0xffff, 8);
	ending.writeUInt16LE(0xffff, 10);
	ending.writeUInt32LE(0xffffffff, 12);
	ending.writeUInt32LE(0xffffffff, 16);
	return Buffer.concat([zip.subarray(0, end), record, locator, ending]);
}
describe('build package acceptance', () => {
	it('accepts small ZIP64 without changing limits and rejects inconsistent 64-bit offsets', async () => {
		const bytes = zip64(makeZip([{ name: 'game', data: elf() }]));
		const path = await archive(bytes);
		expect((await validateBoundedZipFile(path, { profile: 'GAME' })).entryCount).toBe(1);
		await expect(
			validateBoundedZipFile(path, { profile: 'GAME', maxTotalUncompressedBytes: 100 }),
		).rejects.toThrow('total byte limit');
		bytes.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, bytes.length - 42 + 8);
		await writeFile(path, bytes);
		await expect(validateBoundedZipFile(path, { profile: 'GAME' })).rejects.toThrow('safe integer');
	});
	it('accepts per-entry ZIP64 extras and rejects local/central size disagreement', async () => {
		const extra = Buffer.alloc(20);
		extra.writeUInt16LE(1);
		extra.writeUInt16LE(16, 2);
		extra.writeBigUInt64LE(3n, 4);
		extra.writeBigUInt64LE(3n, 12);
		const bytes = makeZip([
			{
				name: 'game',
				data: 'abc',
				method: 0,
				declaredCompressedSize: 0xffffffff,
				declaredUncompressedSize: 0xffffffff,
				centralExtra: extra,
				localExtra: extra,
			},
		]);
		const path = await archive(bytes);
		expect((await validateBoundedZipFile(path, { profile: 'GAME' })).decodedBytes).toBe(3);
		bytes.writeBigUInt64LE(4n, 30 + 4 + 4);
		await writeFile(path, bytes);
		await expect(validateBoundedZipFile(path, { profile: 'GAME' })).rejects.toThrow('sizes disagree');
	});
	it('resolves framework links in memory and rejects cycles, escapes and web links', async () => {
		const link = (name: string, data: string) => ({ name, data, externalFileAttributes: 0o120777 * 0x10000 });
		const files = [
			{ name: 'App/Versions/A/runtime', data: elf() },
			link('App/Versions/Current', 'A'),
			link('App/runtime', 'Versions/Current/runtime'),
		];
		const path = await archive(makeZip(files));
		const summary = await validateBoundedZipFile(path, { profile: 'GAME' });
		expect(summary.entries[2]?.linkTarget).toBe('App/Versions/A/runtime');
		await expect(validateBoundedZipFile(path, { profile: 'WEBGL' })).rejects.toThrow('Symbolic links');
		await expect(
			validateBoundedZipFile(await archive(makeZip([link('a', 'b'), link('b', 'a')])), { profile: 'GAME' }),
		).rejects.toThrow('cycle');
		await expect(
			validateBoundedZipFile(await archive(makeZip([link('a', '../outside')])), { profile: 'GAME' }),
		).rejects.toThrow('escapes');
	});
	it('rejects media-only, fake APK and header-only executables', async () => {
		expect((await inspect([{ name: 'movie.mp4', data: 'video' }])).result.outcome).toBe('REJECT');
		await expect(
			inspect([
				{ name: 'movie.mp4', data: 'video' },
				{ name: 'game.apk', data: 'video' },
			]),
		).rejects.toThrow('ZIP magic');
		expect(
			(await inspect([{ name: 'game.exe', data: Buffer.from('MZ' + 'x'.repeat(300)) }])).result.outcome,
		).toBe('REJECT');
		expect(executableFormat(elf(), 120)).toBeNull();
	});
	it('reviews custom native executables and allows video, documentation and Korean paths', async () => {
		const { result } = await inspect([
			{ name: '게임 배포/game', data: elf() },
			{ name: '게임 배포/movie.mp4', data: Buffer.alloc(1024 * 1024) },
			{ name: '게임 배포/README.md', data: 'Read me' },
		]);
		expect(result.outcome).toBe('REVIEW');
		expect(result.evidence).toContain('ELF executable: 게임 배포/game');
	});
	it('reviews a renamed Canvas game, preserves deep wrappers and rejects missing required scripts', async () => {
		const files = [
			{
				name: 'one/two/게임/game.html',
				data: '<!doctype html><canvas></canvas><script src="play.mjs"></script>',
			},
			{
				name: 'one/two/게임/play.mjs',
				data: 'document.querySelector("canvas").getContext("2d").fillRect(1,1,10,10);',
			},
		];
		const { result, summary } = await inspect(files, 'WEBGL');
		expect(result.outcome).toBe('REVIEW');
		expect(result.entryPath).toBe(files[0]!.name);
		expect(analyzeWebglArchive(summary, result.entryPath!).entryPath).toBe('game.html');
		expect((await inspect([files[0]!], 'WEBGL')).result.outcome).toBe('REJECT');
		expect(
			(await inspect([{ name: 'index.html', data: '<p>Documentation</p>' }], 'WEBGL')).result.outcome,
		).toBe('REJECT');
	});
	it('keeps ambiguous HTML candidates and only permits an analyzed selection', async () => {
		const files = [
			{ name: 'a.html', data: '<canvas></canvas>' },
			{ name: 'b.html', data: '<canvas></canvas>' },
		];
		expect((await inspect(files, 'WEBGL')).result).toMatchObject({
			outcome: 'REVIEW',
			entryPath: null,
			entryCandidates: ['a.html', 'b.html'],
		});
		expect((await inspect(files, 'WEBGL', 'b.html')).result.entryPath).toBe('b.html');
		await expect(inspect(files, 'WEBGL', 'other.html')).rejects.toThrow('not an analyzed candidate');
	});
	it('validates inner container CRC/path safety and cumulative budgets', async () => {
		const payload = makeZip([{ name: 'script.rpy', data: 'label start:\n    return' }]);
		const { result } = await inspect([
			{ name: 'game', data: elf() },
			{ name: 'game.zip', data: payload },
		]);
		expect(result.outcome).toBe('REVIEW');
		await expect(
			inspect([
				{ name: 'game', data: elf() },
				{ name: 'game.zip', data: makeZip([{ name: '../escape', data: 'bad' }]) },
			]),
		).rejects.toThrow('unsafe');
		const archivePath = await archive(makeZip([{ name: 'game.zip', data: payload }]));
		const summary = await validateBoundedZipFile(archivePath, {
			profile: 'GAME',
			allowNestedArchivePath: isBuildContainer,
		});
		await expect(
			inspectBuildPackage({
				archivePath,
				summary,
				tempByteLimit: 1024 * 1024,
				maxTotalUncompressedBytes: summary.decodedBytes + 1,
			}),
		).rejects.toThrow('total byte limit');
	});
	it('charges nested ZIPs and HTTP-compressed scripts against the same expansion budget', async () => {
		const script = 'document.querySelector("canvas");' + ' '.repeat(1024);
		const nested = makeZip([{ name: 'readme.txt', data: 'internal payload' }]);
		const archivePath = await archive(
			makeZip([
				{ name: 'game.html', data: '<canvas></canvas><script src="game.js.gz"></script>' },
				{ name: 'game.js.gz', data: gzipSync(script) },
				{ name: 'game.zip', data: nested },
			]),
		);
		const summary = await validateBoundedZipFile(archivePath, {
			profile: 'WEBGL',
			allowNestedArchivePath: isBuildContainer,
		});
		await expect(
			inspectBuildPackage({
				archivePath,
				summary,
				tempByteLimit: 1024 * 1024,
				maxTotalUncompressedBytes: summary.decodedBytes + script.length,
			}),
		).rejects.toThrow('cumulative expansion budget');
	});
	it('resolves document-relative dynamic script sources separately from module-relative imports', async () => {
		const { result } = await inspect(
			[
				{ name: 'game.html', data: '<canvas></canvas><script src="scripts/start.js"></script>' },
				{
					name: 'scripts/start.js',
					data: 'const tag=document.createElement("script"); tag.src="runtime.js"; import "./module.js";',
				},
				{ name: 'runtime.js', data: 'window.run = true;' },
				{ name: 'scripts/module.js', data: 'export const ready=true;' },
			],
			'WEBGL',
		);
		expect(result.outcome).toBe('REVIEW');
		expect(result.reasons.some((r) => r.startsWith('missing:'))).toBe(false);
	});
	it.runIf(!!process.env['BUILD_REAL_UNITY_ZIP'])('accepts the pinned real Unity export', async () => {
		const archivePath = await archive(await readFile(process.env['BUILD_REAL_UNITY_ZIP']!));
		const summary = await validateBoundedZipFile(archivePath, {
			profile: 'WEBGL',
			allowNestedArchivePath: isBuildContainer,
		});
		const result = await inspectBuildPackage({ archivePath, summary, tempByteLimit: 10 * 1024 ** 3 });
		expect(result, result.reasons.join(',')).toMatchObject({ outcome: 'PASS', engines: ['Unity'] });
	});
});
