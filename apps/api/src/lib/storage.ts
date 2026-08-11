import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	CreateMultipartUploadCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListMultipartUploadsCommand,
	ListObjectsV2Command,
	ListPartsCommand,
	PutObjectCommand,
	UploadPartCommand,
} from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import type {
	ObjectStorage,
	StorageRequestOptions,
	StoredObject,
} from '../application/ports.js';

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
	const requestOptions = (request?: StorageRequestOptions) => ({
		...(request?.signal ? { abortSignal: request.signal } : {}),
		...(request?.requestTimeoutMs !== undefined
			? { requestTimeout: request.requestTimeoutMs }
			: {}),
	});

	async function listObjects(
		bucket: string,
		prefix: string,
		request?: StorageRequestOptions,
	): Promise<StoredObject[]> {
		const objects: StoredObject[] = [];
		let continuationToken: string | undefined;
		do {
			const page = await client.send(new ListObjectsV2Command({
				Bucket: bucket,
				Prefix: prefix,
				ContinuationToken: continuationToken,
			}), requestOptions(request));
			for (const object of page.Contents ?? []) {
				if (!object.Key) continue;
				objects.push({
					key: object.Key,
					...(object.LastModified ? { lastModified: object.LastModified } : {}),
					...(object.Size !== undefined ? { size: object.Size } : {}),
				});
			}
			continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
		} while (continuationToken);
		return objects;
	}

	return {
		async upload(bucket, key, body, contentType, contentLength, uploadOptions = {}, request) {
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
			}), requestOptions(request));
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
		async delete(bucket, key, request) {
			await client.send(
				new DeleteObjectCommand({ Bucket: bucket, Key: key }),
				requestOptions(request),
			);
		},
		async head(bucket, key, request) {
			try {
				const response = await client.send(
					new HeadObjectCommand({ Bucket: bucket, Key: key }),
					requestOptions(request),
				);
				return {
					size: response.ContentLength ?? 0,
					contentType: response.ContentType ?? 'application/octet-stream',
					...(response.LastModified ? { lastModified: response.LastModified } : {}),
				};
			} catch (error) {
				if (storageErrorMatches(error, ['NotFound'], 404)) return null;
				throw error;
			}
		},
		async readRange(bucket, key, start, end, request) {
			const response = await client.send(new GetObjectCommand({
				Bucket: bucket,
				Key: key,
				Range: `bytes=${start}-${end}`,
			}), requestOptions(request));
			const chunks: Buffer[] = [];
			for await (const chunk of response.Body as Readable) chunks.push(Buffer.from(chunk));
			return Buffer.concat(chunks);
		},
		async stream(bucket, key, range, request) {
			try {
				const response = await client.send(new GetObjectCommand({
					Bucket: bucket,
					Key: key,
					...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
				}), requestOptions(request));
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
		async listKeys(bucket, prefix, request) {
			return (await listObjects(bucket, prefix, request)).map(({ key }) => key);
		},
		listObjects,
		async createMultipart(bucket, key, contentType = 'application/zip', uploadOptions = {}, request) {
			const response = await client.send(new CreateMultipartUploadCommand({
				Bucket: bucket,
				Key: key,
				ContentType: uploadOptions.contentType ?? contentType,
				...(uploadOptions.contentDisposition && {
					ContentDisposition: uploadOptions.contentDisposition,
				}),
				...(uploadOptions.cacheControl && { CacheControl: uploadOptions.cacheControl }),
			}), requestOptions(request));
			if (!response.UploadId) throw new Error('S3 CreateMultipartUpload returned no UploadId');
			return response.UploadId;
		},
		async uploadPart(bucket, key, uploadId, partNumber, body, contentLength, request) {
			const response = await client.send(new UploadPartCommand({
				Bucket: bucket,
				Key: key,
				UploadId: uploadId,
				PartNumber: partNumber,
				Body: body,
				ContentLength: contentLength,
			}), requestOptions(request));
			if (!response.ETag) throw new Error('S3 UploadPart returned no ETag');
			return response.ETag;
		},
		async completeMultipart(bucket, key, uploadId, parts, request) {
			await client.send(new CompleteMultipartUploadCommand({
				Bucket: bucket,
				Key: key,
				UploadId: uploadId,
				MultipartUpload: {
					Parts: [...parts]
						.sort((a, b) => a.partNumber - b.partNumber)
						.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
				},
			}), requestOptions(request));
		},
		async abortMultipart(bucket, key, uploadId, request) {
			try {
				await client.send(new AbortMultipartUploadCommand({
					Bucket: bucket,
					Key: key,
					UploadId: uploadId,
				}), requestOptions(request));
			} catch (error) {
				if (!storageErrorMatches(error, ['NoSuchUpload'])) throw error;
			}
		},
		async listParts(bucket, key, uploadId, request) {
			const parts = [] as Array<{ partNumber: number; etag: string }>;
			let partNumberMarker: string | undefined;
			do {
				const page = await client.send(new ListPartsCommand({
					Bucket: bucket,
					Key: key,
					UploadId: uploadId,
					PartNumberMarker: partNumberMarker,
				}), requestOptions(request));
				for (const part of page.Parts ?? []) {
					if (part.PartNumber === undefined || !part.ETag) continue;
					parts.push({ partNumber: part.PartNumber, etag: part.ETag });
				}
				partNumberMarker = page.IsTruncated
					? page.NextPartNumberMarker
					: undefined;
			} while (partNumberMarker);
			return parts.sort((a, b) => a.partNumber - b.partNumber);
		},
		async listMultipartUploads(bucket, prefix, request) {
			const uploads = [] as Array<{ key: string; uploadId: string; initiated?: Date }>;
			let keyMarker: string | undefined;
			let uploadIdMarker: string | undefined;
			do {
				const page = await client.send(new ListMultipartUploadsCommand({
					Bucket: bucket,
					Prefix: prefix,
					KeyMarker: keyMarker,
					UploadIdMarker: uploadIdMarker,
				}), requestOptions(request));
				for (const upload of page.Uploads ?? []) {
					if (!upload.Key || !upload.UploadId) continue;
					uploads.push({
						key: upload.Key,
						uploadId: upload.UploadId,
						...(upload.Initiated ? { initiated: upload.Initiated } : {}),
					});
				}
				if (page.IsTruncated) {
					keyMarker = page.NextKeyMarker;
					uploadIdMarker = page.NextUploadIdMarker;
				} else {
					keyMarker = undefined;
					uploadIdMarker = undefined;
				}
			} while (keyMarker || uploadIdMarker);
			return uploads;
		},
	};
}
