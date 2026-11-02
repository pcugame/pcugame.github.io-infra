import { ZipValidationError, ZipValidationAbortedError } from '../../shared/archive-errors.js';
export { ZipValidationError, ZipValidationAbortedError } from '../../shared/archive-errors.js';
import { open, type FileHandle } from 'node:fs/promises';
import { posix as pathPosix, win32 as pathWin32 } from 'node:path';
import yauzl, {
	getFileNameLowLevel,
	parseExtraFields,
	type Entry,
	type ZipFile,
} from 'yauzl';

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP64_EXTRA_FIELD_ID = 0x0001;

const DATA_DESCRIPTOR_FLAG = 0x0008;
const ENCRYPTION_FLAGS = 0x2041;

const UNIX_HOST = 3;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;
const UNIX_SYMLINK = 0o120000;

const MAX_EOCD_SEARCH_BYTES = 65_557;
const ARCHIVE_EXTENSION = /\.(?:zip|7z|rar|tar|gz|tgz|bz2|xz|apk|jar|war|ear|iso)$/i;
const WEBGL_GZIP_RESOURCE = /\.(?:js|mjs|wasm|data|json|symbols|unityweb)\.gz$/i;

export type ZipValidationProfile = 'GAME' | 'WEBGL';

export interface BoundedZipValidationOptions {
	profile: ZipValidationProfile;
	signal?: AbortSignal;
	maxArchiveBytes?: number;
	maxEntries?: number;
	maxCentralDirectoryBytes?: number;
	maxEntryUncompressedBytes?: number;
	maxTotalUncompressedBytes?: number;
	/** Additional nested-looking paths that a specific worker knows are inert resources. */
	allowNestedArchivePath?: (path: string) => boolean;
}

export interface ValidatedZipEntry {
	path: string;
	compressedBytes: number;
	declaredUncompressedBytes: number;
	decodedBytes: number;
	crc32: number;
	compressionMethod: 0 | 8;
	isDirectory: boolean;
	/** Resolved archive path; never a host filesystem link. */
	linkTarget?: string;
}

export interface BoundedZipValidationSummary {
	profile: ZipValidationProfile;
	archiveBytes: number;
	entryCount: number;
	declaredUncompressedBytes: number;
	decodedBytes: number;
	entries: ValidatedZipEntry[];
}

interface EffectivePolicy {
	profile: ZipValidationProfile;
	maxArchiveBytes: number;
	maxEntries: number;
	maxCentralDirectoryBytes: number;
	maxEntryUncompressedBytes: number;
	maxTotalUncompressedBytes: number;
	allowNestedArchivePath(path: string): boolean;
}

interface EndOfCentralDirectory {
	entryCount: number;
	centralDirectoryOffset: number;
	centralDirectorySize: number;
}

interface StructuralEntry {
	zip64: boolean;
	linkTarget?: string;
	path: string;
	fileNameRaw: Buffer;
	flags: number;
	compressionMethod: 0 | 8;
	crc32: number;
	compressedSize: number;
	uncompressedSize: number;
	versionMadeBy: number;
	externalFileAttributes: number;
	localHeaderOffset: number;
	isDirectory: boolean;
	dataStart: number;
	dataEnd: number;
	structureEnd: number;
}

interface StructuralSummary {
	entries: StructuralEntry[];
	declaredUncompressedBytes: number;
}

const DEFAULTS = {
	maxArchiveBytes: 10 * 1024 * 1024 * 1024,
	maxEntries: 10_000,
	maxCentralDirectoryBytes: 64 * 1024 * 1024,
	maxEntryUncompressedBytes: 4 * 1024 * 1024 * 1024,
	maxTotalUncompressedBytes: 10 * 1024 * 1024 * 1024,
} as const;

function positiveSafeInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new RangeError(`${name} must be a positive safe integer`);
	}
	return value;
}

