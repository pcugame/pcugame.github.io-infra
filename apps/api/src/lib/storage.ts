import {
	PutObjectCommand,
	GetObjectCommand,
	DeleteObjectCommand,
	HeadObjectCommand,
	CreateMultipartUploadCommand,
	UploadPartCommand,
	CompleteMultipartUploadCommand,
	AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { s3 } from './s3.js';
import { env } from '../config/env.js';

/* ── Simple object operations ─────────────────────────── */

export async function uploadFile(
	bucket: string,
	key: string,
	body: Buffer | Readable,
	contentType: string,
	contentLength?: number,
): Promise<void> {
	await s3().send(
		new PutObjectCommand({
			Bucket: bucket,
			Key: key,
			Body: body,
			ContentType: contentType,
			...(contentLength != null && { ContentLength: contentLength }),
		}),
	);
}

export async function getPresignedUrl(
	bucket: string,
	key: string,
	ttlSec?: number,
): Promise<string> {
	const command = new GetObjectCommand({ Bucket: bucket, Key: key });
	return getSignedUrl(s3(), command, {
		expiresIn: ttlSec ?? env().S3_PRESIGN_TTL_SEC,
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
	} catch (err: any) {
		if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
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

/* ── Multipart upload operations ──────────────────────── */

export async function createMultipartUpload(
	bucket: string,
	key: string,
	contentType = 'application/zip',
): Promise<string> {
	const res = await s3().send(
		new CreateMultipartUploadCommand({
			Bucket: bucket,
			Key: key,
			ContentType: contentType,
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
	} catch (err: any) {
		// Ignore if upload doesn't exist (already completed or aborted)
		if (err.name !== 'NoSuchUpload') throw err;
	}
}
