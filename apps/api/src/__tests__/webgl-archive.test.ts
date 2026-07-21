import { afterEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeWebglArchive } from '../modules/webgl/archive.js';
import { webglContentMetadata, webglContentSecurityPolicy } from '../modules/webgl/content.js';
import { createWebglDeploymentKeys, parseWebglEntryKey, parseWebglSourceKey } from '../modules/webgl/paths.js';
import { validateWebglZipArchiveFile } from '../modules/assets/upload/zip-validation.js';

type ZipEntrySpec = {
	name: string;
	flags?: number;
	compressionMethod?: number;
	compressedSize?: number;
	uncompressedSize?: number;
	versionMadeBy?: number;
	externalFileAttributes?: number;
};

function makeZip(entries: ZipEntrySpec[]): Buffer {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name);
		const compressedSize = entry.compressedSize ?? 0;
		const uncompressedSize = entry.uncompressedSize ?? compressedSize;
		const local = Buffer.alloc(30 + name.length + compressedSize);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(entry.flags ?? 0, 6);
		local.writeUInt16LE(entry.compressionMethod ?? 0, 8);
		local.writeUInt32LE(compressedSize, 18);
		local.writeUInt32LE(uncompressedSize, 22);
		local.writeUInt16LE(name.length, 26);
		name.copy(local, 30);
		localParts.push(local);

		const central = Buffer.alloc(46 + name.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(entry.versionMadeBy ?? 20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(entry.flags ?? 0, 8);
		central.writeUInt16LE(entry.compressionMethod ?? 0, 10);
		central.writeUInt32LE(compressedSize, 20);
		central.writeUInt32LE(uncompressedSize, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(entry.externalFileAttributes ?? 0, 38);
		central.writeUInt32LE(offset, 42);
		name.copy(central, 46);
		centralParts.push(central);
		offset += local.length;
	}
	const centralDirectory = Buffer.concat(centralParts);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralDirectory.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...localParts, centralDirectory, eocd]);
}

const dirs: string[] = [];
async function archive(entries: ZipEntrySpec[]): Promise<string> {
	const dir = await fsp.mkdtemp(join(tmpdir(), 'pcu-webgl-test-'));
	dirs.push(dir);
	const file = join(dir, 'build.zip');
	await fsp.writeFile(file, makeZip(entries));
	return file;
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe('WebGL ZIP validation', () => {
	it('accepts a root build and preserves Brotli/Gzip resource paths', async () => {
		const summary = await validateWebglZipArchiveFile(await archive([
			{ name: 'index.html' },
			{ name: 'Build/game.wasm.br' },
			{ name: 'Build/game.data.gz' },
		]));
		const layout = analyzeWebglArchive(summary);
		expect(layout.wrapperPrefix).toBe('');
		expect([...layout.files.values()]).toEqual([
			'index.html',
			'Build/game.wasm.br',
			'Build/game.data.gz',
		]);
	});

	it('accepts exactly one wrapper directory and strips it for hosting', async () => {
		const summary = await validateWebglZipArchiveFile(await archive([
			{ name: 'MyBuild/index.html' },
			{ name: 'MyBuild/TemplateData/style.css' },
		]));
		const layout = analyzeWebglArchive(summary);
		expect(layout.wrapperPrefix).toBe('MyBuild/');
		expect([...layout.files.values()]).toEqual(['index.html', 'TemplateData/style.css']);
	});

	it.each([
		{ name: 'missing index', entries: [{ name: 'Build/game.wasm' }], message: 'must contain index.html' },
		{ name: 'multiple indexes', entries: [{ name: 'index.html' }, { name: 'nested/index.html' }], message: 'exactly one' },
		{ name: 'deep index', entries: [{ name: 'one/two/index.html' }], message: 'one wrapper folder' },
		{ name: 'outside wrapper', entries: [{ name: 'build/index.html' }, { name: 'loose.js' }], message: 'single wrapper folder' },
	])('rejects $name', async ({ entries, message }) => {
		const summary = await validateWebglZipArchiveFile(await archive(entries));
		expect(() => analyzeWebglArchive(summary)).toThrow(message);
	});

	it('rejects traversal, encryption, compression bombs, and symbolic links', async () => {
		await expect(validateWebglZipArchiveFile(await archive([
			{ name: '../index.html' },
		]))).rejects.toThrow('unsafe file path');
		await expect(validateWebglZipArchiveFile(await archive([
			{ name: 'index.html', flags: 1 },
		]))).rejects.toThrow('Encrypted');
		await expect(validateWebglZipArchiveFile(await archive([
			{ name: 'index.html' },
			{ name: 'Build/bomb.data', compressedSize: 1, uncompressedSize: 101 },
		]))).rejects.toThrow('compression ratio');

		const symlink = await validateWebglZipArchiveFile(await archive([
			{ name: 'index.html' },
			{
				name: 'Build/link',
				versionMadeBy: (3 << 8) | 20,
				externalFileAttributes: 0o120777 * 0x10000,
			},
		]));
		expect(() => analyzeWebglArchive(symlink)).toThrow('Symbolic links');
	});
});

describe('WebGL paths and response metadata', () => {
	it('uses one deployment ID for protected source and public site keys', () => {
		const keys = createWebglDeploymentKeys(42, '123e4567-e89b-42d3-a456-426614174000');
		expect(keys.sourceKey).toBe('webgl/42/123e4567-e89b-42d3-a456-426614174000/source.zip');
		expect(keys.entryKey).toBe('webgl/42/123e4567-e89b-42d3-a456-426614174000/site/index.html');
		expect(parseWebglEntryKey(42, keys.entryKey)).toEqual(keys);
		expect(parseWebglSourceKey(42, keys.sourceKey)).toEqual(keys);
		expect(parseWebglEntryKey(7, keys.entryKey)).toBeNull();
	});

	it.each([
		['Build/game.wasm.br', 'application/wasm', 'br'],
		['Build/game.data.gz', 'application/octet-stream', 'gzip'],
		['TemplateData/logo.webp', 'image/webp', undefined],
		['index.html', 'text/html; charset=utf-8', undefined],
	])('maps %s to MIME and encoding', (name, contentType, contentEncoding) => {
		expect(webglContentMetadata(name)).toMatchObject({ contentType, contentEncoding });
	});

	it('limits iframe ancestors to the configured frontend origin', () => {
		const csp = webglContentSecurityPolicy(
			'https://pcugame.github.io/site/path',
			'https://api.example.com/base',
		);
		expect(csp).toContain('frame-ancestors https://pcugame.github.io');
		expect(csp).toContain('script-src https://api.example.com/api/public/webgl/');
		expect(csp).toContain('connect-src https://api.example.com/api/public/webgl/');
		expect(csp).toContain("frame-src 'none'");
		expect(csp).not.toContain("script-src 'self'");
		expect(csp).not.toContain('frame-ancestors *');
	});
});
