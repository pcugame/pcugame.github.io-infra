import { posix as pathPosix } from 'node:path';
import type {
	ObjectByteRange,
	ObjectStorage,
	ObjectStreamOutcome,
	ObjectStreamRequest,
	ObjectStreamResult,
} from '../../application/ports.js';
import { badRequest, notFound } from '../../shared/errors.js';
import {
	matchesConditionalGet,
	parseEntityTag,
	parseHttpDate,
	parseIfNoneMatch,
	serializeIfNoneMatch,
} from '../../shared/http-validators.js';
import type { HttpResponseDescriptor } from '../../shared/response-descriptor.js';
import { webglContentMetadata, webglContentSecurityPolicy } from '../webgl/content.js';
import { parseWebglEntryKey } from '../webgl/paths.js';

function parseRequestedRange(header: string | undefined): ObjectByteRange | null | 'invalid' {
	if (header === undefined) return null;
	if (header.includes(',')) return 'invalid';
	const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
	if (!match || (!match[1] && !match[2])) return 'invalid';
	try {
		if (!match[1]) return { kind: 'suffix', length: BigInt(match[2]!) };
		const start = BigInt(match[1]);
		if (!match[2]) return { kind: 'open', start };
		const end = BigInt(match[2]);
		return end < start ? 'invalid' : { kind: 'closed', start, end };
	} catch {
		return 'invalid';
	}
}

export function normalizeWebglRequestPath(requestedPath: string): string {
	const slashPath = requestedPath.replace(/\\/g, '/');
	if (
		!slashPath
		|| slashPath.startsWith('/')
		|| slashPath.includes('\0')
		|| slashPath.split('/').some((segment) => segment === '..' || segment === '.')
	) {
		throw badRequest('Invalid WebGL asset path');
	}
	const normalized = pathPosix.normalize(slashPath);
	if (normalized === '..' || normalized.startsWith('../')) {
		throw badRequest('Invalid WebGL asset path');
	}
	return normalized;
}

/**
 * Fastify's router may normalize encoded dot segments before wildcard params
 * are exposed. Inspect the original URL as well so traversal cannot turn into
 * an apparently harmless path inside the public deployment.
 */
export function assertSafeWebglRawUrl(rawUrl: string): void {
	let decodedPath = rawUrl.split('?', 1)[0] ?? '';
	try {
		for (let pass = 0; pass < 3; pass++) {
			const next = decodeURIComponent(decodedPath);
			if (next === decodedPath) break;
			decodedPath = next;
		}
	} catch {
		throw badRequest('Invalid WebGL asset path');
	}
	const slashPath = decodedPath.replace(/\\/g, '/');
	if (
		slashPath.includes('\0')
		|| slashPath.split('/').some((segment) => segment === '..' || segment === '.')
	) {
		throw badRequest('Invalid WebGL asset path');
	}
}

export interface PublicWebglConfig {
	apiPublicUrl: string;
	webPublicUrl: string;
	publicBucket: string;
}

export interface PublicWebglRepository {
	findPublicWebglProject(id: number): Promise<{ id: number; webglEntryKey: string } | null>;
}

export type PublicWebglStorage = Pick<ObjectStorage, 'head' | 'stream'>;

export interface PublicWebglRequestHeaders {
	range?: string;
	ifNoneMatch?: string;
	ifModifiedSince?: string;
	ifRange?: string;
}

interface ResolvedWebglObject {
	relativePath: string;
	storageKey: string;
}

interface ReadValidators {
	ifNoneMatch?: string;
	notModifiedEtagFallback?: string;
	ifModifiedSince?: Date;
}

type RepresentationPin = { ifMatch: string };

type ReadAttempt =
	| { kind: 'selected'; range: ObjectByteRange | null; pin?: RepresentationPin }
	| { kind: 'full-conditional' }
	| { kind: 'full-unconditional' };

/** Strictly parse the entire entity-tag list; partial lists are never applied. */
export function normalizeIfNoneMatch(value: string | undefined): string | undefined {
	const condition = parseIfNoneMatch(value);
	return condition ? serializeIfNoneMatch(condition) : undefined;
}

