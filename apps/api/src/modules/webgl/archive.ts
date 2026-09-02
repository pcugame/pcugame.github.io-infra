import { posix as pathPosix } from 'node:path';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import yauzl, { type Entry } from 'yauzl';
import { badRequest } from '../../shared/errors.js';
import type { BoundedZipValidationSummary } from '../archive/bounded-zip-validator.js';
import { webglContentMetadata } from './content.js';

function normalizedEntryName(fileName: string): string {
	const rawSegments = fileName.replace(/\\/g, '/').split('/');
	const normalized = pathPosix.normalize(rawSegments.join('/'));
	if (!normalized || normalized === '.' || normalized === '..'
		|| normalized.startsWith('../') || normalized.startsWith('/')
		|| normalized.includes('\0')
		|| rawSegments.some((segment) => segment === '.' || segment === '..')) {
		throw badRequest('WebGL ZIP contains an unsafe file path');
	}
	return normalized.replace(/^\.\//, '');
}

export interface WebglArchiveLayout {
	wrapperPrefix: string;
	/** Validated archive path -> public path. */
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

/** Apply Unity layout rules after the common validator fully decoded every entry. */
export function analyzeWebglArchive(summary: BoundedZipValidationSummary): WebglArchiveLayout {
	if (summary.profile !== 'WEBGL') {
		throw new Error('WebGL layout requires the WEBGL ZIP policy');
	}
	const files = summary.entries
		.filter((entry) => !entry.isDirectory)
		.map((entry) => ({ path: entry.path }));
	const indexes = files.filter(({ path }) => path === 'index.html' || path.endsWith('/index.html'));
	if (indexes.length === 0) throw badRequest('WebGL ZIP must contain index.html');
	if (indexes.length > 1) throw badRequest('WebGL ZIP must contain exactly one index.html');

	const indexName = indexes[0]!.path;
	let wrapperPrefix = '';
	if (indexName !== 'index.html') {
		const segments = indexName.split('/');
		if (segments.length !== 2 || !segments[0]) {
			throw badRequest('index.html must be at ZIP root or inside one wrapper folder');
		}
		wrapperPrefix = `${segments[0]}/`;
		if (files.some(({ path }) => !path.startsWith(wrapperPrefix))) {
			throw badRequest('All WebGL files must be inside the single wrapper folder');
		}
	}

	const mappings = new Map<string, string>();
	for (const entry of files) {
		const normalized = normalizedEntryName(entry.path);
		const hostedPath = wrapperPrefix ? normalized.slice(wrapperPrefix.length) : normalized;
		if (!hostedPath || hostedPath.startsWith('../')) {
			throw badRequest('WebGL ZIP contains an invalid hosted path');
		}
		mappings.set(normalized, hostedPath);
	}
	assertRequiredUnityArtifacts(mappings.values());
	return { wrapperPrefix, files: mappings };
}

function entryIsDirectory(entry: Entry): boolean {
	return entry.fileName.endsWith('/') || (entry.externalFileAttributes & 0x10) !== 0;
}

export interface WebglPublicObjectUploader {
	put(input: {
		bucket: string;
		objectKey: string;
		body: Readable;
		contentLength: number;
		contentType: string;
		contentEncoding?: string;
		cacheControl: string;
		checksumSha256: string;
		signal?: AbortSignal;
	}): Promise<void>;
}

async function hashEntry(zip: yauzl.ZipFile, entry: Entry, signal?: AbortSignal): Promise<string> {
	const hash = createHash('sha256');
	let size = 0;
	const body = await zip.openReadStreamPromise(entry);
	for await (const chunk of body) {
		throwIfAborted(signal);
		const bytes = Buffer.from(chunk);
		size += bytes.length;
		hash.update(bytes);
	}
	if (size !== entry.uncompressedSize) throw badRequest('WebGL ZIP entry size changed during publication staging');
	return hash.digest('hex');
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new Error('WebGL processing was aborted');
}

/** Publish a fully validated immutable archive, one bounded entry at a time. */
export async function uploadWebglArchive(input: {
	archivePath: string;
	publicBucket: string;
	publicPrefix: string;
	layout: WebglArchiveLayout;
	uploader: WebglPublicObjectUploader;
	signal?: AbortSignal;
}): Promise<string[]> {
	throwIfAborted(input.signal);
	const zip = await yauzl.openPromise(input.archivePath, {
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
			throwIfAborted(input.signal);
			if (entryIsDirectory(entry)) continue;
			const normalized = normalizedEntryName(entry.fileName);
			const hostedPath = input.layout.files.get(normalized);
			if (!hostedPath || seen.has(normalized)) {
				throw badRequest('WebGL ZIP contents changed after validation');
			}
			seen.add(normalized);
			if (entry.isEncrypted() || !entry.canDecodeFileData()) {
				throw badRequest('WebGL ZIP entry cannot be decoded');
			}
			const checksumSha256 = await hashEntry(zip, entry, input.signal);
			const body = await zip.openReadStreamPromise(entry);
			const objectKey = `${input.publicPrefix}${hostedPath}`;
			const metadata = webglContentMetadata(hostedPath);
			await input.uploader.put({
				bucket: input.publicBucket,
				objectKey,
				body,
				contentLength: entry.uncompressedSize,
				contentType: metadata.contentType,
				...(metadata.contentEncoding ? { contentEncoding: metadata.contentEncoding } : {}),
				cacheControl: metadata.cacheControl,
				checksumSha256,
				...(input.signal ? { signal: input.signal } : {}),
			});
			uploadedKeys.push(objectKey);
		}
		if (seen.size !== input.layout.files.size) {
			throw badRequest('WebGL ZIP publish did not produce every validated file');
		}
		return uploadedKeys;
	} finally {
		zip.close();
	}
}
