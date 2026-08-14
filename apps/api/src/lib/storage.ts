import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	CreateMultipartUploadCommand,
	DeleteObjectsCommand,
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

const MAX_S3_KEYS = 1_000;

/** S3 keys are compared by their UTF-8 binary/byte lexical ordering. */
function compareS3Keys(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function invalidBulkResponse(message: string): Error {
	return new Error(`S3 DeleteObjects protocol ambiguity: ${message}`);
}

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
					...(response.CacheControl ? { cacheControl: response.CacheControl } : {}),
					...(response.ETag ? { etag: response.ETag } : {}),
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
		async listKeyPage(bucket, prefix, pageOptions, request) {
			const { startAfter, maxKeys } = pageOptions;
			if (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > MAX_S3_KEYS) {
				throw new RangeError(`S3 list maxKeys must be an integer between 1 and ${MAX_S3_KEYS}`);
			}
			const response = await client.send(new ListObjectsV2Command({
				Bucket: bucket,
				Prefix: prefix,
				MaxKeys: maxKeys,
				...(startAfter !== undefined ? { StartAfter: startAfter } : {}),
			}), requestOptions(request));
			const keys: string[] = [];
			let previous: string | undefined;
			for (const object of response.Contents ?? []) {
				if (typeof object.Key !== 'string') {
					throw new Error('S3 ListObjectsV2 returned an object without a key');
				}
				if (!object.Key.startsWith(prefix)) {
					throw new Error('S3 ListObjectsV2 returned a key outside the requested prefix');
				}
				if (startAfter !== undefined && compareS3Keys(object.Key, startAfter) <= 0) {
					throw new Error('S3 ListObjectsV2 returned a key at or before StartAfter');
				}
				if (previous !== undefined && compareS3Keys(object.Key, previous) <= 0) {
					throw new Error('S3 ListObjectsV2 returned duplicate or non-ascending keys');
				}
				keys.push(object.Key);
				previous = object.Key;
			}
			if (response.IsTruncated && keys.length === 0) {
				throw new Error('S3 ListObjectsV2 returned an empty truncated page');
			}
			return { keys, isTruncated: response.IsTruncated === true };
		},
		async deleteKeys(bucket, keys, request) {
			if (keys.length < 1 || keys.length > MAX_S3_KEYS) {
				throw new RangeError(`S3 bulk delete requires between 1 and ${MAX_S3_KEYS} keys`);
			}
			const requested = new Set(keys);
			if (requested.size !== keys.length) throw new RangeError('S3 bulk delete keys must be distinct');
			const response = await client.send(new DeleteObjectsCommand({
				Bucket: bucket,
				Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: false },
			}), requestOptions(request));
			const accounted = new Map<string, 'deleted' | 'failure'>();
			const deleted: string[] = [];
			const failures: Array<{ key: string; code?: string; message?: string }> = [];
			const account = (key: unknown, outcome: 'deleted' | 'failure', code?: unknown, message?: unknown) => {
				if (typeof key !== 'string' || !requested.has(key)) throw invalidBulkResponse('unexpected response key');
				if (accounted.has(key)) throw invalidBulkResponse('duplicate or contradictory response key');
				accounted.set(key, outcome);
				if (outcome === 'deleted') deleted.push(key);
				else failures.push({ key, ...(typeof code === 'string' ? { code } : {}), ...(typeof message === 'string' ? { message } : {}) });
			};
			for (const item of response.Deleted ?? []) account(item.Key, 'deleted');
			for (const item of response.Errors ?? []) {
				account(item.Key, item.Code === 'NoSuchKey' ? 'deleted' : 'failure', item.Code, item.Message);
			}
			if (accounted.size !== keys.length) throw invalidBulkResponse('missing response key');
			return { deleted, failures };
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
