import { createWriteStream, promises as fsp } from 'node:fs';
import { pipeline as streamPipeline } from 'node:stream/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import type { AssetKind } from '../../../generated/prisma/client.js';
import { bucketForKind } from '../../../lib/s3.js';
import { safeDeleteObject } from '../../../lib/storage.js';
import { badRequest, payloadTooLarge } from '../../../shared/errors.js';
import {
	acquireUploadSlot,
	createKindAwareByteLimiter,
	getUploadLimits,
	kindLimitForMime,
	releaseUploadSlot,
} from '../../../shared/upload-limits.js';
import { detectFileType } from '../../../shared/file-signature.js';
import { UploadPipeline } from '../../assets/upload/index.js';
import { assetUrl } from './serializer.js';
import * as repo from './repository.js';

export function isReplaceableAssetKind(kind: AssetKind): boolean {
	return kind === 'GAME';
}

/**
 * Add a single asset to an existing project via multipart upload.
 * Handles GAME asset replacement logic.
 */
export async function addAssetToProject(
	projectId: number,
	request: { parts(): AsyncIterable<any>; currentUser: { role: string } },
) {
	const limits = getUploadLimits(request.currentUser.role as any);
	const pipeline = new UploadPipeline();

	acquireUploadSlot();
	try {
		let kind: AssetKind | null = null;
		let fileTmpPath: string | null = null;
		let fileOriginalName = '';

		const { AssetKindEnum } = await import('../../../shared/validation.js');
		const parts = request.parts();
		for await (const part of parts as AsyncIterable<any>) {
			if (part.type === 'field' && part.fieldname === 'kind') {
				const parsed = AssetKindEnum.safeParse(part.value);
				if (!parsed.success) throw badRequest(`Invalid asset kind: ${part.value}`);
				kind = parsed.data;
			} else if (part.type === 'file' && part.fieldname === 'file') {
				if (!kind) {
					throw badRequest('Asset kind must be provided before file');
				}
				const tmpPath = path.join(os.tmpdir(), crypto.randomUUID());
				pipeline.trackTempFile(tmpPath);

				const limiter = createKindAwareByteLimiter(limits, kind, part.filename ?? 'file');
				await streamPipeline(part.file, limiter, createWriteStream(tmpPath));
				fileTmpPath = tmpPath;
				fileOriginalName = part.filename ?? '';
			}
		}

		if (!kind) throw badRequest('Missing asset kind');
		if (!fileTmpPath) throw badRequest('No file provided');

		// Post-collection size check: now that kind and file type are known,
		// verify against the exact role/type limit.
		const headerBuf = Buffer.alloc(16);
		const fd = await fsp.open(fileTmpPath, 'r');
		await fd.read(headerBuf, 0, 16, 0);
		await fd.close();
		const fileType = detectFileType(headerBuf);
		const exactLimit = kindLimitForMime(limits, kind, fileType?.mime);
		const fileStat = await fsp.stat(fileTmpPath);
		if (fileStat.size > exactLimit) {
			const limitMB = Math.round(exactLimit / 1024 / 1024);
			throw payloadTooLarge(`File exceeds ${kind} size limit of ${limitMB}MB`);
		}

		const savedFile = await pipeline.processFile(fileTmpPath, kind, fileOriginalName);

		// Replace existing GAME asset if uploading a new one. Other kinds, including VIDEO, always create.
		// DB write goes first — deletes of the prior S3 object happen only after commit so a mid-
		// flight failure can't leave the project pointing at a storageKey we already deleted.
		const isReplaceable = isReplaceableAssetKind(savedFile.kind);
		let assetId: number;
		let oldStorageKey: string | null = null;
		let oldPlaybackStorageKey: string | null = null;

		if (isReplaceable) {
			const result = await repo.replaceOrCreateReplaceableAsset(projectId, savedFile.kind, {
				storageKey: savedFile.storageKey,
				playbackStorageKey: savedFile.playbackStorageKey ?? null,
				originalName: savedFile.originalName,
				mimeType: savedFile.mimeType,
				playbackMimeType: savedFile.playbackMimeType ?? '',
				sizeBytes: BigInt(savedFile.sizeBytes),
				playbackSizeBytes: BigInt(savedFile.playbackSizeBytes ?? 0),
				playbackStatus: savedFile.playbackStatus,
				playbackError: savedFile.playbackError,
				isPublic: false,
			});
			assetId = result.assetId;
			oldStorageKey = result.oldStorageKey;
			oldPlaybackStorageKey = result.oldPlaybackStorageKey;
		} else {
			const asset = await repo.createAsset({
				projectId,
				kind: savedFile.kind,
				storageKey: savedFile.storageKey,
				playbackStorageKey: savedFile.playbackStorageKey ?? null,
				originalName: savedFile.originalName,
				mimeType: savedFile.mimeType,
				playbackMimeType: savedFile.playbackMimeType ?? '',
				sizeBytes: BigInt(savedFile.sizeBytes),
				playbackSizeBytes: BigInt(savedFile.playbackSizeBytes ?? 0),
				playbackStatus: savedFile.playbackStatus,
				playbackError: savedFile.playbackError,
				isPublic: savedFile.kind !== 'VIDEO',
			});
			assetId = asset.id;
		}

		if (oldStorageKey) {
			await safeDeleteObject(bucketForKind(savedFile.kind), oldStorageKey, 'project-asset-replace-previous', { assetId, kind: savedFile.kind });
		}
		if (oldPlaybackStorageKey) {
			await safeDeleteObject(bucketForKind(savedFile.kind), oldPlaybackStorageKey, 'project-asset-replace-previous-playback', { assetId, kind: savedFile.kind });
		}

		return { assetId, url: assetUrl(savedFile.storageKey, savedFile.kind) };
	} catch (err) {
		await pipeline.rollbackCommitted();
		throw err;
	} finally {
		releaseUploadSlot();
		await pipeline.cleanupTemp();
	}
}
