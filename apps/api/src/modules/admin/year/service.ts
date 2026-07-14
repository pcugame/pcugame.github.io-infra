import type { AdminExhibitionItem, CreateExhibitionRequest, UpdateExhibitionRequest } from '@pcu/contracts';
import { promises as fsp, createWriteStream } from 'node:fs';
import { pipeline as streamPipeline } from 'node:stream/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { env } from '../../../config/env.js';
import { bucketForKind } from '../../../lib/s3.js';
import { safeDeleteObject } from '../../../lib/storage.js';
import { notFound, conflict, badRequest, payloadTooLarge } from '../../../shared/errors.js';
import { SIZE_LIMITS } from '../../../shared/file-signature.js';
import { assertValidUploadFilename } from '../../../shared/filename-validation.js';
import {
	acquireUploadSlot,
	createByteLimiter,
	getUploadLimits,
	kindLimit,
	releaseUploadSlot,
} from '../../../shared/upload-limits.js';
import { UploadPipeline } from '../../assets/upload/index.js';
import * as repo from './repository.js';

function exhibitionPosterUrl(storageKey: string): string {
	return `${env().API_PUBLIC_URL}/api/public/exhibition-posters/${storageKey}`;
}

function serializeExhibition(e: Awaited<ReturnType<typeof repo.findAllExhibitions>>[number]): AdminExhibitionItem {
	return {
		id: e.id,
		year: e.year,
		title: e.title || undefined,
		isUploadEnabled: e.isUploadEnabled,
		sortOrder: e.sortOrder,
		projectCount: e._count.projects,
		posterUrl: e.posterStorageKey ? exhibitionPosterUrl(e.posterStorageKey) : undefined,
		posterOriginalName: e.posterOriginalName || undefined,
		posterSize: e.posterStorageKey ? Number(e.posterSizeBytes) : undefined,
	};
}

/** List all exhibitions with project counts, mapped to API shape */
export async function listExhibitions(): Promise<AdminExhibitionItem[]> {
	const exhibitions = await repo.findAllExhibitions();
	return exhibitions.map(serializeExhibition);
}

/** Create an exhibition after checking for duplicates */
export async function createExhibition(data: CreateExhibitionRequest) {
	const existing = await repo.findExhibitionByComposite(data.year, data.title || '');
	if (existing) throw conflict(`"${data.title || data.year}" 전시회가 이미 존재합니다`);

	const created = await repo.createExhibition(data);
	return { id: created.id, year: created.year };
}

/** Delete an exhibition by ID. Throws 404 if not found. */
export async function deleteExhibition(id: number) {
	const exhibition = await repo.findExhibitionByIdWithCount(id);
	if (!exhibition) throw notFound('Exhibition not found');

	await repo.deleteExhibition(id);

	if (exhibition.posterStorageKey) {
		await safeDeleteObject(
			bucketForKind('POSTER'),
			exhibition.posterStorageKey,
			'exhibition-delete-poster',
			{ exhibitionId: id },
		);
	}
}

/** Partial-update an exhibition. Throws 404 if not found. Returns updated shape. */
export async function updateExhibition(
	id: number,
	patch: UpdateExhibitionRequest,
): Promise<AdminExhibitionItem> {
	const exhibition = await repo.findExhibitionById(id);
	if (!exhibition) throw notFound('Exhibition not found');

	const updated = await repo.updateExhibition(id, {
		...(patch.title !== undefined ? { title: patch.title } : {}),
		...(patch.isUploadEnabled !== undefined ? { isUploadEnabled: patch.isUploadEnabled } : {}),
		...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
	});

	return {
		...serializeExhibition(updated),
	};
}

export async function replacePoster(
	id: number,
	request: { parts(): AsyncIterable<any>; currentUser: { role: string } },
): Promise<AdminExhibitionItem> {
	const existing = await repo.findExhibitionById(id);
	if (!existing) throw notFound('Exhibition not found');

	const limits = getUploadLimits(request.currentUser.role as any);
	const pipeline = new UploadPipeline();

	acquireUploadSlot();
	try {
		let tmpPath: string | null = null;
		let originalName = '';
		let fileCount = 0;

		for await (const part of request.parts() as AsyncIterable<any>) {
			if (part.type !== 'file') continue;
			if (part.fieldname !== 'poster') {
				throw badRequest('Multipart field must be poster');
			}
			fileCount++;
			if (fileCount > 1) throw badRequest('Only one poster file is allowed');
			const filename = part.filename ?? '';
			assertValidUploadFilename(filename);

			const nextTmpPath = path.join(os.tmpdir(), crypto.randomUUID());
			pipeline.trackTempFile(nextTmpPath);

			const posterStreamMax = Math.max(kindLimit(limits, 'POSTER'), SIZE_LIMITS.posterPdf);
			const limiter = createByteLimiter(posterStreamMax, filename);
			await streamPipeline(part.file, limiter, createWriteStream(nextTmpPath));
			tmpPath = nextTmpPath;
			originalName = filename;
		}

		if (!tmpPath) throw badRequest('No poster file provided');

		const stat = await fsp.stat(tmpPath);
		if (stat.size > limits.requestMaxBytes) {
			const limitMB = Math.round(limits.requestMaxBytes / 1024 / 1024);
			throw payloadTooLarge(`Total upload size exceeds ${limitMB}MB limit`);
		}

		const savedFile = await pipeline.processFile(tmpPath, 'POSTER', originalName);
		const result = await repo.replaceExhibitionPoster(id, {
			storageKey: savedFile.storageKey,
			originalName: savedFile.originalName,
			mimeType: savedFile.mimeType,
			sizeBytes: BigInt(savedFile.sizeBytes),
		});
		if (!result) throw notFound('Exhibition not found');

		if (result.oldStorageKey && result.oldStorageKey !== savedFile.storageKey) {
			await safeDeleteObject(
				bucketForKind('POSTER'),
				result.oldStorageKey,
				'exhibition-poster-replace-previous',
				{ exhibitionId: id },
			);
		}

		return serializeExhibition(result.updated);
	} catch (err) {
		await pipeline.rollbackCommitted();
		throw err;
	} finally {
		releaseUploadSlot();
		await pipeline.cleanupTemp();
	}
}

export async function deletePoster(id: number): Promise<void> {
	const result = await repo.clearExhibitionPoster(id);
	if (!result) throw notFound('Exhibition not found');

	if (result.oldStorageKey) {
		await safeDeleteObject(
			bucketForKind('POSTER'),
			result.oldStorageKey,
			'exhibition-poster-delete',
			{ exhibitionId: id },
		);
	}
}
