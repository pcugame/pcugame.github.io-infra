import { posix as pathPosix } from 'node:path';
import yauzl, { type Entry } from 'yauzl';
import { badRequest } from '../../shared/errors.js';
import { uploadFile } from '../../lib/storage.js';
import type { ZipEntryMetadata, ZipValidationSummary } from '../assets/upload/zip-validation.js';
import { webglContentMetadata } from './content.js';

const UNIX_HOST = 3;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;
const UNIX_SYMLINK = 0o120000;

function normalizedEntryName(fileName: string): string {
	const normalized = pathPosix.normalize(fileName.replace(/\\/g, '/'));
	if (
		!normalized
		|| normalized === '.'
		|| normalized === '..'
		|| normalized.startsWith('../')
		|| normalized.startsWith('/')
		|| normalized.includes('\0')
	) {
		throw badRequest('WebGL ZIP contains an unsafe file path');
	}
	return normalized.replace(/^\.\//, '');
}

function unixFileType(entry: Pick<ZipEntryMetadata, 'versionMadeBy' | 'externalFileAttributes'>): number {
	const host = (entry.versionMadeBy >>> 8) & 0xff;
	if (host !== UNIX_HOST) return 0;
	return (entry.externalFileAttributes >>> 16) & UNIX_FILE_TYPE_MASK;
}

function assertSafeEntryType(entry: ZipEntryMetadata): void {
	const fileType = unixFileType(entry);
	if (fileType === UNIX_SYMLINK) {
		throw badRequest('Symbolic links are not allowed in WebGL ZIP files');
	}
	if (fileType !== 0 && fileType !== UNIX_REGULAR_FILE && fileType !== UNIX_DIRECTORY) {
		throw badRequest('WebGL ZIP contains an unsupported filesystem entry');
	}
	if (!entry.isDirectory && entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
		throw badRequest('WebGL ZIP uses an unsupported compression method');
	}
}

export interface WebglArchiveLayout {
	wrapperPrefix: string;
	files: Map<string, string>;
}

/** Validate WebGL-specific layout and return archive-name -> hosted-path mappings. */
export function analyzeWebglArchive(summary: ZipValidationSummary): WebglArchiveLayout {
	const normalizedFiles: Array<{ entry: ZipEntryMetadata; name: string }> = [];
	const seenNames = new Set<string>();

	for (const entry of summary.entries) {
		assertSafeEntryType(entry);
		if (entry.isDirectory) continue;
		const name = normalizedEntryName(entry.fileName);
		if (seenNames.has(name)) throw badRequest('WebGL ZIP contains duplicate file paths');
		seenNames.add(name);
		normalizedFiles.push({ entry, name });
	}

	const indexes = normalizedFiles.filter(({ name }) => name === 'index.html' || name.endsWith('/index.html'));
	if (indexes.length === 0) throw badRequest('WebGL ZIP must contain index.html');
	if (indexes.length > 1) throw badRequest('WebGL ZIP must contain exactly one index.html');

	const indexName = indexes[0]!.name;
	let wrapperPrefix = '';
	if (indexName !== 'index.html') {
		const segments = indexName.split('/');
		if (segments.length !== 2 || !segments[0]) {
			throw badRequest('index.html must be at ZIP root or inside one wrapper folder');
		}
		wrapperPrefix = `${segments[0]}/`;
		if (normalizedFiles.some(({ name }) => !name.startsWith(wrapperPrefix))) {
			throw badRequest('All WebGL files must be inside the single wrapper folder');
		}
	}

	const files = new Map<string, string>();
	for (const { entry, name } of normalizedFiles) {
		const hostedPath = wrapperPrefix ? name.slice(wrapperPrefix.length) : name;
		if (!hostedPath || hostedPath === 'index.html/' || hostedPath.startsWith('../')) {
			throw badRequest('WebGL ZIP contains an invalid hosted path');
		}
		files.set(normalizedEntryName(entry.fileName), hostedPath);
	}

	return { wrapperPrefix, files };
}

function entryIsDirectory(entry: Entry): boolean {
	return entry.fileName.endsWith('/') || (entry.externalFileAttributes & 0x10) !== 0;
}

/** Stream validated archive entries into the public bucket without writing extracted files to disk. */
export async function uploadWebglArchive(
	archivePath: string,
	publicBucket: string,
	sitePrefix: string,
	layout: WebglArchiveLayout,
	onUploaded?: (key: string) => void,
): Promise<string[]> {
	const zip = await yauzl.openPromise(archivePath, {
		autoClose: false,
		lazyEntries: true,
		decodeStrings: true,
		validateEntrySizes: true,
		strictFileNames: true,
	});
	const uploadedKeys: string[] = [];
	const seen = new Set<string>();

	try {
		for await (const entry of zip.eachEntry()) {
			if (entryIsDirectory(entry)) continue;
			const normalized = normalizedEntryName(entry.fileName);
			const hostedPath = layout.files.get(normalized);
			if (!hostedPath || seen.has(normalized)) {
				throw badRequest('WebGL ZIP contents changed during extraction');
			}
			seen.add(normalized);

			if (entry.isEncrypted()) throw badRequest('Encrypted WebGL ZIP files are not allowed');
			if (!entry.canDecodeFileData()) throw badRequest('WebGL ZIP uses an unsupported compression method');
			const stream = await zip.openReadStreamPromise(entry);
			const key = `${sitePrefix}${hostedPath}`;
			const metadata = webglContentMetadata(hostedPath);
			await uploadFile(
				publicBucket,
				key,
				stream,
				metadata.contentType,
				entry.uncompressedSize,
				{
					contentType: metadata.contentType,
					contentEncoding: metadata.contentEncoding,
					cacheControl: metadata.cacheControl,
				},
			);
			uploadedKeys.push(key);
			onUploaded?.(key);
		}

		if (seen.size !== layout.files.size) {
			throw badRequest('WebGL ZIP extraction did not produce every validated file');
		}
		return uploadedKeys;
	} finally {
		zip.close();
	}
}