function policyFrom(options: BoundedZipValidationOptions): EffectivePolicy {
	const allowProfileResource = options.profile === 'WEBGL'
		? (path: string) => WEBGL_GZIP_RESOURCE.test(path)
		: () => false;
	return {
		profile: options.profile,
		maxArchiveBytes: positiveSafeInteger(
			options.maxArchiveBytes ?? DEFAULTS.maxArchiveBytes,
			'maxArchiveBytes',
		),
		maxEntries: positiveSafeInteger(options.maxEntries ?? DEFAULTS.maxEntries, 'maxEntries'),
		maxCentralDirectoryBytes: positiveSafeInteger(
			options.maxCentralDirectoryBytes ?? DEFAULTS.maxCentralDirectoryBytes,
			'maxCentralDirectoryBytes',
		),
		maxEntryUncompressedBytes: positiveSafeInteger(
			options.maxEntryUncompressedBytes ?? DEFAULTS.maxEntryUncompressedBytes,
			'maxEntryUncompressedBytes',
		),
		maxTotalUncompressedBytes: positiveSafeInteger(
			options.maxTotalUncompressedBytes ?? DEFAULTS.maxTotalUncompressedBytes,
			'maxTotalUncompressedBytes',
		),
		allowNestedArchivePath: (path) => (
			allowProfileResource(path) || options.allowNestedArchivePath?.(path) === true
		),
	};
}

function abortError(signal?: AbortSignal): ZipValidationAbortedError {
	return new ZipValidationAbortedError({ cause: signal?.reason });
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError(signal);
}

async function readExact(handle: FileHandle, position: number, length: number): Promise<Buffer> {
	if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0) {
		throw new ZipValidationError('ZIP archive contains an invalid byte range');
	}
	const buffer = Buffer.allocUnsafe(length);
	let offset = 0;
	while (offset < length) {
		const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
		if (bytesRead === 0) throw new ZipValidationError('ZIP archive is truncated');
		offset += bytesRead;
	}
	return buffer;
}

async function findEndOfCentralDirectory(
	handle: FileHandle,
	archiveBytes: number,
	policy: EffectivePolicy,
): Promise<EndOfCentralDirectory> {
	if (archiveBytes < 22) throw new ZipValidationError('ZIP archive is too small');
	const tailLength = Math.min(archiveBytes, MAX_EOCD_SEARCH_BYTES);
	const tailOffset = archiveBytes - tailLength;
	const tail = await readExact(handle, tailOffset, tailLength);

	for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
		if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
		const commentLength = tail.readUInt16LE(offset + 20);
		if (offset + 22 + commentLength !== tail.length) continue;

		const diskNumber = tail.readUInt16LE(offset + 4);
		const centralDirectoryDisk = tail.readUInt16LE(offset + 6);
		let entriesOnDisk = tail.readUInt16LE(offset + 8);
		let entryCount = tail.readUInt16LE(offset + 10);
		let centralDirectorySize = tail.readUInt32LE(offset + 12);
		let centralDirectoryOffset = tail.readUInt32LE(offset + 16);
		let directoryBoundary = tailOffset + offset;
		const locatorOffset = directoryBoundary - 20;
		const locator = locatorOffset >= 0 ? await readExact(handle, locatorOffset, 20) : Buffer.alloc(0);
		const hasZip64 = locator.length === 20 && locator.readUInt32LE(0) === 0x07064b50;
		if (hasZip64) {
			if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) {
				throw new ZipValidationError('Split ZIP64 archives are not supported');
			}
			const recordOffset = safeUint64(locator, 8);
			if (recordOffset + 56 > locatorOffset) throw new ZipValidationError('ZIP64 record is outside archive bounds');
			const record = await readExact(handle, recordOffset, 56);
			const recordSize = safeUint64(record, 4);
			if (record.readUInt32LE(0) !== 0x06064b50 || recordSize < 44
				|| recordOffset + 12 + recordSize !== locatorOffset
				|| record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0) {
				throw new ZipValidationError('ZIP64 end record is malformed');
			}
			const count = safeUint64(record, 32);
			const size = safeUint64(record, 40);
			const start = safeUint64(record, 48);
			if (safeUint64(record, 24) !== count
				|| (entriesOnDisk !== 0xffff && entriesOnDisk !== count)
				|| (entryCount !== 0xffff && entryCount !== count)
				|| (centralDirectorySize !== 0xffffffff && centralDirectorySize !== size)
				|| (centralDirectoryOffset !== 0xffffffff && centralDirectoryOffset !== start)) {
				throw new ZipValidationError('ZIP64 end records disagree');
			}
			entriesOnDisk = entryCount = count;
			centralDirectorySize = size;
			centralDirectoryOffset = start;
			directoryBoundary = recordOffset;
		} else if (entriesOnDisk === 0xffff || entryCount === 0xffff
			|| centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
			throw new ZipValidationError('ZIP64 locator is missing');
		}
		if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
			throw new ZipValidationError('Split ZIP archives are not supported');
		}
		if (entryCount < 1) throw new ZipValidationError('ZIP archive is empty');
		if (entryCount > policy.maxEntries) throw new ZipValidationError('ZIP archive has too many entries');
		if (centralDirectorySize < entryCount * 46
			|| centralDirectorySize > policy.maxCentralDirectoryBytes) {
			throw new ZipValidationError('ZIP archive central directory size is outside policy');
		}
		const eocdOffset = directoryBoundary;
		const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
		if (!Number.isSafeInteger(centralDirectoryEnd)
			|| centralDirectoryEnd > eocdOffset
			|| centralDirectoryEnd > archiveBytes) {
			throw new ZipValidationError('ZIP archive central directory is outside archive bounds');
		}
		return {
			entryCount,
			centralDirectoryOffset,
			centralDirectorySize,
		};
	}
	throw new ZipValidationError('ZIP end of central directory was not found');
}

