import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
	CopyObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	type S3Client,
} from '@aws-sdk/client-s3';
import { createBoundedImageCommandRunner } from '../modules/image/command-runner.js';
import { createImageOperations } from '../modules/image/operations.js';
import { DEFAULT_IMAGE_WORKER_LIMITS, type ImageWorkerLimits } from '../modules/image/policy.js';
import type {
	CanonicalImageRepair,
	CanonicalObjectCopy,
	CanonicalObjectMaterializer,
	CanonicalRepresentationPlan,
	CanonicalWebglSourceCopy,
	CanonicalMaterializationHooks,
	ObjectHeadRecord,
} from '../modules/migration/canonical-backfill.types.js';

function notFound(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false;
	const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
	return candidate.name === 'NotFound' || candidate.name === 'NoSuchKey' || candidate.$metadata?.httpStatusCode === 404;
}

function checksumHex(base64: string | undefined): string | undefined {
	if (!base64) return undefined;
	const bytes = Buffer.from(base64, 'base64');
	return bytes.length === 32 ? bytes.toString('hex') : undefined;
}

function copySource(bucket: string, key: string): string {
	return `${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function mime(value: string): string { return value.split(';', 1)[0]!.trim().toLowerCase(); }

async function assertWorkspaceBudget(root: string, maximumBytes: number): Promise<void> {
	let total = 0;
	for (const name of await readdir(root)) {
		const metadata = await lstat(join(root, name));
		if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('image repair workspace contains a non-regular file');
		total += metadata.size;
		if (!Number.isSafeInteger(total) || total > maximumBytes) throw new Error('image repair workspace exceeded its temp-disk budget');
	}
}

async function head(client: S3Client, bucket: string, key: string): Promise<ObjectHeadRecord | null> {
	try {
		const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }));
		if (!Number.isSafeInteger(result.ContentLength) || (result.ContentLength ?? -1) < 0) throw new Error('unsafe S3 Content-Length');
		return {
			size: BigInt(result.ContentLength!),
			mimeType: result.ContentType ?? 'application/octet-stream',
			...(result.ETag ? { etag: result.ETag } : {}),
			...(checksumHex(result.ChecksumSHA256) ? { checksumSha256: checksumHex(result.ChecksumSHA256) } : {}),
		};
	} catch (error) {
		if (notFound(error)) return null;
		throw error;
	}
}

async function objectSha256(client: S3Client, bucket: string, key: string, expectedSize: bigint): Promise<string> {
	const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
	if (!result.Body) throw new Error(`S3 GetObject returned no body for ${bucket}/${key}`);
	const hash = createHash('sha256');
	let bytes = 0n;
	for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
		const value = Buffer.from(chunk);
		bytes += BigInt(value.byteLength);
		if (bytes > expectedSize) throw new Error(`object exceeded HEAD size while hashing: ${bucket}/${key}`);
		hash.update(value);
	}
	if (bytes !== expectedSize) throw new Error(`object size changed while hashing: ${bucket}/${key}`);
	return hash.digest('hex');
}

function representation(
	role: 'CARD_480' | 'DISPLAY_960',
	bucket: string,
	objectKey: string,
	input: { mimeType: string; sizeBytes: number; checksumSha256: string; width: number; height: number },
	headRecord: ObjectHeadRecord,
): CanonicalRepresentationPlan {
	return {
		role, bucket, objectKey, mimeType: input.mimeType, sizeBytes: BigInt(input.sizeBytes),
		checksumAlgorithm: 'SHA256', checksum: input.checksumSha256,
		etag: headRecord.etag ?? null, sourceIdentityAlgorithm: 'MIGRATION_GENERATED_SHA256',
		sourceIdentity: input.checksumSha256, width: input.width, height: input.height,
	};
}

async function downloadBounded(
	client: S3Client,
	input: CanonicalImageRepair,
	path: string,
	maximumBytes: number,
): Promise<void> {
	if (input.sourceSizeBytes > BigInt(maximumBytes)) throw new Error('image repair source exceeds migration byte limit');
	const result = await client.send(new GetObjectCommand({ Bucket: input.sourceBucket, Key: input.sourceKey }));
	if (!result.Body) throw new Error('image repair source returned no body');
	let bytes = 0;
	const limiter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			bytes += chunk.byteLength;
			if (bytes > maximumBytes || BigInt(bytes) > input.sourceSizeBytes) callback(new Error('image repair source exceeded its declared bound'));
			else callback(null, chunk);
		},
	});
	await pipeline(Readable.from(result.Body as AsyncIterable<Uint8Array>), limiter, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
	if (BigInt(bytes) !== input.sourceSizeBytes) throw new Error('image repair source size changed during download');
}

export function createCanonicalObjectMaterializer(
	client: S3Client,
	options: { tempRoot: string; limits?: Partial<ImageWorkerLimits> },
): CanonicalObjectMaterializer {
	const limits = { ...DEFAULT_IMAGE_WORKER_LIMITS, ...options.limits };
	const operations = createImageOperations(createBoundedImageCommandRunner(), limits);
	const ensureExactCopy = async (
		copy: CanonicalObjectCopy | CanonicalWebglSourceCopy,
		hooks: CanonicalMaterializationHooks | undefined,
		reason: string,
		publication: boolean,
	) => {
		const source = await head(client, copy.sourceBucket, copy.sourceKey);
		if (!source || source.size !== copy.expected.size || mime(source.mimeType) !== mime(copy.expected.mimeType)) {
			throw new Error('canonical copy source no longer matches its verified snapshot');
		}
		let destination = await head(client, copy.destinationBucket, copy.destinationKey);
		if (!destination && source.size > 5n * 1024n * 1024n * 1024n) {
			throw new Error('canonical copy source exceeds the 5 GiB CopyObject limit; multipart copy is required');
		}
		const sourceChecksum = source.checksumSha256
			?? await objectSha256(client, copy.sourceBucket, copy.sourceKey, source.size);
		if (copy.expected.checksumSha256 && sourceChecksum !== copy.expected.checksumSha256.toLowerCase()) {
			throw new Error('canonical copy source checksum changed');
		}
		let created = false;
		if (!destination) {
			await hooks?.beforeCreate({
				bucket: copy.destinationBucket,
				objectKey: copy.destinationKey,
				reason,
			});
			await client.send(new CopyObjectCommand({
				Bucket: copy.destinationBucket,
				Key: copy.destinationKey,
				CopySource: copySource(copy.sourceBucket, copy.sourceKey),
				...(source.etag ? { CopySourceIfMatch: source.etag } : {}),
				ChecksumAlgorithm: 'SHA256',
				MetadataDirective: publication ? 'REPLACE' : 'COPY',
				...(publication ? {
					ContentType: source.mimeType,
					CacheControl: 'public, max-age=31536000, immutable',
				} : {}),
			}));
			created = true;
			destination = await head(client, copy.destinationBucket, copy.destinationKey);
		}
		if (!destination || destination.size !== source.size || mime(destination.mimeType) !== mime(source.mimeType)) {
			throw new Error('canonical copied destination HEAD does not match source');
		}
		const destinationChecksum = destination.checksumSha256
			?? await objectSha256(client, copy.destinationBucket, copy.destinationKey, destination.size);
		if (destinationChecksum !== sourceChecksum) throw new Error('canonical copied destination checksum mismatch');
		return { head: { ...destination, checksumSha256: destinationChecksum }, created };
	};
	return {
		ensureCanonicalObjectCopy(copy, hooks) {
			return ensureExactCopy(copy, hooks, 'canonical-backfill-object-copy-not-committed', true);
		},
		async ensureWebglSourceCopy(copy, hooks) {
			return ensureExactCopy(copy, hooks, 'canonical-backfill-webgl-source-copy-not-committed', false);
		},

		async ensureImageRenditions(repair, hooks) {
			const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
			const sourceMime = mime(repair.sourceMimeType);
			if (!allowed.has(sourceMime)) throw new Error(`unsupported image repair MIME: ${sourceMime}`);
			await mkdir(options.tempRoot, { recursive: true, mode: 0o700 });
			const workspace = await mkdtemp(join(options.tempRoot, 'canonical-image-repair-'));
			try {
				const sourcePath = join(workspace, 'source.bin');
				await downloadBounded(client, repair, sourcePath, limits.maxSourceBytes);
				await assertWorkspaceBudget(workspace, limits.maxTempBytes);
				let pdfRasterPath: string | undefined;
				if (sourceMime === 'application/pdf') {
					pdfRasterPath = join(workspace, 'pdf-first-page.png');
					await operations.renderPdfFirstPage(sourcePath, pdfRasterPath);
					await assertWorkspaceBudget(workspace, limits.maxTempBytes);
					await operations.inspectRaster(pdfRasterPath);
				} else {
					await operations.inspectRaster(sourcePath);
				}
				const outputs = await operations.createOutputs({
					sourcePath,
					sourceMimeType: sourceMime as 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf',
					...(pdfRasterPath ? { pdfRasterPath } : {}),
					outputDirectory: workspace,
				});
				await assertWorkspaceBudget(workspace, limits.maxTempBytes);
				let created = 0;
				let reused = 0;
				const representations: CanonicalRepresentationPlan[] = [];
				for (const target of repair.missing) {
					const output = outputs.find((candidate) => candidate.role === target.role);
					if (!output) throw new Error(`image operation omitted ${target.role}`);
					let destination = await head(client, repair.sourceBucket, target.objectKey);
					if (destination) {
						const remoteChecksum = destination.checksumSha256
							?? await objectSha256(client, repair.sourceBucket, target.objectKey, destination.size);
						if (destination.size !== BigInt(output.sizeBytes) || remoteChecksum !== output.checksumSha256
							|| mime(destination.mimeType) !== output.mimeType) {
							throw new Error(`existing rendition conflicts with generated ${target.role}`);
						}
						destination = { ...destination, checksumSha256: remoteChecksum };
						reused += 1;
					} else {
						await hooks?.beforeCreate({
							bucket: repair.sourceBucket,
							objectKey: target.objectKey,
							reason: `canonical-backfill-${target.role.toLowerCase()}-not-committed`,
						});
						await client.send(new PutObjectCommand({
							Bucket: repair.sourceBucket, Key: target.objectKey, Body: createReadStream(output.path),
							ContentLength: output.sizeBytes, ContentType: output.mimeType,
							CacheControl: 'public, max-age=31536000, immutable',
							ChecksumSHA256: Buffer.from(output.checksumSha256, 'hex').toString('base64'),
						}));
						destination = await head(client, repair.sourceBucket, target.objectKey);
						if (!destination || destination.size !== BigInt(output.sizeBytes)
							|| mime(destination.mimeType) !== output.mimeType) throw new Error(`uploaded rendition HEAD mismatch for ${target.role}`);
						const remoteChecksum = destination.checksumSha256
							?? await objectSha256(client, repair.sourceBucket, target.objectKey, destination.size);
						if (remoteChecksum !== output.checksumSha256) throw new Error(`uploaded rendition checksum mismatch for ${target.role}`);
						destination = { ...destination, checksumSha256: remoteChecksum };
						created += 1;
					}
					representations.push(representation(target.role, repair.sourceBucket, target.objectKey, output, destination));
				}
				return { representations, created, reused };
			} finally {
				await rm(workspace, { recursive: true, force: true });
			}
		},
	};
}
