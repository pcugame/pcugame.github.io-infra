import { posix as pathPosix } from 'node:path';
import type { FastifyReply } from 'fastify';
import { env } from '../../config/env.js';
import { getObjectStream, headObject } from '../../lib/storage.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { webglContentMetadata, webglContentSecurityPolicy } from '../webgl/content.js';
import { parseWebglEntryKey } from '../webgl/paths.js';
import * as repo from './repository.js';

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

export function setWebglSecurityHeaders(reply: FastifyReply): void {
	const cfg = env();
	reply.removeHeader('access-control-allow-credentials');
	reply.removeHeader('x-frame-options');
	reply.removeHeader('cross-origin-opener-policy');
	reply.header('Access-Control-Allow-Origin', '*');
	reply.header('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range, ETag, Last-Modified');
	reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
	reply.header('Content-Security-Policy', webglContentSecurityPolicy(cfg.WEB_PUBLIC_URL, cfg.API_PUBLIC_URL));
}

export function setWebglResponseHeaders(reply: FastifyReply, pathname: string): void {
	setWebglSecurityHeaders(reply);
	const metadata = webglContentMetadata(pathname);
	reply.header('Content-Type', metadata.contentType);
	reply.header('Cache-Control', metadata.cacheControl);
	if (metadata.contentEncoding) reply.header('Content-Encoding', metadata.contentEncoding);
}

export function sendWebglPreflight(reply: FastifyReply): void {
	reply.removeHeader('access-control-allow-credentials');
	reply.header('Access-Control-Allow-Origin', '*');
	reply.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
	reply.header('Access-Control-Allow-Headers', 'Range, Content-Type');
	reply.header('Access-Control-Max-Age', '86400');
	reply.status(204).send();
}

export async function streamPublicWebgl(
	projectId: number,
	requestedPath: string,
	rangeHeader: string | undefined,
	reply: FastifyReply,
) {
	setWebglSecurityHeaders(reply);
	const project = await repo.findPublicWebglProject(projectId);
	if (!project) throw notFound('WebGL build not found');
	const deployment = parseWebglEntryKey(projectId, project.webglEntryKey);
	if (!deployment) throw notFound('WebGL build not found');

	const relativePath = normalizeWebglRequestPath(requestedPath || 'index.html');
	const storageKey = `${deployment.sitePrefix}${relativePath}`;
	if (!storageKey.startsWith(deployment.sitePrefix)) throw badRequest('Invalid WebGL asset path');

	const cfg = env();
	const head = await headObject(cfg.S3_BUCKET_PUBLIC, storageKey);
	if (!head) throw notFound('WebGL asset not found');
	const range = parseSingleByteRange(rangeHeader, head.size);
	if (range === 'invalid') {
		setWebglResponseHeaders(reply, relativePath);
		reply.header('Accept-Ranges', 'bytes');
		reply.header('Content-Range', `bytes */${head.size}`);
		return reply.status(416).send();
	}

	const object = await getObjectStream(
		cfg.S3_BUCKET_PUBLIC,
		storageKey,
		range ?? undefined,
	);
	if (!object) throw notFound('WebGL asset not found');

	setWebglResponseHeaders(reply, relativePath);
	reply.header('Accept-Ranges', 'bytes');
	reply.header('Content-Length', String(object.size));
	if (object.etag) reply.header('ETag', object.etag);
	if (object.lastModified) reply.header('Last-Modified', object.lastModified.toUTCString());
	if (range) {
		reply.header('Content-Range', object.contentRange ?? `bytes ${range.start}-${range.end}/${head.size}`);
		reply.status(206);
	}
	return reply.send(object.body);
}
