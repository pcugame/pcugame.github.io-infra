import type { AppLogger, ObjectStorage, ObjectStreamResult } from '../../application/ports.js';
import { notFound } from '../../shared/errors.js';
import type { HttpResponseDescriptor } from '../../shared/response-descriptor.js';
import { PUBLIC_IMAGE_CACHE_CONTROL } from '../../shared/responsive-image.js';

export interface PublicImageRepository {
	resolvePublicImage(storageKey: string): Promise<{ storageKey: string } | null>;
}

export interface PublicImageRequestHeaders {
	ifNoneMatch?: string;
	ifModifiedSince?: string;
}

export interface PublicImageServiceDependencies {
	publicBucket: string;
	repository: PublicImageRepository;
	storage: Pick<ObjectStorage, 'head' | 'stream'>;
	logger: Pick<AppLogger, 'error'>;
}

type PublicImageMetadata = NonNullable<Awaited<ReturnType<ObjectStorage['head']>>>;

function stripWeakPrefix(value: string): string {
	return value.trim().replace(/^W\//, '');
}

/** RFC 9110 If-None-Match comparison is weak for GET and HEAD. */
export function matchesIfNoneMatch(header: string | undefined, etag: string | undefined): boolean {
	if (!header) return false;
	if (header.trim() === '*') return true;
	if (!etag) return false;
	const normalizedEtag = stripWeakPrefix(etag);
	return header.split(',').some((candidate) => stripWeakPrefix(candidate) === normalizedEtag);
}

export function matchesIfModifiedSince(
	header: string | undefined,
	lastModified: Date | undefined,
): boolean {
	if (!header || !lastModified) return false;
	const since = Date.parse(header);
	if (Number.isNaN(since)) return false;
	// HTTP dates have second precision, while storage adapters may retain ms.
	return Math.floor(lastModified.getTime() / 1_000) <= Math.floor(since / 1_000);
}

function representationHeaders(
	metadata: PublicImageMetadata | ObjectStreamResult,
): Record<string, string> {
	return {
		'Cache-Control': PUBLIC_IMAGE_CACHE_CONTROL,
		'Content-Type': metadata.contentType,
		'Content-Length': String(metadata.size),
		...(metadata.etag ? { ETag: metadata.etag } : {}),
		...(metadata.lastModified
			? { 'Last-Modified': metadata.lastModified.toUTCString() }
			: {}),
	};
}

function isNotModified(
	headers: PublicImageRequestHeaders,
	metadata: PublicImageMetadata,
): boolean {
	// If-None-Match takes precedence; a present but non-matching validator must
	// not fall through to If-Modified-Since.
	if (headers.ifNoneMatch !== undefined) {
		return matchesIfNoneMatch(headers.ifNoneMatch, metadata.etag);
	}
	return matchesIfModifiedSince(headers.ifModifiedSince, metadata.lastModified);
}

export function createPublicImageService(deps: PublicImageServiceDependencies) {
	async function resolveStorageKey(storageKey: string): Promise<string> {
		const reference = await deps.repository.resolvePublicImage(storageKey);
		if (!reference) throw notFound('Image not found');
		return reference.storageKey;
	}

	async function loadMetadata(resolvedStorageKey: string): Promise<PublicImageMetadata> {
		const metadata = await deps.storage.head(deps.publicBucket, resolvedStorageKey);
		if (!metadata) {
			deps.logger.error(
				{ storageKey: resolvedStorageKey, bucket: deps.publicBucket },
				'Public image has a current database reference but no storage object',
			);
			throw notFound('Image not found');
		}
		return metadata;
	}

	async function streamObject(resolvedStorageKey: string): Promise<ObjectStreamResult> {
		const object = await deps.storage.stream(deps.publicBucket, resolvedStorageKey);
		if (!object) {
			deps.logger.error(
				{ storageKey: resolvedStorageKey, bucket: deps.publicBucket },
				'Public image has a current database reference but no storage object',
			);
			throw notFound('Image not found');
		}
		return object;
	}

	async function respond(
		method: 'GET' | 'HEAD',
		storageKey: string,
		headers: PublicImageRequestHeaders,
	): Promise<HttpResponseDescriptor> {
		const resolvedStorageKey = await resolveStorageKey(storageKey);
		const hasValidator = headers.ifNoneMatch !== undefined
			|| headers.ifModifiedSince !== undefined;
		if (method === 'GET' && !hasValidator) {
			const object = await streamObject(resolvedStorageKey);
			return {
				status: 200,
				headers: representationHeaders(object),
				body: object.body,
			};
		}

		const metadata = await loadMetadata(resolvedStorageKey);
		const responseHeaders = representationHeaders(metadata);
		if (isNotModified(headers, metadata)) {
			return {
				status: 304,
				headers: responseHeaders,
			};
		}
		if (method === 'HEAD') {
			return {
				status: 200,
				headers: responseHeaders,
			};
		}

		const object = await streamObject(resolvedStorageKey);
		if (object.size !== metadata.size || object.contentType !== metadata.contentType) {
			deps.logger.error(
				{
					storageKey: resolvedStorageKey,
					bucket: deps.publicBucket,
					headSize: metadata.size,
					streamSize: object.size,
					headContentType: metadata.contentType,
					streamContentType: object.contentType,
				},
				'Immutable public image metadata changed between HEAD and GET',
			);
			object.body.destroy();
			throw new Error('Immutable public image changed during streaming');
		}
		return {
			status: 200,
			headers: representationHeaders(object),
			body: object.body,
		};
	}

	return {
		get: (storageKey: string, headers: PublicImageRequestHeaders = {}) => (
			respond('GET', storageKey, headers)
		),
		head: (storageKey: string, headers: PublicImageRequestHeaders = {}) => (
			respond('HEAD', storageKey, headers)
		),
	};
}
