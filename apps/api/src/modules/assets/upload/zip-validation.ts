import { posix as pathPosix, win32 as pathWin32 } from 'node:path';
import { badRequest } from '../../../shared/errors.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

const UNIX_HOST = 3;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;
const UNIX_SYMLINK = 0o120000;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const ENCRYPTION_FLAGS = 0x2041;

export const MAX_EOCD_SEARCH_BYTES = 65_557;
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_ENTRY_COMPRESSION_RATIO = 100;

const ARCHIVE_EXT_RE = /\.(zip|7z|rar|tar|gz|tgz|bz2|xz|apk|jar|war|ear)$/i;

interface Eocd {
	entryCount: number;
	centralDirectorySize: number;
	centralDirectoryOffset: number;
}

interface ZipValidationInput {
	sizeBytes: number;
	eocdTail: Buffer;
	tailStartOffset: number;
	allowGzipEntries?: boolean;
	readRange(start: number, end: number): Promise<Buffer>;
}

export interface ZipEntryMetadata {
	fileName: string;
	compressedSize: number;
	uncompressedSize: number;
	compressionMethod: number;
	flags: number;
	versionMadeBy: number;
	externalFileAttributes: number;
	isDirectory: boolean;
	localHeaderOffset: number;
	fileNameBytes: Uint8Array;
}

export interface ZipValidationSummary {
	entryCount: number;
	totalUncompressedBytes: number;
	entries: ZipEntryMetadata[];
}

function findEocd(input: Buffer, tailStartOffset: number, sizeBytes: number): Eocd {
	for (let offset = input.length - 22; offset >= 0; offset--) {
		if (input.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;

		const commentLength = input.readUInt16LE(offset + 20);
		if (offset + 22 + commentLength !== input.length) continue;

		const diskNumber = input.readUInt16LE(offset + 4);
		const centralDirectoryDisk = input.readUInt16LE(offset + 6);
		const entriesOnDisk = input.readUInt16LE(offset + 8);
		const totalEntries = input.readUInt16LE(offset + 10);
		const centralDirectorySize = input.readUInt32LE(offset + 12);
		const centralDirectoryOffset = input.readUInt32LE(offset + 16);

		if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== totalEntries) {
			throw badRequest('Split ZIP archives are not supported');
		}
		if (
			totalEntries === 0xffff ||
			centralDirectorySize === 0xffffffff ||
			centralDirectoryOffset === 0xffffffff
		) {
			throw badRequest('ZIP64 archives are not supported');
		}
		if (totalEntries < 1) throw badRequest('ZIP archive is empty');
		if (totalEntries > MAX_ZIP_ENTRIES) throw badRequest('ZIP archive has too many files');
		// Every central-directory file header is at least 46 bytes. Reject this
		// before issuing a range read so malformed EOCD metadata cannot turn into
		// an invalid `offset..offset - 1` storage request and a transient retry.
		if (centralDirectorySize < totalEntries * 46) {
			throw badRequest('ZIP archive central directory size is invalid');
		}
		if (centralDirectorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
			throw badRequest('ZIP archive metadata is too large');
		}

		const eocdAbsoluteOffset = tailStartOffset + offset;
		const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
		if (
			centralDirectoryOffset < 0 ||
			centralDirectorySize < 0 ||
			centralDirectoryEnd > eocdAbsoluteOffset ||
			centralDirectoryEnd > sizeBytes
		) {
			throw badRequest('ZIP archive structure is invalid');
		}

		return {
			entryCount: totalEntries,
			centralDirectorySize,
			centralDirectoryOffset,
		};
	}

	throw badRequest('ZIP archive central directory was not found');
}

function isUnsafeZipPath(name: string): boolean {
	if (!name || name.includes('\0')) return true;
	if (name.startsWith('/') || name.startsWith('\\')) return true;
	if (/^[a-zA-Z]:/.test(name) || pathWin32.isAbsolute(name)) return true;

	const rawSegments = name.replace(/\\/g, '/').split('/');
	if (rawSegments.some((segment) => segment === '.' || segment === '..')) return true;
	const normalized = pathPosix.normalize(rawSegments.join('/'));
	return normalized === '..' || normalized.startsWith('../');
}

function unixFileType(input: {
	versionMadeBy: number;
	externalFileAttributes: number;
}): number {
	const host = (input.versionMadeBy >>> 8) & 0xff;
	if (host !== UNIX_HOST) return 0;
	return (input.externalFileAttributes >>> 16) & UNIX_FILE_TYPE_MASK;
}

