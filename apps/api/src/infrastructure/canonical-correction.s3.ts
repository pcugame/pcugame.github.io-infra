import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, HeadObjectCommand, ListMultipartUploadsCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { createCanonicalObjectMaterializer } from './canonical-object-migration.s3.js';
import { correctionAssetId, POSTER_CORRECTION_LIMITS } from '../modules/migration/canonical-correction.js';
import type { CorrectionItem, CorrectionManifest, CorrectionObjectStore, CorrectionOutput, CorrectionSource } from '../modules/migration/canonical-correction.types.js';
import { createBoundedCommandRunner } from '../modules/video/command-runner.js';
import { createFfmpegVideoOperations } from '../modules/video/ffmpeg-operations.js';
import { assertBrowserSafeOutput, assertSourceVideoPolicy, canRemuxVideo, DEFAULT_VIDEO_LIMITS, isBrowserSafeVideo } from '../modules/video/policy.js';
import type { LocalImageOutput } from '../modules/image/ports.js';
import { validateMaterialContent } from '../modules/asset-upload/material-validation.js';

const EXTENSIONS: Record<string, string> = {
	'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv',
	'video/x-msvideo': 'avi', 'video/avi': 'avi', 'video/x-ms-wmv': 'wmv', 'image/webp': 'webp',
	'image/jpeg': 'jpg', 'image/png': 'png', 'text/plain': 'txt', 'text/markdown': 'md', 'application/pdf': 'pdf',
	'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
	'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
	'application/vnd.ms-powerpoint': 'ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
	'application/vnd.oasis.opendocument.text': 'odt', 'application/vnd.oasis.opendocument.spreadsheet': 'ods',
	'application/vnd.oasis.opendocument.presentation': 'odp', 'application/rtf': 'rtf', 'text/rtf': 'rtf',
	'application/octet-stream': 'bin',
};
function mime(value: string): string { return value.split(';', 1)[0]!.trim().toLowerCase(); }
async function sha256(path: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest('hex');
}
function output(item: CorrectionItem, manifest: CorrectionManifest, role: CorrectionOutput['role'], input: {
	mimeType: string; sizeBytes: string; checksum: string; width?: number; height?: number;
}, operation: CorrectionOutput['provenance']['operation']): CorrectionOutput {
	const extension = EXTENSIONS[mime(input.mimeType)] ?? (item.targetKind === 'ATTACHMENT' ? 'bin' : undefined);
	if (!extension) throw new Error(`Unsupported canonical MIME: ${input.mimeType}`);
	const image = item.targetKind === 'POSTER';
	return { role, bucket: image ? manifest.publicBucket : manifest.protectedBucket,
		objectKey: `${image ? 'public/images' : 'protected/assets'}/${correctionAssetId(item)}/${role.toLowerCase()}/${input.checksum.slice(0, 32)}.${extension}`,
		mimeType: input.mimeType, sizeBytes: input.sizeBytes, checksumAlgorithm: 'SHA256', checksum: input.checksum, etag: null,
		sourceIdentityAlgorithm: operation === 'COPY' ? 'MIGRATION_COPY_SHA256' : 'MIGRATION_GENERATED_SHA256', sourceIdentity: input.checksum,
		width: input.width ?? null, height: input.height ?? null, provenance: { operation, sourceSha256: item.source.sha256 } };
}

