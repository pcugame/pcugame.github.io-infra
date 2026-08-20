import { posix as pathPosix } from 'node:path';
import yauzl, { type Entry } from 'yauzl';
import type { ObjectStorage } from '../../application/ports.js';
import { badRequest } from '../../shared/errors.js';
import type { ZipEntryMetadata, ZipValidationSummary } from '../assets/upload/zip-validation.js';
import { webglContentMetadata } from './content.js';

const UNIX_HOST = 3;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;
const UNIX_SYMLINK = 0o120000;

function normalizedEntryName(fileName: string): string {
	const rawSegments = fileName.replace(/\\/g, '/').split('/');
	const normalized = pathPosix.normalize(rawSegments.join('/'));
	if (
		!normalized
		|| normalized === '.'
		|| normalized === '..'
		|| normalized.startsWith('../')
		|| normalized.startsWith('/')
		|| normalized.includes('\0')
		|| rawSegments.some((segment) => segment === '.' || segment === '..')
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

const REQUIRED_UNITY_BUILD_ARTIFACTS = [
	{ label: 'loader.js', pattern: /^Build\/[^/]+\.loader\.js(?:\.(?:gz|br))?$/i },
	{ label: 'framework.js', pattern: /^Build\/[^/]+\.framework\.js(?:\.(?:gz|br))?$/i },
	{ label: 'wasm', pattern: /^Build\/[^/]+\.wasm(?:\.(?:gz|br))?$/i },
	{ label: 'data', pattern: /^Build\/[^/]+\.data(?:\.(?:gz|br))?$/i },
] as const;

function assertRequiredUnityArtifacts(hostedPaths: Iterable<string>): void {
	const paths = [...hostedPaths];
	for (const required of REQUIRED_UNITY_BUILD_ARTIFACTS) {
		if (!paths.some((path) => required.pattern.test(path))) {
			throw badRequest(`WebGL ZIP is missing required Unity Build ${required.label} artifact`);
		}
	}
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
	assertRequiredUnityArtifacts(files.values());

	return { wrapperPrefix, files };
}

function entryIsDirectory(entry: Entry): boolean {
	return entry.fileName.endsWith('/') || (entry.externalFileAttributes & 0x10) !== 0;
}

function isDeterministicArchiveDecodeError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as NodeJS.ErrnoException).code;
	if (typeof code === 'string' && /^Z_(?:DATA|BUF|STREAM|VERSION)_ERROR$/.test(code)) {
		return true;
	}
	return /(?:central directory|local file header|compressed data|uncompressed data|invalid (?:stored )?block|invalid distance|incorrect data check|unexpected (?:end of file|eof)|entry size|(?:invalid|corrupt|malformed|truncated).*zip)/i
		.test(error.message);
}

function deterministicArchiveError(error: unknown): Error {
	if (!isDeterministicArchiveDecodeError(error)) return error as Error;
	return badRequest('WebGL ZIP archive is corrupt or cannot be decoded');
}

async function openArchive(archivePath: string) {
	try {
		return await yauzl.openPromise(archivePath, {
			autoClose: false,
			lazyEntries: true,
			decodeStrings: true,
			validateEntrySizes: true,
			strictFileNames: true,
		});
	} catch (error) {
		throw deterministicArchiveError(error);
	}
}

function resolveHostedEntry(
	entry: Entry,
	layout: WebglArchiveLayout,
	seen: Set<string>,
): { normalized: string; hostedPath: string } | null {
	if (entryIsDirectory(entry)) return null;
	const normalized = normalizedEntryName(entry.fileName);
	const hostedPath = layout.files.get(normalized);
	if (!hostedPath || seen.has(normalized)) {
		throw badRequest('WebGL ZIP contents changed during extraction');
	}
	seen.add(normalized);
	if (entry.isEncrypted()) throw badRequest('Encrypted WebGL ZIP files are not allowed');
	if (!entry.canDecodeFileData()) throw badRequest('WebGL ZIP uses an unsupported compression method');
	return { normalized, hostedPath };
}

async function openEntryStream(
	zip: Awaited<ReturnType<typeof yauzl.openPromise>>,
	entry: Entry,
) {
	try {
		return await zip.openReadStreamPromise(entry);
	} catch (error) {
		throw deterministicArchiveError(error);
	}
}

async function assertEveryEntryDecodes(
	archivePath: string,
	layout: WebglArchiveLayout,
): Promise<void> {
	const zip = await openArchive(archivePath);
	const seen = new Set<string>();
	try {
		const iterator = zip.eachEntry()[Symbol.asyncIterator]();
		while (true) {
			let next: IteratorResult<Entry>;
			try {
				next = await iterator.next();
			} catch (error) {
				throw deterministicArchiveError(error);
			}
			if (next.done) break;
			const entry = next.value;
			if (!resolveHostedEntry(entry, layout, seen)) continue;
			const stream = await openEntryStream(zip, entry);
			let decodedBytes = 0;
			try {
				for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
					decodedBytes += Buffer.byteLength(chunk);
				}
			} catch (error) {
				throw deterministicArchiveError(error);
			}
			if (decodedBytes !== entry.uncompressedSize) {
				throw badRequest('WebGL ZIP entry size changed during decode validation');
			}
		}
		if (seen.size !== layout.files.size) {
			throw badRequest('WebGL ZIP preflight did not produce every validated file');
		}
	} finally {
		zip.close();
	}
}

/**
 * Fully decode every protected archive entry before the first public write,
 * then stream the same immutable local archive into the public bucket.
 */
export async function uploadWebglArchive(
	archivePath: string,
	publicBucket: string,
	sitePrefix: string,
	layout: WebglArchiveLayout,
	upload: ObjectStorage['upload'],
	onUploaded?: (key: string) => void,
): Promise<string[]> {
	await assertEveryEntryDecodes(archivePath, layout);
	const zip = await openArchive(archivePath);
	const uploadedKeys: string[] = [];
	const seen = new Set<string>();

	try {
		const iterator = zip.eachEntry()[Symbol.asyncIterator]();
		while (true) {
			let next: IteratorResult<Entry>;
			try {
				next = await iterator.next();
			} catch (error) {
				throw deterministicArchiveError(error);
			}
			if (next.done) break;
			const entry = next.value;
			const hosted = resolveHostedEntry(entry, layout, seen);
			if (!hosted) continue;
			const stream = await openEntryStream(zip, entry);
			let decodeError: unknown;
			stream.once('error', (error) => {
				if (isDeterministicArchiveDecodeError(error)) decodeError = error;
			});
			const key = `${sitePrefix}${hosted.hostedPath}`;
			const metadata = webglContentMetadata(hosted.hostedPath);
			try {
				await upload(
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
			} catch (error) {
				if (decodeError) throw deterministicArchiveError(decodeError);
				throw error;
			}
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