function assertSafeFilesystemEntry(input: {
	versionMadeBy: number;
	externalFileAttributes: number;
	compressionMethod: number;
}): void {
	const fileType = unixFileType(input);
	if (fileType === UNIX_SYMLINK) {
		throw badRequest('Symbolic links are not allowed in ZIP archives');
	}
	if (fileType !== 0 && fileType !== UNIX_REGULAR_FILE && fileType !== UNIX_DIRECTORY) {
		throw badRequest('ZIP archive contains an unsupported filesystem entry');
	}
	if (input.compressionMethod !== 0 && input.compressionMethod !== 8) {
		throw badRequest('ZIP archive uses an unsupported compression method');
	}
}

function parseCentralDirectory(
	buffer: Buffer,
	expectedEntries: number,
	options: { allowGzipEntries?: boolean } = {},
): ZipValidationSummary {
	let offset = 0;
	let entryCount = 0;
	let totalUncompressedBytes = 0;
	const entries: ZipEntryMetadata[] = [];

	while (offset < buffer.length) {
		if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
			throw badRequest('ZIP archive central directory is invalid');
		}

		const versionMadeBy = buffer.readUInt16LE(offset + 4);
		const flags = buffer.readUInt16LE(offset + 8);
		const compressionMethod = buffer.readUInt16LE(offset + 10);
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const uncompressedSize = buffer.readUInt32LE(offset + 24);
		const fileNameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const externalFileAttributes = buffer.readUInt32LE(offset + 38);
		const localHeaderOffset = buffer.readUInt32LE(offset + 42);
		const nameStart = offset + 46;
		const nameEnd = nameStart + fileNameLength;
		const nextOffset = nameEnd + extraLength + commentLength;

		if (nextOffset > buffer.length) throw badRequest('ZIP archive central directory is truncated');
		if ((flags & ENCRYPTION_FLAGS) !== 0 || compressionMethod === 99) {
			throw badRequest('Encrypted ZIP archives are not allowed');
		}
		if (
			compressedSize === 0xffffffff ||
			uncompressedSize === 0xffffffff ||
			localHeaderOffset === 0xffffffff
		) {
			throw badRequest('ZIP64 archives are not supported');
		}

		const fileNameBytes = Buffer.from(buffer.subarray(nameStart, nameEnd));
		const name = fileNameBytes.toString('utf8');
		if (isUnsafeZipPath(name)) throw badRequest('ZIP archive contains an unsafe file path');
		if (ARCHIVE_EXT_RE.test(name) && !(options.allowGzipEntries && /\.gz$/i.test(name))) {
			throw badRequest(options.allowGzipEntries
				? 'Nested archives are not allowed in WebGL ZIP files'
				: 'Nested archives are not allowed in game ZIP files');
		}

		totalUncompressedBytes += uncompressedSize;
		if (totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
			throw badRequest('ZIP archive expands to too much data');
		}

		if (
			(compressedSize === 0 && uncompressedSize > 0) ||
			(compressedSize > 0 && uncompressedSize / compressedSize > MAX_ENTRY_COMPRESSION_RATIO)
		) {
			throw badRequest('ZIP archive compression ratio is too high');
		}
		assertSafeFilesystemEntry({
			versionMadeBy,
			externalFileAttributes,
			compressionMethod,
		});
		const fileType = unixFileType({ versionMadeBy, externalFileAttributes });

		entryCount++;
		entries.push({
			fileName: name,
			compressedSize,
			uncompressedSize,
			compressionMethod,
			flags,
			versionMadeBy,
			externalFileAttributes,
			isDirectory: name.endsWith('/')
				|| (externalFileAttributes & 0x10) !== 0
				|| fileType === UNIX_DIRECTORY,
			localHeaderOffset,
			fileNameBytes,
		});
		if (entryCount > MAX_ZIP_ENTRIES) throw badRequest('ZIP archive has too many files');
		offset = nextOffset;
	}

	if (entryCount !== expectedEntries) throw badRequest('ZIP archive entry count is invalid');
	return { entryCount, totalUncompressedBytes, entries };
}