function isUnsafePath(path: string): boolean {
	if (!path || path.includes('\0')) return true;
	if (path.startsWith('/') || path.startsWith('\\')) return true;
	if (/^[a-zA-Z]:/.test(path) || pathWin32.isAbsolute(path)) return true;
	const segments = path.replace(/\\/g, '/').split('/');
	if (segments.some((segment) => segment === '.' || segment === '..')) return true;
	const normalized = pathPosix.normalize(segments.join('/'));
	return normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/');
}

function normalizedPath(path: string): string {
	return pathPosix.normalize(path.replace(/\\/g, '/')).replace(/^\.\//, '');
}

function unixFileType(entry: Pick<StructuralEntry, 'versionMadeBy' | 'externalFileAttributes'>): number {
	if (((entry.versionMadeBy >>> 8) & 0xff) !== UNIX_HOST) return 0;
	return (entry.externalFileAttributes >>> 16) & UNIX_FILE_TYPE_MASK;
}

function assertFilesystemType(entry: Pick<StructuralEntry,
	'versionMadeBy' | 'externalFileAttributes' | 'isDirectory'>): void {
	const type = unixFileType(entry);
	if (type === UNIX_SYMLINK) return;
	if (type !== 0 && type !== UNIX_REGULAR_FILE && type !== UNIX_DIRECTORY) {
		throw new ZipValidationError('ZIP archive contains an unsupported filesystem entry');
	}
}

function assertDeclaredBounds(entry: StructuralEntry, policy: EffectivePolicy): void {
	if (entry.uncompressedSize > policy.maxEntryUncompressedBytes) {
		throw new ZipValidationError('ZIP entry expands beyond the per-entry byte limit');
	}
	if (entry.compressedSize === 0 && entry.uncompressedSize > 0) {
		throw new ZipValidationError('ZIP entry declares expanded bytes without compressed data');
	}
}

function decodeFileName(flags: number, fileNameRaw: Buffer, extraRaw: Buffer): string {
	try {
		return getFileNameLowLevel(
			flags,
			fileNameRaw,
			parseExtraFields(extraRaw),
			true,
		);
	} catch (error) {
		throw new ZipValidationError('ZIP entry filename is invalid', { cause: error });
	}
}

function safeUint64(buffer: Buffer, offset: number): number {
	if (offset + 8 > buffer.length) throw new ZipValidationError('ZIP64 field is truncated');
	const value = buffer.readBigUInt64LE(offset);
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipValidationError('ZIP64 byte range exceeds safe integer bounds');
	return Number(value);
}

function zip64Fields(extraRaw: Buffer, values: number[]): { values: number[]; present: boolean } {
	let fields;
	try { fields = parseExtraFields(extraRaw).filter(field => field.id === ZIP64_EXTRA_FIELD_ID); }
	catch (error) { throw new ZipValidationError('ZIP extra field is malformed', { cause: error }); }
	if (fields.length > 1) throw new ZipValidationError('Duplicate ZIP64 extra fields');
	const data = fields[0]?.data;
	let offset = 0;
	return { present: !!data, values: values.map(value => {
		if (value !== 0xffffffff) return value;
		if (!data) throw new ZipValidationError('ZIP64 extra field is missing');
		const result = safeUint64(data, offset);
		offset += 8;
		return result;
	}) };
}

function parseCentralDirectory(
	buffer: Buffer,
	eocd: EndOfCentralDirectory,
	policy: EffectivePolicy,
): StructuralSummary {
	const entries: StructuralEntry[] = [];
	const paths = new Set<string>();
	let offset = 0;
	let declaredUncompressedBytes = 0;

	while (offset < buffer.length) {
		if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
			throw new ZipValidationError('ZIP central directory is malformed');
		}
		const versionMadeBy = buffer.readUInt16LE(offset + 4);
		const flags = buffer.readUInt16LE(offset + 8);
		const rawMethod = buffer.readUInt16LE(offset + 10);
		const crc32 = buffer.readUInt32LE(offset + 16);
		let compressedSize = buffer.readUInt32LE(offset + 20);
		let uncompressedSize = buffer.readUInt32LE(offset + 24);
		const fileNameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const diskStart = buffer.readUInt16LE(offset + 34);
		const externalFileAttributes = buffer.readUInt32LE(offset + 38);
		let localHeaderOffset = buffer.readUInt32LE(offset + 42);
		const nameStart = offset + 46;
		const nameEnd = nameStart + fileNameLength;
		const extraEnd = nameEnd + extraLength;
		const nextOffset = extraEnd + commentLength;
		if (nextOffset > buffer.length) throw new ZipValidationError('ZIP central directory is truncated');
		if (diskStart !== 0) throw new ZipValidationError('Split ZIP entries are not supported');
		if ((flags & ENCRYPTION_FLAGS) !== 0 || rawMethod === 99) {
			throw new ZipValidationError('Encrypted ZIP entries are not allowed');
		}
		if (rawMethod !== 0 && rawMethod !== 8) {
			throw new ZipValidationError('ZIP entry uses an unsupported compression method');
		}
		const fileNameRaw = Buffer.from(buffer.subarray(nameStart, nameEnd));
		const extraRaw = Buffer.from(buffer.subarray(nameEnd, extraEnd));
		const zip64 = zip64Fields(extraRaw, [uncompressedSize, compressedSize, localHeaderOffset]);
		[uncompressedSize, compressedSize, localHeaderOffset] = zip64.values as [number, number, number];
		const decoded = decodeFileName(flags, fileNameRaw, extraRaw);
		if (isUnsafePath(decoded)) throw new ZipValidationError('ZIP entry has an unsafe or absolute path');
		const path = normalizedPath(decoded);
		if (paths.has(path)) throw new ZipValidationError('ZIP archive contains duplicate entry paths');
		paths.add(path);
		if (ARCHIVE_EXTENSION.test(path) && !policy.allowNestedArchivePath(path)) {
			throw new ZipValidationError('Nested archives are not allowed by ZIP policy');
		}
		const fileType = ((versionMadeBy >>> 8) & 0xff) === UNIX_HOST
			? (externalFileAttributes >>> 16) & UNIX_FILE_TYPE_MASK
			: 0;
		const isDirectory = path.endsWith('/')
			|| (externalFileAttributes & 0x10) !== 0
			|| fileType === UNIX_DIRECTORY;
		const entry: StructuralEntry = {
			zip64: zip64.present,
			path,
			fileNameRaw,
			flags,
			compressionMethod: rawMethod,
			crc32,
			compressedSize,
			uncompressedSize,
			versionMadeBy,
			externalFileAttributes,
			localHeaderOffset,
			isDirectory,
			dataStart: 0,
			dataEnd: 0,
			structureEnd: 0,
		};
		assertFilesystemType(entry);
		if (unixFileType(entry) === UNIX_SYMLINK && (policy.profile === 'WEBGL' || uncompressedSize > 4096 || isDirectory)) {
			throw new ZipValidationError('Symbolic links are not allowed in web archives or exceed link bounds');
		}
		if (isDirectory && (compressedSize !== 0 || uncompressedSize !== 0)) {
			throw new ZipValidationError('ZIP directory entry contains file data');
		}
		assertDeclaredBounds(entry, policy);
		declaredUncompressedBytes += uncompressedSize;
		if (!Number.isSafeInteger(declaredUncompressedBytes)
			|| declaredUncompressedBytes > policy.maxTotalUncompressedBytes) {
			throw new ZipValidationError('ZIP archive declared expansion exceeds the total byte limit');
		}
		entries.push(entry);
		offset = nextOffset;
	}
	if (entries.length !== eocd.entryCount) throw new ZipValidationError('ZIP entry count is inconsistent');
	return { entries, declaredUncompressedBytes };
}