function selectValidators(headers: PublicWebglRequestHeaders): ReadValidators {
	// A syntactically invalid INM still suppresses IMS: it is a present INM field.
	if (headers.ifNoneMatch !== undefined) {
		const condition = parseIfNoneMatch(headers.ifNoneMatch);
		if (!condition) return {};
		return {
			ifNoneMatch: serializeIfNoneMatch(condition),
			...(condition.kind === 'tags' && condition.tags.length === 1
				? { notModifiedEtagFallback: condition.tags[0]!.value }
				: {}),
		};
	}
	const ifModifiedSince = parseHttpDate(headers.ifModifiedSince);
	return ifModifiedSince ? { ifModifiedSince } : {};
}

function ifRangeMatches(
	value: string | undefined,
	metadata: NonNullable<Awaited<ReturnType<ObjectStorage['head']>>>,
): boolean {
	if (value === undefined) return false;
	const tag = parseEntityTag(value);
	return !!tag && !tag.weak && metadata.etag === tag.value;
}

function isStrongIfRange(value: string | undefined): boolean {
	if (value === undefined) return false;
	const tag = parseEntityTag(value);
	return !!tag && !tag.weak;
}

function representationPin(
	metadata: NonNullable<Awaited<ReturnType<ObjectStorage['head']>>>,
): RepresentationPin | undefined {
	const tag = metadata.etag ? parseEntityTag(metadata.etag) : undefined;
	if (tag && !tag.weak) return { ifMatch: tag.value };
	return undefined;
}

function isOutcome(value: ObjectStreamOutcome | ObjectStreamResult | null): value is Exclude<ObjectStreamOutcome, ObjectStreamResult | null> {
	return value !== null && 'kind' in value;
}

export function webglSecurityHeaders(config: PublicWebglConfig): Pick<HttpResponseDescriptor, 'headers' | 'removeHeaders'> {
	return {
		removeHeaders: [
			'access-control-allow-credentials',
			'x-frame-options',
			'cross-origin-opener-policy',
		],
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, ETag, Last-Modified',
			'Cross-Origin-Resource-Policy': 'cross-origin',
			'Content-Security-Policy': webglContentSecurityPolicy(config.webPublicUrl, config.apiPublicUrl),
		},
	};
}

export function webglResponseHeaders(config: PublicWebglConfig, pathname: string): Pick<HttpResponseDescriptor, 'headers' | 'removeHeaders'> {
	const security = webglSecurityHeaders(config);
	const metadata = webglContentMetadata(pathname);
	return {
		...security,
		headers: {
			...security.headers,
			'Content-Type': metadata.contentType,
			'Cache-Control': metadata.cacheControl,
			...(metadata.contentEncoding ? { 'Content-Encoding': metadata.contentEncoding } : {}),
		},
	};
}

export function webglPreflightResponse(): HttpResponseDescriptor {
	return {
		status: 204,
		removeHeaders: ['access-control-allow-credentials'],
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
			'Access-Control-Allow-Headers': 'Range, Content-Type, If-None-Match, If-Modified-Since, If-Range',
			'Access-Control-Max-Age': '86400',
		},
	};
}