async function validateLocalFileHeaders(input: {
	entries: ZipEntryMetadata[];
	centralDirectoryOffset: number;
	readRange(start: number, end: number): Promise<Buffer>;
}): Promise<void> {
	const ranges: Array<{ start: number; dataEnd: number; fileName: string }> = [];
	for (const entry of input.entries) {
		if (entry.localHeaderOffset < 0
			|| entry.localHeaderOffset + 30 > input.centralDirectoryOffset) {
			throw badRequest('ZIP local file header is outside archive data bounds');
		}
		const fixed = await input.readRange(
			entry.localHeaderOffset,
			entry.localHeaderOffset + 29,
		);
		if (fixed.length !== 30
			|| fixed.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE) {
			throw badRequest('ZIP local file header signature is invalid');
		}
		const flags = fixed.readUInt16LE(6);
		const compressionMethod = fixed.readUInt16LE(8);
		const compressedSize = fixed.readUInt32LE(18);
		const uncompressedSize = fixed.readUInt32LE(22);
		const fileNameLength = fixed.readUInt16LE(26);
		const extraLength = fixed.readUInt16LE(28);
		if (flags !== entry.flags || compressionMethod !== entry.compressionMethod) {
			throw badRequest('ZIP local file header does not match central directory');
		}
		if ((flags & DATA_DESCRIPTOR_FLAG) === 0
			&& (compressedSize !== entry.compressedSize
				|| uncompressedSize !== entry.uncompressedSize)) {
			throw badRequest('ZIP local file sizes do not match central directory');
		}
		if ((flags & DATA_DESCRIPTOR_FLAG) !== 0
			&& ((compressedSize !== 0 && compressedSize !== entry.compressedSize)
				|| (uncompressedSize !== 0 && uncompressedSize !== entry.uncompressedSize))) {
			throw badRequest('ZIP local file sizes do not match central directory');
		}
		const variableStart = entry.localHeaderOffset + 30;
		const dataStart = variableStart + fileNameLength + extraLength;
		const dataEnd = dataStart + entry.compressedSize;
		if (!Number.isSafeInteger(dataEnd) || dataEnd > input.centralDirectoryOffset) {
			throw badRequest('ZIP entry data is outside archive bounds');
		}
		const localName = fileNameLength === 0
			? Buffer.alloc(0)
			: await input.readRange(variableStart, variableStart + fileNameLength - 1);
		if (localName.length !== fileNameLength
			|| !localName.equals(Buffer.from(entry.fileNameBytes))) {
			throw badRequest('ZIP local file name does not match central directory');
		}
		ranges.push({ start: entry.localHeaderOffset, dataEnd, fileName: entry.fileName });
	}

	const sorted = ranges.sort((left, right) => left.start - right.start);
	for (let index = 1; index < sorted.length; index += 1) {
		const previous = sorted[index - 1]!;
		const current = sorted[index]!;
		if (previous.dataEnd > current.start || previous.start === current.start) {
			throw badRequest('ZIP local file entries overlap');
		}
	}
}

export async function validateZipArchive(input: ZipValidationInput): Promise<ZipValidationSummary> {
	if (input.sizeBytes < 22) throw badRequest('ZIP archive is too small');

	const eocd = findEocd(input.eocdTail, input.tailStartOffset, input.sizeBytes);
	const centralDirectory = await input.readRange(
		eocd.centralDirectoryOffset,
		eocd.centralDirectoryOffset + eocd.centralDirectorySize - 1,
	);

	if (centralDirectory.length !== eocd.centralDirectorySize) {
		throw badRequest('ZIP archive central directory could not be read');
	}

	const summary = parseCentralDirectory(centralDirectory, eocd.entryCount, {
		allowGzipEntries: input.allowGzipEntries,
	});
	await validateLocalFileHeaders({
		entries: summary.entries,
		centralDirectoryOffset: eocd.centralDirectoryOffset,
		readRange: input.readRange,
	});
	return summary;
}

export async function validateZipArchiveObject(
	sizeBytes: number,
	readRange: (start: number, end: number) => Promise<Buffer>,
): Promise<ZipValidationSummary> {
	const tailLength = Math.min(sizeBytes, MAX_EOCD_SEARCH_BYTES);
	const tailStart = sizeBytes - tailLength;
	const tail = await readRange(tailStart, sizeBytes - 1);

	return validateZipArchive({
		sizeBytes,
		eocdTail: tail,
		tailStartOffset: tailStart,
		readRange,
	});
}

/** WebGL builds may legitimately contain pre-compressed `.gz` resources. */
export async function validateWebglZipArchiveObject(
	sizeBytes: number,
	readRange: (start: number, end: number) => Promise<Buffer>,
): Promise<ZipValidationSummary> {
	const tailLength = Math.min(sizeBytes, MAX_EOCD_SEARCH_BYTES);
	const tailStart = sizeBytes - tailLength;
	const tail = await readRange(tailStart, sizeBytes - 1);

	return validateZipArchive({
		sizeBytes,
		eocdTail: tail,
		tailStartOffset: tailStart,
		allowGzipEntries: true,
		readRange,
	});
}