function descriptorLength(buffer: Buffer, entry: StructuralEntry, boundary: number): number | null {
	for (const prefix of [0, 4]) {
		if (prefix === 4 && buffer.readUInt32LE(0) !== DATA_DESCRIPTOR_SIGNATURE) continue;
		const length = prefix + (entry.zip64 ? 20 : 12);
		if (buffer.length < length || entry.dataEnd + length > boundary) continue;
		const compressed = entry.zip64 ? safeUint64(buffer, prefix + 4) : buffer.readUInt32LE(prefix + 4);
		const uncompressed = entry.zip64 ? safeUint64(buffer, prefix + 12) : buffer.readUInt32LE(prefix + 8);
		if (buffer.readUInt32LE(prefix) === entry.crc32 && compressed === entry.compressedSize
			&& uncompressed === entry.uncompressedSize) return length;
	}
	return null;
}

async function validateLocalHeaders(
	handle: FileHandle,
	entries: StructuralEntry[],
	eocd: EndOfCentralDirectory,
	signal?: AbortSignal,
): Promise<void> {
	for (const entry of entries) {
		throwIfAborted(signal);
		if (entry.localHeaderOffset + 30 > eocd.centralDirectoryOffset) {
			throw new ZipValidationError('ZIP local header is outside archive data bounds');
		}
		const fixed = await readExact(handle, entry.localHeaderOffset, 30);
		if (fixed.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE) {
			throw new ZipValidationError('ZIP local file header signature is invalid');
		}
		const flags = fixed.readUInt16LE(6);
		const method = fixed.readUInt16LE(8);
		const localCrc32 = fixed.readUInt32LE(14);
		let localCompressedSize = fixed.readUInt32LE(18);
		let localUncompressedSize = fixed.readUInt32LE(22);
		const fileNameLength = fixed.readUInt16LE(26);
		const extraLength = fixed.readUInt16LE(28);
		if (flags !== entry.flags || method !== entry.compressionMethod) {
			throw new ZipValidationError('ZIP local header disagrees with the central directory');
		}
		const variable = await readExact(
			handle,
			entry.localHeaderOffset + 30,
			fileNameLength + extraLength,
		);
		const localName = variable.subarray(0, fileNameLength);
		const localExtra = variable.subarray(fileNameLength);
		if (!localName.equals(entry.fileNameRaw)) {
			throw new ZipValidationError('ZIP local filename disagrees with the central directory');
		}
		const local64 = zip64Fields(localExtra, [localUncompressedSize, localCompressedSize]);
		[localUncompressedSize, localCompressedSize] = local64.values as [number, number];
		entry.zip64 ||= local64.present;
		const usesDescriptor = (flags & DATA_DESCRIPTOR_FLAG) !== 0;
		if (!usesDescriptor && (
			localCrc32 !== entry.crc32
			|| localCompressedSize !== entry.compressedSize
			|| localUncompressedSize !== entry.uncompressedSize
		)) {
			throw new ZipValidationError('ZIP local checksum or sizes disagree with the central directory');
		}
		if (usesDescriptor && (
			(localCrc32 !== 0 && localCrc32 !== entry.crc32)
			|| (localCompressedSize !== 0 && localCompressedSize !== entry.compressedSize)
			|| (localUncompressedSize !== 0 && localUncompressedSize !== entry.uncompressedSize)
		)) {
			throw new ZipValidationError('ZIP local descriptor fields disagree with the central directory');
		}
		entry.dataStart = entry.localHeaderOffset + 30 + fileNameLength + extraLength;
		entry.dataEnd = entry.dataStart + entry.compressedSize;
		if (!Number.isSafeInteger(entry.dataEnd) || entry.dataEnd > eocd.centralDirectoryOffset) {
			throw new ZipValidationError('ZIP entry data is outside archive bounds');
		}
		entry.structureEnd = entry.dataEnd;
	}

	const sorted = [...entries].sort((left, right) => left.localHeaderOffset - right.localHeaderOffset);
	for (let index = 0; index < sorted.length; index += 1) {
		throwIfAborted(signal);
		const entry = sorted[index]!;
		const boundary = sorted[index + 1]?.localHeaderOffset ?? eocd.centralDirectoryOffset;
		if ((entry.flags & DATA_DESCRIPTOR_FLAG) !== 0) {
			const available = Math.min(24, Math.max(0, boundary - entry.dataEnd));
			if (available < 12) throw new ZipValidationError('ZIP data descriptor is truncated or overlaps another entry');
			const descriptor = await readExact(handle, entry.dataEnd, available);
			const length = descriptorLength(descriptor, entry, boundary);
			if (length === null) throw new ZipValidationError('ZIP data descriptor is invalid');
			entry.structureEnd += length;
		}
		if (entry.localHeaderOffset >= boundary || entry.structureEnd > boundary) {
			throw new ZipValidationError('ZIP local file entries overlap');
		}
	}
}

