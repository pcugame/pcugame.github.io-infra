import {
	PutObjectCommand,
	GetObjectCommand,
	DeleteObjectCommand,
	HeadObjectCommand,
	CreateMultipartUploadCommand,
	UploadPartCommand,
	CompleteMultipartUploadCommand,
	AbortMultipartUploadCommand,
	ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { s3 } from './s3.js';
import { env } from '../config/env.js';

function storageErrorMatches(err: unknown, names: readonly string[], statusCode?: number): boolean {
	if (!err || typeof err !== 'object') return false;
	const candidate = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
	return (typeof candidate.name === 'string' && names.includes(candidate.name))
		|| (statusCode !== undefined && candidate.$metadata?.httpStatusCode === statusCode);
}

/* ── Simple object operations ─────────────────────────── */

export interface UploadObjectOptions {
	contentDisposition?: string;
	contentEncoding?: string;
	cacheControl?: string;
	contentType?: string;
}

export async function uploadFile(
	bucket: string,
	key: string,
	body: Buffer | Readable,
	contentType: string,
	contentLength?: number,
	options: UploadObjectOptions = {},
): Promise<void> {
	await s3().send(
		new PutObjectCommand({
			Bucket: bucket,
			Key: key,
			Body: body,
			ContentType: options.contentType ?? contentType,
			...(options.contentDisposition && { ContentDisposition: options.contentDisposition }),
			...(options.contentEncoding && { ContentEncoding: options.contentEncoding }),
			...(options.cacheControl && { CacheControl: options.cacheControl }),
			...(contentLength != null && { ContentLength: contentLength }),
		}),
	);
}

export async function getPresignedUrl(
	bucket: string,
	key: string,
	options: {
		ttlSec?: number;
		responseContentDisposition?: string;
	} = {},
): Promise<string> {
	const command = new GetObjectCommand({
		Bucket: bucket,
		Key: key,
		...(options.responseContentDisposition && {
			ResponseContentDisposition: options.responseContentDisposition,
		}),
	});
	return getSignedUrl(s3(), command, {
		expiresIn: options.ttlSec ?? env().S3_PRESIGN_TTL_SEC,
	});
}

export async function deleteObject(
	bucket: string,
	key: string,
): Promise<void> {
	await s3().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function headObject(
	bucket: string,
	key: string,
): Promise<{ size: number; contentType: string } | null> {
	try {
		const res = await s3().send(
			new HeadObjectCommand({ Bucket: bucket, Key: key }),
		);
		return {
			size: res.ContentLength ?? 0,
			contentType: res.ContentType ?? 'application/octet-stream',
		};
	} catch (err: unknown) {
		if (storageErrorMatches(err, ['NotFound'], 404)) {
			return null;
		}
		throw err;
	}
}

export async function readObjectRange(
	bucket: string,
	key: string,
	start: number,
	end: number,
): Promise<Buffer> {
	const res = await s3().send(
		new GetObjectCommand({
			Bucket: bucket,
			Key: key,
			Range: `bytes=${start}-${end}`,
		}),
	);
	const stream = res.Body as Readable;
	const chunks: Buffer[] = [];
	for await (const chunk of stream) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

export async function downloadObject(
	bucket: string,
	key: string,
	destPath: string,
): Promise<void> {
	const res = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
	await streamPipeline(res.Body as Readable, createWriteStream(destPath));
}

export interface ObjectStreamResult {
	body: Readable;
	size: number;
	contentType: string;
	contentEncoding?: string;
	cacheControl?: string;
	etag?: string;
	lastModified?: Date;
	contentRange?: string;
}

/** Read an object as a stream, optionally with a single byte range. */
export async function getObjectStream(
	bucket: string,
	key: string,
	range?: { start: number; end: number },
): Promise<ObjectStreamResult | null> {
	try {
		const res = await s3().send(new GetObjectCommand({
			Bucket: bucket,
			Key: key,
			...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
		}));
		return {
			body: res.Body as Readable,
			size: res.ContentLength ?? 0,
			contentType: res.ContentType ?? 'application/octet-stream',
			contentEncoding: res.ContentEncoding,
			cacheControl: res.CacheControl,
			etag: res.ETag,
			lastModified: res.LastModified,
			contentRange: res.ContentRange,
		};
	} catch (err: unknown) {
		if (storageErrorMatches(err, ['NoSuchKey', 'NotFound'], 404)) {
			return null;
		}
		throw err;
	}
}

/** List every key below a prefix. Pagination is handled internally. */
export async function listObjectKeys(bucket: string, prefix: string): Promise<string[]> {
	const keys: string[] = [];
	let continuationToken: string | undefined;
	do {
		const page = await s3().send(new ListObjectsV2Command({
			Bucket: bucket,
			Prefix: prefix,
			ContinuationToken: continuationToken,
		}));
		for (const object of page.Contents ?? []) {
			if (object.Key) keys.push(object.Key);
		}
		continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
	} while (continuationToken);
	return keys;
}

/* ── Multipart upload operations ──────────────────────── */

export async function createMultipartUpload(
	bucket: string,
	key: string,
	contentType = 'application/zip',
	options: UploadObjectOptions = {},
): Promise<string> {
	const res = await s3().send(
		new CreateMultipartUploadCommand({
			Bucket: bucket,
			Key: key,
			ContentType: options.contentType ?? contentType,
			...(options.contentDisposition && { ContentDisposition: options.contentDisposition }),
			...(options.cacheControl && { CacheControl: options.cacheControl }),
		}),
	);
	if (!res.UploadId) throw new Error('S3 CreateMultipartUpload returned no UploadId');
	return res.UploadId;
}

export async function uploadPart(
	bucket: string,
	key: string,
	uploadId: string,
	partNumber: number,
	body: Readable | Buffer,
	contentLength: number,
): Promise<string> {
	const res = await s3().send(
		new UploadPartCommand({
			Bucket: bucket,
			Key: key,
			UploadId: uploadId,
			PartNumber: partNumber,
			Body: body,
			ContentLength: contentLength,
		}),
	);
	if (!res.ETag) throw new Error('S3 UploadPart returned no ETag');
	return res.ETag;
}

export interface CompletedPart {
	partNumber: number;
	etag: string;
}

export async function completeMultipartUpload(
	bucket: string,
	key: string,
	uploadId: string,
	parts: CompletedPart[],
): Promise<void> {
	await s3().send(
		new CompleteMultipartUploadCommand({
			Bucket: bucket,
			Key: key,
			UploadId: uploadId,
			MultipartUpload: {
				Parts: parts
					.sort((a, b) => a.partNumber - b.partNumber)
					.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
			},
		}),
	);
}

export async function abortMultipartUpload(
	bucket: string,
	key: string,
	uploadId: string,
): Promise<void> {
	try {
		await s3().send(
			new AbortMultipartUploadCommand({
				Bucket: bucket,
				Key: key,
				UploadId: uploadId,
			}),
		);
	} catch (err: unknown) {
		// Ignore if upload doesn't exist (already completed or aborted)
		if (!storageErrorMatches(err, ['NoSuchUpload'])) throw err;
	}
}
