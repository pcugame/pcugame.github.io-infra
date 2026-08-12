import type { AppLogger, ObjectStorage } from '../../application/ports.js';
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

function representationHeaders(metadata: PublicImageMetadata): Record<string, string> {
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
	async function loadMetadata(storageKey: string): Promise<{
		metadata: PublicImageMetadata;
		resolvedStorageKey: string;
	}> {
		const reference = await deps.repository.resolvePublicImage(storageKey);
		if (!reference) throw notFound('Image not found');

		const metadata = await deps.storage.head(deps.publicBucket, reference.storageKey);
		if (!metadata) {
			deps.logger.error(
				{ storageKey: reference.storageKey, bucket: deps.publicBucket },
				'Public image has a current database reference but no storage object',
			);
			throw notFound('Image not found');
		}
		return { metadata, resolvedStorageKey: reference.storageKey };
	}

	async function respond(
		method: 'GET' | 'HEAD',
		storageKey: string,
		headers: PublicImageRequestHeaders,
	): Promise<HttpResponseDescriptor> {
		const { metadata, resolvedStorageKey } = await loadMetadata(storageKey);
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

		const object = await deps.storage.stream(deps.publicBucket, resolvedStorageKey);
		if (!object) {
			deps.logger.error(
				{ storageKey: resolvedStorageKey, bucket: deps.publicBucket },
				'Public image disappeared after metadata resolution',
			);
			throw notFound('Image not found');
		}
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
			headers: responseHeaders,
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
