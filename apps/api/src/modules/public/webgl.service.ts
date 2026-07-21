import { posix as pathPosix } from 'node:path';
import { badRequest, notFound } from '../../shared/errors.js';
import type { HttpResponseDescriptor } from '../../shared/response-descriptor.js';
import type { ObjectStreamResult } from '../../application/ports.js';
import { webglContentMetadata, webglContentSecurityPolicy } from '../webgl/content.js';
import { parseWebglEntryKey } from '../webgl/paths.js';

export type ParsedByteRange = { start: number; end: number } | null | 'invalid';

export function parseSingleByteRange(header: string | undefined, size: number): ParsedByteRange {
	if (!header) return null;
	if (header.includes(',')) return 'invalid';
	const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
	if (!match || (!match[1] && !match[2])) return 'invalid';

	let start: number;
	let end: number;
	if (!match[1]) {
		const suffixLength = Number(match[2]);
		if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid';
		start = Math.max(0, size - suffixLength);
		end = size - 1;
	} else {
		start = Number(match[1]);
		end = match[2] ? Number(match[2]) : size - 1;
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 'invalid';
		end = Math.min(end, size - 1);
	}

	if (size <= 0 || start < 0 || start >= size || end < start) return 'invalid';
	return { start, end };
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

export interface PublicWebglConfig {
	apiPublicUrl: string;
	webPublicUrl: string;
	publicBucket: string;
}

export interface PublicWebglRepository {
	findPublicWebglProject(id: number): Promise<{ id: number; webglEntryKey: string } | null>;
}

export interface PublicWebglStorage {
	head(bucket: string, key: string): Promise<{ size: number; contentType: string } | null>;
	stream(
		bucket: string,
		key: string,
		range?: { start: number; end: number },
	): Promise<ObjectStreamResult | null>;
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
			'Access-Control-Allow-Headers': 'Range, Content-Type',
			'Access-Control-Max-Age': '86400',
		},
	};
}

export function createPublicWebglService(deps: {
	config: PublicWebglConfig;
	repository: PublicWebglRepository;
	storage: PublicWebglStorage;
}) {
	return {
		securityHeaders: () => webglSecurityHeaders(deps.config),
		preflight: webglPreflightResponse,
		async stream(
			projectId: number,
			requestedPath: string,
			rangeHeader: string | undefined,
		): Promise<HttpResponseDescriptor> {
			const project = await deps.repository.findPublicWebglProject(projectId);
			if (!project) throw notFound('WebGL build not found');
			const deployment = parseWebglEntryKey(projectId, project.webglEntryKey);
			if (!deployment) throw notFound('WebGL build not found');

			const relativePath = normalizeWebglRequestPath(requestedPath || 'index.html');
			const storageKey = `${deployment.sitePrefix}${relativePath}`;
			if (!storageKey.startsWith(deployment.sitePrefix)) throw badRequest('Invalid WebGL asset path');

			const head = await deps.storage.head(deps.config.publicBucket, storageKey);
			if (!head) throw notFound('WebGL asset not found');
			const range = parseSingleByteRange(rangeHeader, head.size);
			const responseHeaders = webglResponseHeaders(deps.config, relativePath);
			if (range === 'invalid') {
				return {
					status: 416,
					...responseHeaders,
					headers: {
						...responseHeaders.headers,
						'Accept-Ranges': 'bytes',
						'Content-Range': `bytes */${head.size}`,
					},
				};
			}

			const object = await deps.storage.stream(
				deps.config.publicBucket,
				storageKey,
				range ?? undefined,
			);
			if (!object) throw notFound('WebGL asset not found');

			return {
				status: range ? 206 : 200,
				...responseHeaders,
				headers: {
					...responseHeaders.headers,
					'Accept-Ranges': 'bytes',
					'Content-Length': String(object.size),
					...(object.etag ? { ETag: object.etag } : {}),
					...(object.lastModified ? { 'Last-Modified': object.lastModified.toUTCString() } : {}),
					...(range ? {
						'Content-Range': object.contentRange ?? `bytes ${range.start}-${range.end}/${head.size}`,
					} : {}),
				},
				body: object.body,
			};
		},
	};
}
