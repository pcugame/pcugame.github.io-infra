import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	CreateMultipartUploadCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	UploadPartCommand,
} from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import type { ObjectStorage } from '../application/ports.js';

function storageErrorMatches(error: unknown, names: readonly string[], statusCode?: number): boolean {
	if (!error || typeof error !== 'object') return false;
	const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
	return (typeof candidate.name === 'string' && names.includes(candidate.name))
		|| (statusCode !== undefined && candidate.$metadata?.httpStatusCode === statusCode);
}

/** Bind every object operation to the S3 client owned by one BackendContext. */
export function createObjectStorage(
	client: S3Client,
	options: { defaultPresignTtlSec: number },
): ObjectStorage {
	return {
		async upload(bucket, key, body, contentType, contentLength, uploadOptions = {}) {
			await client.send(new PutObjectCommand({
				Bucket: bucket,
				Key: key,
				Body: body,
				ContentType: uploadOptions.contentType ?? contentType,
				...(uploadOptions.contentDisposition && {
					ContentDisposition: uploadOptions.contentDisposition,
				}),
				...(uploadOptions.contentEncoding && { ContentEncoding: uploadOptions.contentEncoding }),
				...(uploadOptions.cacheControl && { CacheControl: uploadOptions.cacheControl }),
				...(contentLength != null && { ContentLength: contentLength }),
			}));
		},
		async presign(bucket, key, presignOptions = {}) {
			return getSignedUrl(client, new GetObjectCommand({
				Bucket: bucket,
				Key: key,
				...(presignOptions.responseContentDisposition && {
					ResponseContentDisposition: presignOptions.responseContentDisposition,
				}),
			}), { expiresIn: presignOptions.ttlSec ?? options.defaultPresignTtlSec });
		},
		async delete(bucket, key) {
			await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
		},
		async head(bucket, key) {
			try {
				const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
				return {
					size: response.ContentLength ?? 0,
					contentType: response.ContentType ?? 'application/octet-stream',
				};
			} catch (error) {
				if (storageErrorMatches(error, ['NotFound'], 404)) return null;
				throw error;
			}
		},
		async readRange(bucket, key, start, end) {
			const response = await client.send(new GetObjectCommand({
				Bucket: bucket,
				Key: key,
				Range: `bytes=${start}-${end}`,
			}));
			const chunks: Buffer[] = [];
			for await (const chunk of response.Body as Readable) chunks.push(Buffer.from(chunk));
			return Buffer.concat(chunks);
		},
		async stream(bucket, key, range, signal) {
			try {
				const response = await client.send(new GetObjectCommand({
					Bucket: bucket,
					Key: key,
					...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
				}), { abortSignal: signal });
				return {
					body: response.Body as Readable,
					size: response.ContentLength ?? 0,
					contentType: response.ContentType ?? 'application/octet-stream',
					contentEncoding: response.ContentEncoding,
					cacheControl: response.CacheControl,
					etag: response.ETag,
					lastModified: response.LastModified,
					contentRange: response.ContentRange,
				};
			} catch (error) {
				if (storageErrorMatches(error, ['NoSuchKey', 'NotFound'], 404)) return null;
				throw error;
			}
		},
		async listKeys(bucket, prefix) {
			const keys: string[] = [];
			let continuationToken: string | undefined;
			do {
				const page = await client.send(new ListObjectsV2Command({
					Bucket: bucket,
					Prefix: prefix,
					ContinuationToken: continuationToken,
				}));
				for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
				continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
			} while (continuationToken);
			return keys;
		},
		async createMultipart(bucket, key, contentType = 'application/zip', uploadOptions = {}) {
			const response = await client.send(new CreateMultipartUploadCommand({
				Bucket: bucket,
				Key: key,
				ContentType: uploadOptions.contentType ?? contentType,
				...(uploadOptions.contentDisposition && {
					ContentDisposition: uploadOptions.contentDisposition,
				}),
				...(uploadOptions.cacheControl && { CacheControl: uploadOptions.cacheControl }),
			}));
			if (!response.UploadId) throw new Error('S3 CreateMultipartUpload returned no UploadId');
			return response.UploadId;
		},
		async uploadPart(bucket, key, uploadId, partNumber, body, contentLength) {
			const response = await client.send(new UploadPartCommand({
				Bucket: bucket,
				Key: key,
				UploadId: uploadId,
				PartNumber: partNumber,
				Body: body,
				ContentLength: contentLength,
			}));
			if (!response.ETag) throw new Error('S3 UploadPart returned no ETag');
			return response.ETag;
		},
		async completeMultipart(bucket, key, uploadId, parts) {
			await client.send(new CompleteMultipartUploadCommand({
				Bucket: bucket,
				Key: key,
				UploadId: uploadId,
				MultipartUpload: {
					Parts: [...parts]
						.sort((a, b) => a.partNumber - b.partNumber)
						.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
				},
			}));
		},
		async abortMultipart(bucket, key, uploadId) {
			try {
				await client.send(new AbortMultipartUploadCommand({
					Bucket: bucket,
					Key: key,
					UploadId: uploadId,
				}));
			} catch (error) {
				if (!storageErrorMatches(error, ['NoSuchUpload'])) throw error;
			}
		},
	};
}