function assertMagic(entries: StructuralEntry[]): void {
	if (entries[0]?.localHeaderOffset !== 0) {
		throw new ZipValidationError('ZIP magic bytes must begin at archive offset zero');
	}
}

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

function updateCrc32(state: number, chunk: Buffer): number {
	let next = state;
	for (const byte of chunk) next = CRC32_TABLE[(next ^ byte) & 0xff]! ^ (next >>> 8);
	return next >>> 0;
}

function entryMatches(entry: Entry, expected: StructuralEntry): boolean {
	return entry.fileName === expected.path
		&& entry.relativeOffsetOfLocalHeader === expected.localHeaderOffset
		&& entry.generalPurposeBitFlag === expected.flags
		&& entry.compressionMethod === expected.compressionMethod
		&& entry.compressedSize === expected.compressedSize
		&& entry.uncompressedSize === expected.uncompressedSize
		&& entry.crc32 === expected.crc32;
}

async function decodeEntry(
	zip: ZipFile,
	entry: Entry,
	expected: StructuralEntry,
	policy: EffectivePolicy,
	signal?: AbortSignal,
): Promise<number> {
	if (expected.isDirectory) return 0;
	throwIfAborted(signal);
	// Structure was checked above. An open/read failure here may be local I/O;
	// it is not evidence that the uploaded source is corrupt.
	const stream = await zip.openReadStreamPromise(entry);
	let abortFailure: ZipValidationAbortedError | undefined;
	const onAbort = () => {
		abortFailure = abortError(signal);
		stream.destroy(abortFailure);
	};
	signal?.addEventListener('abort', onAbort, { once: true });
	if (signal?.aborted) onAbort();
	let decodedBytes = 0;
	let crcState = 0xffffffff;
	const linkChunks: Buffer[] = [];
	try {
		for await (const raw of stream) {
			throwIfAborted(signal);
			const chunk = Buffer.from(raw as Buffer | Uint8Array | string);
			decodedBytes += chunk.length;
			if (!Number.isSafeInteger(decodedBytes)
				|| decodedBytes > policy.maxEntryUncompressedBytes
				|| decodedBytes > expected.uncompressedSize) {
				throw new ZipValidationError(`ZIP entry actual expansion exceeds its bound: ${expected.path}`);
			}
			crcState = updateCrc32(crcState, chunk);
			if (unixFileType(expected) === UNIX_SYMLINK) linkChunks.push(chunk);
		}
	} catch (error) {
		if (signal?.aborted) throw abortFailure ?? abortError(signal);
		if (error instanceof ZipValidationError) throw error;
		// zlib identifies malformed/truncated deflate data with stable codes.
		// Preserve filesystem, cancellation, and unknown library errors for retry.
		if (!(error instanceof Error && 'code' in error
			&& (error.code === 'Z_DATA_ERROR' || error.code === 'Z_BUF_ERROR'))) throw error;
		throw new ZipValidationError(`ZIP entry is corrupt or cannot be fully decoded: ${expected.path}`, {
			cause: error,
		});
	} finally {
		signal?.removeEventListener('abort', onAbort);
		if (!stream.destroyed) stream.destroy();
	}
	if (decodedBytes !== expected.uncompressedSize) {
		throw new ZipValidationError(`ZIP entry decoded size does not match metadata: ${expected.path}`);
	}
	const actualCrc32 = (crcState ^ 0xffffffff) >>> 0;
	if (actualCrc32 !== expected.crc32) {
		throw new ZipValidationError(`ZIP entry CRC32 mismatch: ${expected.path}`);
	}
	if (unixFileType(expected) === UNIX_SYMLINK) expected.linkTarget = Buffer.concat(linkChunks).toString('utf8');
	return decodedBytes;
}

