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
	maxCompressionRatio?: number;
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
}

export interface BoundedZipValidationSummary {
	profile: ZipValidationProfile;
	archiveBytes: number;
	entryCount: number;
	declaredUncompressedBytes: number;
	decodedBytes: number;
	entries: ValidatedZipEntry[];
}

export class ZipValidationError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'ZipValidationError';
	}
}

export class ZipValidationAbortedError extends Error {
	constructor(options?: { cause?: unknown }) {
		super('ZIP validation was aborted', options);
		this.name = 'AbortError';
	}
}

interface EffectivePolicy {
	profile: ZipValidationProfile;
	maxArchiveBytes: number;
	maxEntries: number;
	maxCentralDirectoryBytes: number;
	maxEntryUncompressedBytes: number;
	maxTotalUncompressedBytes: number;
	maxCompressionRatio: number;
	allowNestedArchivePath(path: string): boolean;
}

interface EndOfCentralDirectory {
	entryCount: number;
	centralDirectoryOffset: number;
	centralDirectorySize: number;
}

interface StructuralEntry {
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
	maxCompressionRatio: 100,
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
		maxCompressionRatio: positiveSafeInteger(
			options.maxCompressionRatio ?? DEFAULTS.maxCompressionRatio,
			'maxCompressionRatio',
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
		const entriesOnDisk = tail.readUInt16LE(offset + 8);
		const entryCount = tail.readUInt16LE(offset + 10);
		const centralDirectorySize = tail.readUInt32LE(offset + 12);
		const centralDirectoryOffset = tail.readUInt32LE(offset + 16);
		if (entriesOnDisk === 0xffff
			|| entryCount === 0xffff
			|| centralDirectorySize === 0xffffffff
			|| centralDirectoryOffset === 0xffffffff) {
			throw new ZipValidationError('ZIP64 archives are not supported');
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
		const eocdOffset = tailOffset + offset;
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
	if (type === UNIX_SYMLINK) throw new ZipValidationError('Symbolic links are not allowed in ZIP archives');
	if (type !== 0 && type !== UNIX_REGULAR_FILE && type !== UNIX_DIRECTORY) {
		throw new ZipValidationError('ZIP archive contains an unsupported filesystem entry');
	}
}

function assertDeclaredBounds(entry: StructuralEntry, policy: EffectivePolicy): void {
	if (entry.uncompressedSize > policy.maxEntryUncompressedBytes) {
		throw new ZipValidationError('ZIP entry expands beyond the per-entry byte limit');
	}
	if (!entry.isDirectory && (
		(entry.compressedSize === 0 && entry.uncompressedSize > 0)
		|| (entry.compressedSize > 0
			&& entry.uncompressedSize / entry.compressedSize > policy.maxCompressionRatio)
	)) {
		throw new ZipValidationError('ZIP entry declared compression ratio is too high');
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

function containsZip64Extra(extraRaw: Buffer): boolean {
	try {
		return parseExtraFields(extraRaw).some((field) => field.id === ZIP64_EXTRA_FIELD_ID);
	} catch (error) {
		throw new ZipValidationError('ZIP extra field is malformed', { cause: error });
	}
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
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const uncompressedSize = buffer.readUInt32LE(offset + 24);
		const fileNameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const diskStart = buffer.readUInt16LE(offset + 34);
		const externalFileAttributes = buffer.readUInt32LE(offset + 38);
		const localHeaderOffset = buffer.readUInt32LE(offset + 42);
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
		if (compressedSize === 0xffffffff
			|| uncompressedSize === 0xffffffff
			|| localHeaderOffset === 0xffffffff) {
			throw new ZipValidationError('ZIP64 archives are not supported');
		}
		const fileNameRaw = Buffer.from(buffer.subarray(nameStart, nameEnd));
		const extraRaw = Buffer.from(buffer.subarray(nameEnd, extraEnd));
		if (containsZip64Extra(extraRaw)) throw new ZipValidationError('ZIP64 archives are not supported');
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
	const candidates = buffer.length >= 16 && buffer.readUInt32LE(0) === DATA_DESCRIPTOR_SIGNATURE
		? [
			{ length: 16, crc: buffer.readUInt32LE(4), compressed: buffer.readUInt32LE(8), uncompressed: buffer.readUInt32LE(12) },
			{ length: 12, crc: buffer.readUInt32LE(0), compressed: buffer.readUInt32LE(4), uncompressed: buffer.readUInt32LE(8) },
		]
		: [{ length: 12, crc: buffer.readUInt32LE(0), compressed: buffer.readUInt32LE(4), uncompressed: buffer.readUInt32LE(8) }];
	for (const candidate of candidates) {
		if (entry.dataEnd + candidate.length <= boundary
			&& candidate.crc === entry.crc32
			&& candidate.compressed === entry.compressedSize
			&& candidate.uncompressed === entry.uncompressedSize) {
			return candidate.length;
		}
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
		const localCompressedSize = fixed.readUInt32LE(18);
		const localUncompressedSize = fixed.readUInt32LE(22);
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
		if (containsZip64Extra(localExtra)) throw new ZipValidationError('ZIP64 archives are not supported');
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
			const available = Math.min(16, Math.max(0, boundary - entry.dataEnd));
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
	let stream: Awaited<ReturnType<ZipFile['openReadStreamPromise']>>;
	try {
		stream = await zip.openReadStreamPromise(entry);
	} catch (error) {
		throw new ZipValidationError(`ZIP entry cannot be opened: ${expected.path}`, { cause: error });
	}
	let abortFailure: ZipValidationAbortedError | undefined;
	const onAbort = () => {
		abortFailure = abortError(signal);
		stream.destroy(abortFailure);
	};
	signal?.addEventListener('abort', onAbort, { once: true });
	let decodedBytes = 0;
	let crcState = 0xffffffff;
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
			if (expected.compressedSize === 0
				? decodedBytes > 0
				: decodedBytes / expected.compressedSize > policy.maxCompressionRatio) {
				throw new ZipValidationError(`ZIP entry actual compression ratio is too high: ${expected.path}`);
			}
			crcState = updateCrc32(crcState, chunk);
		}
	} catch (error) {
		if (signal?.aborted) throw abortFailure ?? abortError(signal);
		if (error instanceof ZipValidationError) throw error;
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
	return decodedBytes;
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
			});
			index += 1;
		}
		if (index !== structure.entries.length) throw new ZipValidationError('ZIP entry count changed during decode');
		return { decodedBytes, entries: validated };
	} catch (error) {
		if (signal?.aborted) throw abortError(signal);
		if (error instanceof ZipValidationError || error instanceof ZipValidationAbortedError) throw error;
		throw new ZipValidationError('ZIP archive is corrupt or cannot be decoded', { cause: error });
	} finally {
		zip?.close();
	}
}

/**
 * Validate one worker-local ZIP without extracting it. Structure metadata is
 * bounded before allocation, then every file is decoded sequentially into a
 * counting/CRC sink. The single archive descriptor is always closed by the
 * caller-visible promise, including deterministic rejection and cancellation.
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
