import { posix as pathPosix } from 'node:path';
import type { Readable } from 'node:stream';
import yauzl, { type Entry } from 'yauzl';
import { badRequest } from '../../shared/errors.js';
import type { BoundedZipValidationSummary } from '../archive/bounded-zip-validator.js';
import type { ZipValidationSummary } from '../assets/upload/zip-validation.js';
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
export function analyzeWebglArchive(
	summary: BoundedZipValidationSummary | ZipValidationSummary,
): WebglArchiveLayout {
	if ('profile' in summary && summary.profile !== 'WEBGL') {
		throw new Error('WebGL layout requires the WEBGL ZIP policy');
	}
	for (const entry of summary.entries) {
		if ('versionMadeBy' in entry && ((entry.versionMadeBy >>> 8) & 0xff) === 3) {
			const fileType = (entry.externalFileAttributes >>> 16) & 0o170000;
			if (fileType === 0o120000) throw badRequest('Symbolic links are not allowed in WebGL ZIP files');
			if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
				throw badRequest('WebGL ZIP contains an unsupported filesystem entry');
			}
		}
	}
	const files = summary.entries
		.filter((entry) => !entry.isDirectory)
		.map((entry) => ({ path: 'path' in entry ? entry.path : entry.fileName }));
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
		signal?: AbortSignal;
	}): Promise<void>;
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