/** Resolve component links entirely in the archive namespace, including framework directory links. */
function resolveArchiveLinks(entries: ValidatedZipEntry[]): void {
	const byPath = new Map(entries.map(entry => [entry.path.replace(/\/$/, ''), entry]));
	const directories = new Set<string>();
	for (const entry of entries) {
		const parts = entry.path.split('/');
		for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
	}
	function resolve(initial: string): string {
		let path = initial;
		const seen = new Set<string>();
		for (;;) {
			const parts = path.split('/');
			let replaced = false;
			for (let i = 1; i <= parts.length; i++) {
				const prefix = parts.slice(0, i).join('/');
				const entry = byPath.get(prefix);
				if (entry?.linkTarget === undefined) continue;
				if (seen.has(prefix)) throw new ZipValidationError('Symbolic link cycle in ZIP archive');
				seen.add(prefix);
				const target = entry.linkTarget;
				if (!target || target.includes('\0') || target.includes('\ufffd') || target.includes('\\')
					|| target.startsWith('/') || /^[a-zA-Z]:/.test(target)) throw new ZipValidationError('Unsafe symbolic link target');
				const joined = pathPosix.normalize(pathPosix.join(pathPosix.dirname(prefix), target));
				if (joined === '..' || joined.startsWith('../')) throw new ZipValidationError('Symbolic link escapes archive');
				path = pathPosix.normalize([joined, ...parts.slice(i)].join('/'));
				replaced = true;
				break;
			}
			if (replaced) continue;
			if (path !== '.' && !byPath.has(path) && !directories.has(path)) throw new ZipValidationError('Symbolic link target is missing');
			return path;
		}
	}

	const resolved = new Map<ValidatedZipEntry, string>();
	for (const entry of entries) if (entry.linkTarget !== undefined) resolved.set(entry, resolve(entry.path));
	for (const [entry, target] of resolved) entry.linkTarget = target;
}

