import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
	validateBoundedZipFile,
	ZipValidationAbortedError,
} from '../modules/archive/bounded-zip-validator.js';

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

const CRC32_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) {
			value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	return table;
})();

function crc32(data: Buffer): number {
	let value = 0xffffffff;
	for (const byte of data) value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
	return (value ^ 0xffffffff) >>> 0;
}

function deterministicBytes(length: number): Buffer {
	const data = Buffer.allocUnsafe(length);
	let state = 0x9e3779b9;
	for (let index = 0; index < length; index += 1) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		data[index] = state & 0xff;
	}
	return data;
}

interface ZipFixtureEntry {
	name: string;
	data?: Buffer | string;
	method?: number;
	flags?: number;
	compressedData?: Buffer;
	declaredCompressedSize?: number;
	declaredUncompressedSize?: number;
	crc32?: number;
	versionMadeBy?: number;
	externalFileAttributes?: number;
	centralExtra?: Buffer;
	localExtra?: Buffer;
}

interface EncodedFixtureEntry {
	spec: ZipFixtureEntry;
	name: Buffer;
	data: Buffer;
	compressed: Buffer;
	compressedSize: number;
	uncompressedSize: number;
	crc: number;
	offset: number;
	local: Buffer;
}

function encodeLocal(entry: Omit<EncodedFixtureEntry, 'offset' | 'local'>): Buffer {
	const extra = entry.spec.localExtra ?? Buffer.alloc(0);
	const local = Buffer.alloc(30 + entry.name.length + extra.length + entry.compressed.length);
	local.writeUInt32LE(LOCAL_SIGNATURE, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(entry.spec.flags ?? 0, 6);
	local.writeUInt16LE(entry.spec.method ?? 8, 8);
	local.writeUInt32LE(entry.crc, 14);
	local.writeUInt32LE(entry.compressedSize, 18);
	local.writeUInt32LE(entry.uncompressedSize, 22);
	local.writeUInt16LE(entry.name.length, 26);
	local.writeUInt16LE(extra.length, 28);
	entry.name.copy(local, 30);
	extra.copy(local, 30 + entry.name.length);
	entry.compressed.copy(local, 30 + entry.name.length + extra.length);
	return local;
}

function encodeCentral(entry: EncodedFixtureEntry): Buffer {
	const extra = entry.spec.centralExtra ?? Buffer.alloc(0);
	const central = Buffer.alloc(46 + entry.name.length + extra.length);
	central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
	central.writeUInt16LE(entry.spec.versionMadeBy ?? ((3 << 8) | 20), 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(entry.spec.flags ?? 0, 8);
	central.writeUInt16LE(entry.spec.method ?? 8, 10);
	central.writeUInt32LE(entry.crc, 16);
	central.writeUInt32LE(entry.compressedSize, 20);
	central.writeUInt32LE(entry.uncompressedSize, 24);
	central.writeUInt16LE(entry.name.length, 28);
	central.writeUInt16LE(extra.length, 30);
	central.writeUInt32LE(entry.spec.externalFileAttributes ?? 0, 38);
	central.writeUInt32LE(entry.offset, 42);
	entry.name.copy(central, 46);
	extra.copy(central, 46 + entry.name.length);
	return central;
}

function encodedEntry(spec: ZipFixtureEntry, offset: number): EncodedFixtureEntry {
	const name = Buffer.from(spec.name, 'utf8');
	const data = Buffer.isBuffer(spec.data) ? spec.data : Buffer.from(spec.data ?? 'fixture');
	const method = spec.method ?? 8;
	const compressed = spec.compressedData ?? (method === 8 ? deflateRawSync(data) : data);
	const base = {
		spec,
		name,
		data,
		compressed,
		compressedSize: spec.declaredCompressedSize ?? compressed.length,
		uncompressedSize: spec.declaredUncompressedSize ?? data.length,
		crc: spec.crc32 ?? crc32(data),
	};
	return { ...base, offset, local: encodeLocal(base) };
}

function eocd(entryCount: number, centralOffset: number, centralSize: number): Buffer {
	const record = Buffer.alloc(22);
	record.writeUInt32LE(EOCD_SIGNATURE, 0);
	record.writeUInt16LE(entryCount, 8);
	record.writeUInt16LE(entryCount, 10);
	record.writeUInt32LE(centralSize, 12);
	record.writeUInt32LE(centralOffset, 16);
	return record;
}

function makeZip(specs: ZipFixtureEntry[]): Buffer {
	const entries: EncodedFixtureEntry[] = [];
	let offset = 0;
	for (const spec of specs) {
		const entry = encodedEntry(spec, offset);
		entries.push(entry);
		offset += entry.local.length;
	}
	const central = Buffer.concat(entries.map(encodeCentral));
	return Buffer.concat([
		...entries.map((entry) => entry.local),
		central,
		eocd(entries.length, offset, central.length),
	]);
}

function makeOverlappingZip(): Buffer {
	const inner = encodedEntry({ name: 'inside.txt', data: 'inside', method: 0 }, 0);
	const outerName = Buffer.from('outer.bin');
	const prefix = Buffer.from('x');
	const outerData = Buffer.concat([prefix, inner.local]);
	const outer = encodedEntry({ name: 'outer.bin', data: outerData, method: 0 }, 0);
	inner.offset = 30 + outerName.length + prefix.length;
	const central = Buffer.concat([encodeCentral(outer), encodeCentral(inner)]);
	return Buffer.concat([outer.local, central, eocd(2, outer.local.length, central.length)]);
}

const directories: string[] = [];

async function writeArchive(contents: Buffer, name = 'fixture.zip'): Promise<{ dir: string; path: string }> {
	const dir = await fsp.mkdtemp(join(tmpdir(), 'pcu-bounded-zip-'));
	directories.push(dir);
	const path = join(dir, name);
	await fsp.writeFile(path, contents);
	return { dir, path };
}

async function descriptorCountFor(path: string): Promise<number | null> {
	try {
		const names = await fsp.readdir('/proc/self/fd');
		const links = await Promise.all(names.map(async (name) => {
			try { return await fsp.readlink(`/proc/self/fd/${name}`); } catch { return ''; }
		}));
		return links.filter((link) => link === path).length;
	} catch {
		return null;
	}
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe('bounded ZIP validator', () => {
	it('fully decodes normal stored/deflated entries into a counting sink', async () => {
		const { path } = await writeArchive(makeZip([
			{ name: 'game.exe', data: 'executable', method: 0 },
			{ name: 'assets/data.bin', data: deterministicBytes(16_384), method: 8 },
			{ name: 'empty/', data: Buffer.alloc(0), method: 0, externalFileAttributes: 0x10 },
		]));
		const result = await validateBoundedZipFile(path, { profile: 'GAME' });
		expect(result.entryCount).toBe(3);
		expect(result.decodedBytes).toBe(16_394);
		expect(result.decodedBytes).toBe(result.declaredUncompressedBytes);
		expect(result.entries.map((entry) => entry.path)).toEqual([
			'game.exe', 'assets/data.bin', 'empty/',
		]);
	});

	it('rejects invalid magic and ZIP64 markers before decoding', async () => {
		const invalid = await writeArchive(Buffer.from('not-a-zip'), 'invalid.zip');
		await expect(validateBoundedZipFile(invalid.path, { profile: 'GAME' }))
			.rejects.toThrow('magic bytes');

		const zip64 = makeZip([{ name: 'game.exe', data: 'x' }]);
		zip64.writeUInt16LE(0xffff, zip64.length - 22 + 8);
		zip64.writeUInt16LE(0xffff, zip64.length - 22 + 10);
		const marked = await writeArchive(zip64, 'zip64.zip');
		await expect(validateBoundedZipFile(marked.path, { profile: 'GAME' }))
			.rejects.toThrow('ZIP64');
	});

	it('detects CRC32 mismatch after a successful full decode', async () => {
		const data = Buffer.from('CRC must cover actual decoded bytes');
		const { path } = await writeArchive(makeZip([{
			name: 'game.exe',
			data,
			crc32: (crc32(data) ^ 1) >>> 0,
		}]));
		await expect(validateBoundedZipFile(path, { profile: 'GAME' }))
			.rejects.toThrow('CRC32 mismatch');
	});

	it('classifies corrupt deflate as deterministic validation failure', async () => {
		const { path } = await writeArchive(makeZip([{
			name: 'game.exe',
			data: Buffer.alloc(32, 0x41),
			compressedData: Buffer.from([0xff, 0xff, 0xff]),
		}]));
		await expect(validateBoundedZipFile(path, { profile: 'GAME' }))
			.rejects.toThrow(/corrupt|decoded size|fully decoded/i);
	});

	it('enforces declared and actual expansion/ratio limits', async () => {
		const declared = await writeArchive(makeZip([{
			name: 'bomb.bin',
			data: Buffer.alloc(8_192),
		}]), 'declared-bomb.zip');
		await expect(validateBoundedZipFile(declared.path, {
			profile: 'GAME',
			maxCompressionRatio: 2,
		})).rejects.toThrow('declared compression ratio');

		const dishonest = await writeArchive(makeZip([{
			name: 'dishonest.bin',
			data: Buffer.alloc(8_192),
			declaredUncompressedSize: 1,
		}]), 'actual-bomb.zip');
		await expect(validateBoundedZipFile(dishonest.path, {
			profile: 'GAME',
			maxCompressionRatio: 2,
		})).rejects.toThrow(/actual expansion|actual compression ratio/);
	});

	it.each([
		'../escape.txt',
		'/absolute.txt',
		'C:\\absolute.txt',
		'safe/../../escape.txt',
	])('rejects unsafe path %s', async (name) => {
		const { path } = await writeArchive(makeZip([{ name, data: 'x' }]));
		await expect(validateBoundedZipFile(path, { profile: 'GAME' }))
			.rejects.toThrow(/unsafe|absolute/);
	});

	it('rejects symbolic links and unsupported Unix filesystem entries', async () => {
		const symlink = await writeArchive(makeZip([{
			name: 'link',
			data: 'target',
			versionMadeBy: (3 << 8) | 20,
			externalFileAttributes: 0o120777 * 0x10000,
		}]), 'symlink.zip');
		await expect(validateBoundedZipFile(symlink.path, { profile: 'GAME' }))
			.rejects.toThrow('Symbolic links');

		const socket = await writeArchive(makeZip([{
			name: 'socket',
			data: '',
			versionMadeBy: (3 << 8) | 20,
			externalFileAttributes: 0o140777 * 0x10000,
		}]), 'socket.zip');
		await expect(validateBoundedZipFile(socket.path, { profile: 'GAME' }))
			.rejects.toThrow('unsupported filesystem entry');
	});

	it('injects GAME/WebGL nested archive policy without weakening tar.gz rejection', async () => {
		const gzipResource = await writeArchive(makeZip([{
			name: 'Build/game.data.gz', data: 'pre-compressed-unity-resource', method: 0,
		}]), 'resource.zip');
		await expect(validateBoundedZipFile(gzipResource.path, { profile: 'GAME' }))
			.rejects.toThrow('Nested archives');
		await expect(validateBoundedZipFile(gzipResource.path, { profile: 'WEBGL' }))
			.resolves.toMatchObject({ entryCount: 1 });

		const nested = await writeArchive(makeZip([{
			name: 'Build/payload.tar.gz', data: 'nested', method: 0,
		}]), 'nested.zip');
		await expect(validateBoundedZipFile(nested.path, { profile: 'WEBGL' }))
			.rejects.toThrow('Nested archives');
	});

	it('rejects encrypted entries and unsupported compression methods', async () => {
		const encrypted = await writeArchive(makeZip([{
			name: 'game.exe', data: 'x', flags: 1,
		}]), 'encrypted.zip');
		await expect(validateBoundedZipFile(encrypted.path, { profile: 'GAME' }))
			.rejects.toThrow('Encrypted');

		const unsupported = await writeArchive(makeZip([{
			name: 'game.exe', data: 'x', method: 12,
		}]), 'unsupported.zip');
		await expect(validateBoundedZipFile(unsupported.path, { profile: 'GAME' }))
			.rejects.toThrow('unsupported compression method');
	});

	it('rejects overlapping local entry ranges', async () => {
		const { path } = await writeArchive(makeOverlappingZip());
		await expect(validateBoundedZipFile(path, { profile: 'GAME' }))
			.rejects.toThrow('overlap');
	});

	it('honors AbortSignal before and during validation without descriptor or temp residue', async () => {
		const fixture = await writeArchive(makeZip([{
			name: 'game.exe', data: Buffer.alloc(1024 * 1024), method: 0,
		}]));
		const preAborted = new AbortController();
		preAborted.abort(new Error('test cancellation'));
		await expect(validateBoundedZipFile(fixture.path, {
			profile: 'GAME', signal: preAborted.signal,
		})).rejects.toBeInstanceOf(ZipValidationAbortedError);

		const duringValidation = new AbortController();
		const result = expect(validateBoundedZipFile(fixture.path, {
			profile: 'GAME', signal: duringValidation.signal,
		})).rejects.toBeInstanceOf(ZipValidationAbortedError);
		await new Promise<void>((resolve) => { setImmediate(resolve); });
		duringValidation.abort(new Error('in-flight cancellation'));
		await result;
		expect(await fsp.readdir(fixture.dir)).toEqual(['fixture.zip']);
		expect([0, null]).toContain(await descriptorCountFor(fixture.path));
	});

	it('closes the archive descriptor after success and deterministic failure', async () => {
		const valid = await writeArchive(makeZip([{ name: 'game.exe', data: 'ok' }]), 'valid.zip');
		const invalid = await writeArchive(makeZip([{
			name: '../escape', data: 'bad',
		}]), 'invalid.zip');
		await validateBoundedZipFile(valid.path, { profile: 'GAME' });
		await expect(validateBoundedZipFile(invalid.path, { profile: 'GAME' })).rejects.toThrow();
		expect([0, null]).toContain(await descriptorCountFor(valid.path));
		expect([0, null]).toContain(await descriptorCountFor(invalid.path));
		expect(await fsp.readdir(valid.dir)).toEqual(['valid.zip']);
		expect(await fsp.readdir(invalid.dir)).toEqual(['invalid.zip']);
	});
});
