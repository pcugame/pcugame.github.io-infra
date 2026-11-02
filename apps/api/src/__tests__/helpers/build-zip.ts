import { deflateRawSync } from 'node:zlib';
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
	local.writeUInt16LE(entry.spec.flags ?? 0x800, 6);
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
	central.writeUInt16LE(entry.spec.versionMadeBy ?? (3 << 8) | 20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(entry.spec.flags ?? 0x800, 8);
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

export function makeZip(specs: ZipFixtureEntry[]): Buffer {
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

export function nativeElfFixture() {
	const bytes = Buffer.alloc(128);
	bytes.set([127, 69, 76, 70, 2, 1, 1]);
	bytes.writeUInt16LE(2, 16);
	bytes.writeUInt16LE(62, 18);
	bytes.writeUInt32LE(1, 20);
	bytes.writeBigUInt64LE(0x400078n, 24);
	bytes.writeBigUInt64LE(64n, 32);
	bytes.writeUInt16LE(64, 52);
	bytes.writeUInt16LE(56, 54);
	bytes.writeUInt16LE(1, 56);
	bytes.writeUInt32LE(1, 64);
	bytes.writeUInt32LE(5, 68);
	bytes.writeBigUInt64LE(0n, 72);
	bytes.writeBigUInt64LE(0x400000n, 80);
	bytes.writeBigUInt64LE(128n, 96);
	bytes.writeBigUInt64LE(128n, 104);
	bytes[120] = 0xc3;
	return bytes;
}