async function fullyDecode(
	archivePath: string,
	structure: StructuralSummary,
	policy: EffectivePolicy,
	signal?: AbortSignal,
): Promise<{ decodedBytes: number; entries: ValidatedZipEntry[] }> {
	let zip: ZipFile | undefined;
	try {
		// yauzl owns this descriptor. Structural reads retain their independent
		// FileHandle so closing the decoder cannot invalidate the outer cleanup.
		zip = await yauzl.openPromise(archivePath, {
			autoClose: false,
			lazyEntries: true,
			decodeStrings: true,
			validateEntrySizes: false,
			strictFileNames: true,
		});
		const validated: ValidatedZipEntry[] = [];
		let decodedBytes = 0;
		let index = 0;
		for await (const entry of zip.eachEntry()) {
			throwIfAborted(signal);
			const expected = structure.entries[index];
			if (!expected || !entryMatches(entry, expected)) {
				throw new ZipValidationError('ZIP contents changed between structural validation and decode');
			}
			const entryDecodedBytes = await decodeEntry(zip, entry, expected, policy, signal);
			decodedBytes += entryDecodedBytes;
			if (!Number.isSafeInteger(decodedBytes) || decodedBytes > policy.maxTotalUncompressedBytes) {
				throw new ZipValidationError('ZIP actual expansion exceeds the total byte limit');
			}
			validated.push({
				path: expected.path,
				compressedBytes: expected.compressedSize,
				declaredUncompressedBytes: expected.uncompressedSize,
				decodedBytes: entryDecodedBytes,
				crc32: expected.crc32,
				compressionMethod: expected.compressionMethod,
				isDirectory: expected.isDirectory,
				...(expected.linkTarget !== undefined ? { linkTarget: expected.linkTarget } : {}),
			});
			index += 1;
		}
		if (index !== structure.entries.length) throw new ZipValidationError('ZIP entry count changed during decode');
		resolveArchiveLinks(validated);
		return { decodedBytes, entries: validated };
	} catch (error) {
		if (signal?.aborted) throw abortError(signal);
		throw error;
	} finally {
		zip?.close();
	}
}