export function createCanonicalCorrectionObjectStore(client: S3Client, options: { tempRoot: string }): CorrectionObjectStore {
	const runner = createBoundedCommandRunner();
	const video = createFfmpegVideoOperations(runner, DEFAULT_VIDEO_LIMITS);
	const copier = createCanonicalObjectMaterializer(client, options);
	async function verify(source: CorrectionSource): Promise<void> {
		const signal = AbortSignal.timeout(180_000);
		const head = await client.send(new HeadObjectCommand({ Bucket: source.bucket, Key: source.key }), { abortSignal: signal });
		if (BigInt(head.ContentLength ?? -1) !== BigInt(source.sizeBytes) || mime(head.ContentType ?? '') !== mime(source.mimeType)
			|| (source.etag && head.ETag?.replaceAll('"', '') !== source.etag.replaceAll('"', ''))) throw new Error(`Object HEAD changed: ${source.bucket}/${source.key}`);
		const uploads = await client.send(new ListMultipartUploadsCommand({ Bucket: source.bucket, Prefix: source.key, MaxUploads: 1000 }), { abortSignal: signal });
		if (uploads.IsTruncated || uploads.Uploads?.some((upload) => upload.Key === source.key)) throw new Error('Object has an active multipart upload');
		const object = await client.send(new GetObjectCommand({ Bucket: source.bucket, Key: source.key,
			...(head.ETag ? { IfMatch: head.ETag } : {}) }), { abortSignal: signal });
		if (!object.Body) throw new Error('Object GET returned no body');
		const hash = createHash('sha256');
		let bytes = 0n;
		for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
			bytes += BigInt(chunk.byteLength);
			if (bytes > BigInt(source.sizeBytes)) throw new Error('Object exceeded declared byte length');
			hash.update(chunk);
		}
		if (bytes !== BigInt(source.sizeBytes) || hash.digest('hex') !== source.sha256) throw new Error(`Object SHA-256 changed: ${source.bucket}/${source.key}`);
	}
	async function download(source: CorrectionSource, path: string, maximum: number): Promise<void> {
		if (BigInt(source.sizeBytes) > BigInt(maximum)) throw new Error('Source exceeds correction processing byte limit');
		const signal = AbortSignal.timeout(180_000);
		const object = await client.send(new GetObjectCommand({ Bucket: source.bucket, Key: source.key }), { abortSignal: signal });
		if (!object.Body) throw new Error('Object GET returned no body');
		let bytes = 0;
		const hash = createHash('sha256');
		const limiter = new Transform({ transform(chunk: Buffer, _encoding, done) {
			bytes += chunk.length;
			if (bytes > maximum || BigInt(bytes) > BigInt(source.sizeBytes)) done(new Error('Source exceeded byte limit'));
			else { hash.update(chunk); done(null, chunk); }
		} });
		await pipeline(Readable.from(object.Body as AsyncIterable<Uint8Array>), limiter, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal });
		if (String(bytes) !== source.sizeBytes || hash.digest('hex') !== source.sha256) throw new Error('Source changed during processing download');
	}
	async function put(path: string, target: CorrectionOutput): Promise<void> {
		let exists = false;
		try { await client.send(new HeadObjectCommand({ Bucket: target.bucket, Key: target.objectKey })); exists = true; }
		catch (error) { if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error; }
		if (!exists) await client.send(new PutObjectCommand({ Bucket: target.bucket, Key: target.objectKey, Body: createReadStream(path),
			ContentLength: Number(target.sizeBytes), ContentType: target.mimeType, IfNoneMatch: '*',
			ChecksumSHA256: Buffer.from(target.checksum!, 'hex').toString('base64'),
			...(target.bucket ? { ContentDisposition: 'attachment' } : {}),
		}));
		await verify({ bucket: target.bucket, key: target.objectKey, mimeType: target.mimeType,
			sizeBytes: target.sizeBytes, sha256: target.checksum!, etag: null });
	}
	return { verify, async prepare(item, manifest, hooks) {
		const original = output(item, manifest, 'ORIGINAL', { mimeType: item.source.mimeType, sizeBytes: item.source.sizeBytes, checksum: item.source.sha256 }, 'COPY');
		if (item.sourceAlias) {
			const representations = manifest.snapshots['representations'] as Array<Record<string, unknown>>;
			const existing = representations.find((r) => r['asset_id'] === item.assetId && r['role'] === 'ORIGINAL' && r['state'] === 'READY'
				&& r['checksum'] === item.source.sha256 && String(r['size_bytes']) === item.source.sizeBytes);
			if (!existing) throw new Error('Alias canonical ORIGINAL is not proven');
			original.objectKey = String(existing['object_key']); original.bucket = String(existing['bucket']);
			original.width = existing['width'] as number | null; original.height = existing['height'] as number | null;
		}
		await hooks.beforeCreate(original);
		const copy = await copier.ensureWebglSourceCopy({ sourceBucket: item.source.bucket, sourceKey: item.source.key,
			destinationBucket: original.bucket, destinationKey: original.objectKey,
			expected: { size: BigInt(item.source.sizeBytes), mimeType: item.source.mimeType, checksumSha256: item.source.sha256 } });
		original.etag = copy.head.etag ?? null;
		await hooks.afterCreate(original);
		if (item.sourceAlias) return [original];
		await mkdir(options.tempRoot, { recursive: true, mode: 0o700 });
		const workspace = await mkdtemp(join(options.tempRoot, 'canonical-correction-'));
		try {
			const sourcePath = join(workspace, 'source.bin');
			await download(item.source, sourcePath, item.targetKind === 'VIDEO' ? DEFAULT_VIDEO_LIMITS.maxSourceBytes : 100 * 1024 * 1024);
			if (item.targetKind === 'DOCUMENT' || item.targetKind === 'ATTACHMENT') {
				const trustedMime = await validateMaterialContent(item.targetKind, item.originalName, await readFile(sourcePath));
				if (item.targetKind === 'DOCUMENT' && mime(trustedMime) !== mime(item.source.mimeType)) throw new Error('Document content and source MIME do not match');
				return [original];
			}
			if (item.targetKind === 'VIDEO') {
				const probe = await video.probe(sourcePath);
				assertSourceVideoPolicy(probe, DEFAULT_VIDEO_LIMITS);
				await video.verifyDecode(sourcePath);
				original.width = probe.width; original.height = probe.height;
				const playbackPath = join(workspace, 'playback.mp4');
				let finalPath = sourcePath;
				if (!isBrowserSafeVideo(probe, DEFAULT_VIDEO_LIMITS)) {
					if (canRemuxVideo(probe, DEFAULT_VIDEO_LIMITS)) await video.remux(sourcePath, playbackPath, DEFAULT_VIDEO_LIMITS.maxPlaybackBytes);
					else await video.reencode(sourcePath, playbackPath, DEFAULT_VIDEO_LIMITS.maxPlaybackBytes);
					finalPath = playbackPath;
				}
				const playable = await video.probe(finalPath);
				assertBrowserSafeOutput(playable, DEFAULT_VIDEO_LIMITS);
				if (Math.abs(playable.durationSeconds - probe.durationSeconds) > Math.max(1, probe.durationSeconds * 0.01)) throw new Error('Playback was truncated');
				await video.verifyDecode(finalPath);
				const size = (await stat(finalPath)).size;
				if (size < 1 || size > DEFAULT_VIDEO_LIMITS.maxPlaybackBytes) throw new Error('Playback exceeded byte policy');
				const playback = output(item, manifest, 'PLAYBACK', { mimeType: 'video/mp4', sizeBytes: String(size), checksum: await sha256(finalPath),
					width: playable.width, height: playable.height }, 'VIDEO_PLAYBACK');
				await hooks.beforeCreate(playback); await put(finalPath, playback); await hooks.afterCreate(playback);
				return [original, playback];
			}
			if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime(item.source.mimeType))) throw new Error('Unsupported correction poster MIME');
			const requestPath = join(workspace, 'request.json');
			const responsePath = join(workspace, 'response.json');
			await writeFile(requestPath, JSON.stringify({ sourcePath, sourceMimeType: item.source.mimeType, outputDirectory: workspace }), { mode: 0o600 });
			const childPath = fileURLToPath(new URL(`../../scripts/correct-canonical-poster${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url));
			await runner.run({ file: process.execPath, args: [...(childPath.endsWith('.ts') ? ['--import', 'tsx'] : []), childPath, requestPath, responsePath],
				timeoutMs: POSTER_CORRECTION_LIMITS.timeoutMs, maxOutputBytes: 64 * 1024 });
			const images = JSON.parse(await readFile(responsePath, 'utf8')) as LocalImageOutput[];
			const originalImage = images.find((image) => image.role === 'ORIGINAL');
			if (!originalImage || originalImage.checksumSha256 !== item.source.sha256) throw new Error('Poster processing changed original bytes');
			original.width = originalImage.width; original.height = originalImage.height;
			const results = [original];
			for (const local of images.filter((image) => image.role !== 'ORIGINAL')) {
				const rendition = output(item, manifest, local.role, { mimeType: local.mimeType, sizeBytes: String(local.sizeBytes), checksum: local.checksumSha256,
					width: local.width, height: local.height }, 'IMAGE_RENDITION');
				await hooks.beforeCreate(rendition); await put(local.path, rendition); await hooks.afterCreate(rendition);
				results.push(rendition);
			}
			return results;
		} finally { await rm(workspace, { recursive: true, force: true }); }
	} };
}
