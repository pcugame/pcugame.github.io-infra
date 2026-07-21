import { promises as fsp } from 'node:fs';
import { posix as pathPosix, win32 as pathWin32 } from 'node:path';
import { badRequest } from '../../../shared/errors.js';
import { readObjectRange } from '../../../lib/storage.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;

const MAX_EOCD_SEARCH_BYTES = 65_557;
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

	const normalized = pathPosix.normalize(name.replace(/\\/g, '/'));
	return normalized === '..' || normalized.startsWith('../');
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
		if ((flags & 0x1) !== 0 || compressionMethod === 99) {
			throw badRequest('Encrypted ZIP archives are not allowed');
		}
		if (
			compressedSize === 0xffffffff ||
			uncompressedSize === 0xffffffff ||
			localHeaderOffset === 0xffffffff
		) {
			throw badRequest('ZIP64 archives are not supported');
		}

		const name = buffer.subarray(nameStart, nameEnd).toString('utf8');
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

		entryCount++;
		entries.push({
			fileName: name,
			compressedSize,
			uncompressedSize,
			compressionMethod,
			flags,
			versionMadeBy,
			externalFileAttributes,
			isDirectory: name.endsWith('/') || (externalFileAttributes & 0x10) !== 0,
		});
		if (entryCount > MAX_ZIP_ENTRIES) throw badRequest('ZIP archive has too many files');
		offset = nextOffset;
	}

	if (entryCount !== expectedEntries) throw badRequest('ZIP archive entry count is invalid');
	return { entryCount, totalUncompressedBytes, entries };
}

async function validateZipArchive(input: ZipValidationInput): Promise<ZipValidationSummary> {
	if (input.sizeBytes < 22) throw badRequest('ZIP archive is too small');

	const eocd = findEocd(input.eocdTail, input.tailStartOffset, input.sizeBytes);
	const centralDirectory = await input.readRange(
		eocd.centralDirectoryOffset,
		eocd.centralDirectoryOffset + eocd.centralDirectorySize - 1,
	);

	if (centralDirectory.length !== eocd.centralDirectorySize) {
		throw badRequest('ZIP archive central directory could not be read');
	}

	return parseCentralDirectory(centralDirectory, eocd.entryCount, {
		allowGzipEntries: input.allowGzipEntries,
	});
}

async function validateZipArchiveFileWithOptions(
	filePath: string,
	sizeBytes: number | undefined,
	options: { allowGzipEntries?: boolean },
): Promise<ZipValidationSummary> {
	const stat = sizeBytes == null ? await fsp.stat(filePath) : { size: sizeBytes };
	const tailLength = Math.min(stat.size, MAX_EOCD_SEARCH_BYTES);
	const tailStart = stat.size - tailLength;
	const handle = await fsp.open(filePath, 'r');

	try {
		const tail = Buffer.alloc(tailLength);
		await handle.read(tail, 0, tailLength, tailStart);
		return await validateZipArchive({
			sizeBytes: stat.size,
			eocdTail: tail,
			tailStartOffset: tailStart,
			allowGzipEntries: options.allowGzipEntries,
			readRange: async (start, end) => {
				const length = end - start + 1;
				const buffer = Buffer.alloc(length);
				await handle.read(buffer, 0, length, start);
				return buffer;
			},
		});
	} finally {
		await handle.close();
	}
}

export function validateZipArchiveFile(filePath: string, sizeBytes?: number): Promise<ZipValidationSummary> {
	return validateZipArchiveFileWithOptions(filePath, sizeBytes, {});
}

export function validateWebglZipArchiveFile(filePath: string, sizeBytes?: number): Promise<ZipValidationSummary> {
	return validateZipArchiveFileWithOptions(filePath, sizeBytes, { allowGzipEntries: true });
}

export async function validateZipArchiveObject(
	bucket: string,
	key: string,
	sizeBytes: number,
): Promise<ZipValidationSummary> {
	const tailLength = Math.min(sizeBytes, MAX_EOCD_SEARCH_BYTES);
	const tailStart = sizeBytes - tailLength;
	const tail = await readObjectRange(bucket, key, tailStart, sizeBytes - 1);

	return validateZipArchive({
		sizeBytes,
		eocdTail: tail,
		tailStartOffset: tailStart,
		readRange: (start, end) => readObjectRange(bucket, key, start, end),
	});
}

/** WebGL builds may legitimately contain pre-compressed `.gz` resources. */
export async function validateWebglZipArchiveObject(
	bucket: string,
	key: string,
	sizeBytes: number,
): Promise<ZipValidationSummary> {
	const tailLength = Math.min(sizeBytes, MAX_EOCD_SEARCH_BYTES);
	const tailStart = sizeBytes - tailLength;
	const tail = await readObjectRange(bucket, key, tailStart, sizeBytes - 1);

	return validateZipArchive({
		sizeBytes,
		eocdTail: tail,
		tailStartOffset: tailStart,
		allowGzipEntries: true,
		readRange: (start, end) => readObjectRange(bucket, key, start, end),
	});
}