/**
 * Validate one worker-local ZIP without extracting it. Structure metadata is
 * bounded before allocation, then every file is decoded sequentially into a
 * counting/CRC sink. The single archive descriptor is always closed by the
 * caller-visible promise, including deterministic rejection and cancellation.
 * Expansion is bounded by absolute byte limits, not compression ratio: highly
 * repetitive game resources can legitimately compress by more than 100:1.
 */
export async function validateBoundedZipFile(
	archivePath: string,
	options: BoundedZipValidationOptions,
): Promise<BoundedZipValidationSummary> {
	const policy = policyFrom(options);
	throwIfAborted(options.signal);
	const handle = await open(archivePath, 'r');
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new ZipValidationError('ZIP source is not a regular file');
		if (stat.size > policy.maxArchiveBytes) throw new ZipValidationError('ZIP archive exceeds the physical byte limit');
		const magic = stat.size >= 4 ? await readExact(handle, 0, 4) : Buffer.alloc(0);
		if (magic.length !== 4 || magic.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE) {
			throw new ZipValidationError('ZIP magic bytes are invalid');
		}
		throwIfAborted(options.signal);
		const eocd = await findEndOfCentralDirectory(handle, stat.size, policy);
		const central = await readExact(
			handle,
			eocd.centralDirectoryOffset,
			eocd.centralDirectorySize,
		);
		const structure = parseCentralDirectory(central, eocd, policy);
		assertMagic(structure.entries);
		await validateLocalHeaders(handle, structure.entries, eocd, options.signal);
		throwIfAborted(options.signal);
		const decoded = await fullyDecode(archivePath, structure, policy, options.signal);
		return {
			profile: policy.profile,
			archiveBytes: stat.size,
			entryCount: decoded.entries.length,
			declaredUncompressedBytes: structure.declaredUncompressedBytes,
			decodedBytes: decoded.decodedBytes,
			entries: decoded.entries,
		};
	} finally {
		await handle.close();
	}
}