export function createPublicWebglService(deps: {
	config: PublicWebglConfig;
	repository: PublicWebglRepository;
	storage: PublicWebglStorage;
}) {
	async function resolve(projectId: number, requestedPath: string, rawUrl?: string): Promise<ResolvedWebglObject> {
		if (rawUrl) assertSafeWebglRawUrl(rawUrl);
		const relativePath = normalizeWebglRequestPath(requestedPath || 'index.html');
		const project = await deps.repository.findPublicWebglProject(projectId);
		if (!project) throw notFound('WebGL build not found');
		const deployment = parseWebglEntryKey(projectId, project.webglEntryKey);
		if (!deployment) throw notFound('WebGL build not found');
		const storageKey = `${deployment.sitePrefix}${relativePath}`;
		if (!storageKey.startsWith(deployment.sitePrefix)) throw badRequest('Invalid WebGL asset path');
		return { relativePath, storageKey };
	}

	function responseHeaders(relativePath: string) {
		return webglResponseHeaders(deps.config, relativePath);
	}

	function metadataHeaders(
		base: Pick<HttpResponseDescriptor, 'headers' | 'removeHeaders'>,
		metadata: { etag?: string; lastModified?: Date },
	): Record<string, string> {
		return {
			...base.headers,
			...(metadata.etag ? { ETag: metadata.etag } : {}),
			...(metadata.lastModified ? { 'Last-Modified': metadata.lastModified.toUTCString() } : {}),
		};
	}

	async function get(
		projectId: number,
		requestedPath: string,
		headers: PublicWebglRequestHeaders = {},
		rawUrl?: string,
	): Promise<HttpResponseDescriptor> {
		const resolved = await resolve(projectId, requestedPath, rawUrl);
		const base = responseHeaders(resolved.relativePath);
		const requestedRange = parseRequestedRange(headers.range);
		if (requestedRange === 'invalid') {
			const metadata = await deps.storage.head(deps.config.publicBucket, resolved.storageKey);
			if (!metadata) throw notFound('WebGL asset not found');
			if (matchesConditionalGet(headers, metadata)) {
				return { status: 304, ...base, headers: metadataHeaders(base, metadata) };
			}
			return {
				status: 416,
				...base,
				headers: { ...metadataHeaders(base, metadata), 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${metadata.size}` },
			};
		}

		const validators = selectValidators(headers);
		const hasValidators = validators.ifNoneMatch !== undefined || validators.ifModifiedSince !== undefined;
		let effectiveRange = requestedRange;
		let pin: RepresentationPin | undefined;
		if (requestedRange && headers.ifRange !== undefined) {
			if (!isStrongIfRange(headers.ifRange)) {
				// This storage contract cannot prove that Last-Modified is a strong
				// validator. Date, weak-tag, and invalid If-Range values therefore
				// mismatch without a metadata lookup and select the full representation.
				effectiveRange = null;
			} else {
				// A strong entity-tag If-Range needs current metadata. Evaluate ordinary
				// preconditions first, then still forward them on the selected GET
				// to prevent a change between this HEAD and that GET escaping them.
				const metadata = await deps.storage.head(deps.config.publicBucket, resolved.storageKey);
				if (!metadata) throw notFound('WebGL asset not found');
				if (matchesConditionalGet(headers, metadata)) {
					return { status: 304, ...base, headers: metadataHeaders(base, metadata) };
				}
				if (!ifRangeMatches(headers.ifRange, metadata)) {
					effectiveRange = null;
				} else {
					pin = representationPin(metadata);
					// Without representation metadata, a second request cannot safely
					// serve a range chosen from this HEAD response.
					if (!pin) effectiveRange = null;
				}
			}
		}

		let attempt: ReadAttempt = {
			kind: 'selected',
			range: effectiveRange,
			...(pin ? { pin } : {}),
		};
		let object: ObjectStreamResult | ObjectStreamOutcome;
		for (;;) {
			let request: ObjectStreamRequest | undefined;
			switch (attempt.kind) {
				case 'selected':
					request = !attempt.range && !hasValidators
						? undefined
						: {
							...(attempt.range ? { range: attempt.range } : {}),
							...validators,
							...(attempt.pin ? attempt.pin : {}),
						};
					break;
				case 'full-conditional':
					request = { ...validators };
					break;
				case 'full-unconditional':
					request = undefined;
					break;
			}
			object = await deps.storage.stream(deps.config.publicBucket, resolved.storageKey, request);
			if (!object) throw notFound('WebGL asset not found');
			if (!isOutcome(object)) break;

			if (object.kind === 'precondition-failed') {
				if (request === undefined) {
					throw new Error('Storage returned 412 for an unconditional request');
				}
				if (attempt.kind !== 'selected' || !attempt.range || !attempt.pin) {
					throw new Error('Storage returned 412 without a representation pin');
				}
				// The object changed after HEAD. Re-run the ordinary conditional
				// request against the new representation without a range or old pin.
				attempt = hasValidators
					? { kind: 'full-conditional' }
					: { kind: 'full-unconditional' };
				continue;
			}

			if (object.kind === 'not-modified') {
				if (request === undefined) {
					throw new Error('Storage returned 304 for an unconditional request');
				}
				if (!hasValidators) {
					throw new Error('Storage returned 304 without an ordinary validator');
				}
				// S3-compatible backends can omit all representation headers on a
				// 304. A proven single-tag fallback already supplies the ETag and
				// keeps the common conditional path to one object request.
				if (object.etag) {
					return { status: 304, ...base, headers: metadataHeaders(base, object) };
				}
				const metadata = await deps.storage.head(deps.config.publicBucket, resolved.storageKey);
				if (!metadata) throw notFound('WebGL asset not found');
				if (matchesConditionalGet(headers, metadata)) {
					return {
						status: 304,
						...base,
						headers: metadataHeaders(base, metadata),
					};
				}
				// The headerless 304 described an older representation. Re-evaluate
				// exactly once with no range, pin, or ordinary validator. A typed
				// conditional outcome from that request is a storage contract error.
				attempt = { kind: 'full-unconditional' };
				continue;
			}
			break;
		}

		if (isOutcome(object)) {
			if (object.kind !== 'range-not-satisfiable') {
				throw new Error('Unhandled storage outcome');
			}
			const contentRange = object.contentRange;
			let size = object.size;
			if (!contentRange && size === undefined) {
				const metadata = await deps.storage.head(deps.config.publicBucket, resolved.storageKey);
				if (!metadata) throw notFound('WebGL asset not found');
				size = metadata.size;
			}
			return {
				status: 416,
				...base,
				headers: {
					...metadataHeaders(base, object),
					'Accept-Ranges': 'bytes',
					...(contentRange ? { 'Content-Range': contentRange } : {}),
					...(!contentRange && size !== undefined
						? { 'Content-Range': `bytes */${size}` }
						: {}),
				},
			};
		}
		if (
			attempt.kind === 'full-unconditional'
			&& hasValidators
			&& matchesConditionalGet(headers, object)
		) {
			object.body.destroy();
			return { status: 304, ...base, headers: metadataHeaders(base, object) };
		}
		const servedRange = attempt.kind === 'selected' ? attempt.range : null;
		if (servedRange && !object.contentRange) {
			object.body.destroy();
			throw new Error('Storage returned a ranged object without Content-Range');
		}
		return {
			status: servedRange ? 206 : 200,
			...base,
			headers: {
				...metadataHeaders(base, object),
				'Accept-Ranges': 'bytes',
				'Content-Length': String(object.size),
				...(servedRange && object.contentRange ? { 'Content-Range': object.contentRange } : {}),
			},
			body: object.body,
		};
	}

	async function head(
		projectId: number,
		requestedPath: string,
		headers: PublicWebglRequestHeaders = {},
		rawUrl?: string,
	): Promise<HttpResponseDescriptor> {
		const resolved = await resolve(projectId, requestedPath, rawUrl);
		const metadata = await deps.storage.head(deps.config.publicBucket, resolved.storageKey);
		if (!metadata) throw notFound('WebGL asset not found');
		const base = responseHeaders(resolved.relativePath);
		if (matchesConditionalGet(headers, metadata)) {
			return { status: 304, ...base, headers: metadataHeaders(base, metadata) };
		}
		return {
			status: 200,
			...base,
			headers: {
				...metadataHeaders(base, metadata),
				'Accept-Ranges': 'bytes',
				'Content-Length': String(metadata.size),
			},
		};
	}

	return {
		securityHeaders: () => webglSecurityHeaders(deps.config),
		preflight: webglPreflightResponse,
		get,
		head,
		/** Compatibility entry point for direct service consumers. */
		stream: (projectId: number, requestedPath: string, rangeHeader: string | undefined, rawUrl?: string) => (
			get(projectId, requestedPath, { range: rangeHeader }, rawUrl)
		),
	};
}
