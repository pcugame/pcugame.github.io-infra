import { promises as fsp, createWriteStream } from 'node:fs';
import { pipeline as streamPipeline } from 'node:stream/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import type { AssetKind, ProjectStatus } from '@prisma/client';
import type { AdminProjectItem } from '@pcu/contracts';
import { env } from '../../../config/env.js';
import { badRequest, conflict, forbidden, isUniqueConstraintError, notFound, payloadTooLarge } from '../../../shared/errors.js';
import { bucketForKind } from '../../../lib/s3.js';
import { safeDeleteObject } from '../../../lib/storage.js';
import { toSlug } from '../../../shared/slug.js';
import { assertValidPosterAsset } from '../../../shared/poster-validation.js';
import { effectiveIsIncomplete } from '../../../shared/project-completeness.js';
import {
	getUploadLimits,
	kindLimit,
	fieldnameToKind,
	createByteLimiter,
	acquireUploadSlot,
	releaseUploadSlot,
} from '../../../shared/upload-limits.js';
import { detectFileType, SIZE_LIMITS } from '../../../shared/file-signature.js';
import { UploadPipeline } from '../../assets/upload/index.js';
import type { SavedFile } from '../../assets/upload/index.js';
import { assertUploadAllowed } from '../upload-guard.js';
import { assetUrl, serializeProjectDetail } from './serializer.js';
import * as repo from './repository.js';

export { assetUrl, serializeProjectDetail } from './serializer.js';
export { assertStatusTransition, bulkUpdateStatus } from './project-status.service.js';

async function deleteAssetObjects(asset: { id: number; projectId?: number; kind: AssetKind; storageKey: string; playbackStorageKey: string | null }, reason: string) {
	const bucket = bucketForKind(asset.kind);
	await safeDeleteObject(bucket, asset.storageKey, reason, { assetId: asset.id, projectId: asset.projectId });
	if (asset.playbackStorageKey && asset.playbackStorageKey !== asset.storageKey) {
		await safeDeleteObject(bucket, asset.playbackStorageKey, `${reason}-playback`, { assetId: asset.id, projectId: asset.projectId });
	}
}

export function isReplaceableAssetKind(kind: AssetKind): boolean {
	return kind === 'GAME';
}

// ── Business logic ──────────────────────────────────────────

/** List projects visible to the current user */
export async function listProjects(userId: number, userRole: string): Promise<AdminProjectItem[]> {
	const isPrivileged = userRole === 'ADMIN' || userRole === 'OPERATOR';
	const projects = await repo.findProjectsForUser(userId, isPrivileged);
	return projects.map((p) => ({
		id: p.id,
		title: p.title,
		slug: p.slug,
		year: p.exhibition.year,
		isIncomplete: effectiveIsIncomplete(p.isIncomplete, p.assets, p.poster),
		status: p.status,
		createdByUserName: p.creator.name || undefined,
		memberNames: p.members.map((m) => m.name),
		updatedAt: p.updatedAt.toISOString(),
	}));
}

/** Get a single project detail with access check for read */
export async function getProjectDetail(projectId: number, userId: number, userRole: string) {
	const project = await repo.findProjectById(projectId);
	if (!project) throw notFound('Project not found');

	if (userRole !== 'ADMIN' && userRole !== 'OPERATOR' && project.creatorId !== userId) {
		const isMember = !!(await repo.isMemberOfProject(project.id, userId));
		if (!isMember) throw forbidden('Not your project');
	}

	return serializeProjectDetail(project);
}

/** Partial-update a project */
export async function updateProject(
	projectId: number,
	patch: {
		title?: string; summary?: string; description?: string;
		isIncomplete?: boolean; status?: ProjectStatus; sortOrder?: number;
	},
) {
	const updated = await repo.updateProject(projectId, {
		...(patch.title !== undefined ? { title: patch.title } : {}),
		...(patch.summary !== undefined ? { summary: patch.summary } : {}),
		...(patch.description !== undefined ? { description: patch.description } : {}),
		...(patch.isIncomplete !== undefined ? { isIncomplete: patch.isIncomplete } : {}),
		...(patch.status !== undefined ? { status: patch.status } : {}),
		...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
	});

	return serializeProjectDetail(updated);
}

/** Delete a project and its associated asset files from S3 */
export async function deleteProject(projectId: number) {
	const assets = await repo.findAssetsByProjectId(projectId);
	await Promise.all(
		assets.map((asset) => deleteAssetObjects({ ...asset, projectId }, 'project-delete')),
	);
	await repo.deleteProject(projectId);
}

/** Generate a unique slug for a project within an exhibition */
async function generateUniqueSlug(exhibitionId: number, title: string): Promise<string> {
	const baseSlug = toSlug(title);
	let slug = baseSlug;
	let attempt = 0;
	while (await repo.findProjectByExhibitionAndSlug(exhibitionId, slug)) {
		attempt++;
		slug = `${baseSlug}-${attempt}`;
	}
	return slug;
}

/** Next candidate in the `-1`, `-2`, ... series used when we lose the slug race. */
function nextSlugCandidate(baseSlug: string, attempt: number): string {
	return attempt === 0 ? baseSlug : `${baseSlug}-${attempt}`;
}

/** Multipart file part collected during submit */
export interface CollectedFilePart {
	tmpPath: string;
	fieldname: string;
	filename: string;
}

/**
 * Collect multipart parts from a request stream.
 * Enforces per-file size limits, file count, and total request size.
 */
export async function collectMultipartParts(
	parts: AsyncIterable<{ type: string; fieldname: string; value?: unknown; file?: NodeJS.ReadableStream; filename?: string }>,
	pipeline: UploadPipeline,
	limits: ReturnType<typeof getUploadLimits>,
): Promise<{ payloadJson: string; fileParts: CollectedFilePart[] }> {
	let payloadJson = '';
	const fileParts: CollectedFilePart[] = [];
	let totalBytes = 0;

	for await (const part of parts as AsyncIterable<any>) {
		if (part.type === 'field') {
			if (part.fieldname === 'payload') payloadJson = part.value as string;
		} else {
			if (fileParts.length >= limits.maxFiles) {
				throw payloadTooLarge(`Too many files (max ${limits.maxFiles})`);
			}

			const fileKind = fieldnameToKind(part.fieldname);
			const basePerFileMax = fileKind ? kindLimit(limits, fileKind) : limits.imageMaxBytes;
			const perFileMax =
				fileKind === 'POSTER'
					? Math.max(basePerFileMax, SIZE_LIMITS.posterPdf)
					: fileKind === 'IMAGE'
					? Math.max(basePerFileMax, SIZE_LIMITS.imagePdf)
					: basePerFileMax;

			const tmpPath = path.join(os.tmpdir(), crypto.randomUUID());
			pipeline.trackTempFile(tmpPath);

			const limiter = createByteLimiter(perFileMax, part.filename ?? part.fieldname);
			await streamPipeline(part.file, limiter, createWriteStream(tmpPath));

			const stat = await fsp.stat(tmpPath);
			totalBytes += stat.size;
			if (totalBytes > limits.requestMaxBytes) {
				const limitMB = Math.round(limits.requestMaxBytes / 1024 / 1024);
				throw payloadTooLarge(`Total upload size exceeds ${limitMB}MB limit`);
			}

			fileParts.push({ tmpPath, fieldname: part.fieldname, filename: part.filename ?? '' });
		}
	}

	return { payloadJson, fileParts };
}

/** Process collected file parts through the upload pipeline */
export async function processFileParts(
	fileParts: CollectedFilePart[],
	pipeline: UploadPipeline,
): Promise<SavedFile[]> {
	const savedFiles: SavedFile[] = [];
	for (const fp of fileParts) {
		let kind: AssetKind;
		if (fp.fieldname === 'poster') kind = 'POSTER';
		else if (fp.fieldname === 'images[]') kind = 'IMAGE';
		else if (fp.fieldname === 'gameFile') kind = 'GAME';
		else if (fp.fieldname === 'videoFile') kind = 'VIDEO';
		else continue;

		savedFiles.push(await pipeline.processFile(fp.tmpPath, kind, fp.filename));
	}
	return savedFiles;
}

/**
 * Full submit flow: validate payload, generate slug, process files,
 * create project in DB. Handles upload slot and pipeline lifecycle.
 */
export async function submitProject(
	request: { parts(): AsyncIterable<any>; currentUser: { id: number; name: string; role: string } },
) {
	const cfg = env();
	const user = request.currentUser;
	const limits = getUploadLimits(user.role as any);
	const pipeline = new UploadPipeline();

	acquireUploadSlot();
	try {
		const { payloadJson, fileParts } = await collectMultipartParts(
			request.parts(),
			pipeline,
			limits,
		);

		if (!payloadJson) throw badRequest('Missing payload field');

		let rawPayload: unknown;
		try { rawPayload = JSON.parse(payloadJson); }
		catch { throw badRequest('Invalid payload JSON'); }

		// Lazy import to avoid circular — validation is shared
		const { parseBody, SubmitProjectPayload } = await import('../../../shared/validation.js');
		const { exhibitionId, title, summary, description, autoPublish, members } =
			parseBody(SubmitProjectPayload, rawPayload);

		const exhibition = await repo.findExhibitionById(exhibitionId);
		assertUploadAllowed(exhibition, exhibitionId, user.role as any);

		const baseSlug = toSlug(title);
		let slug = await generateUniqueSlug(exhibition!.id, title);
		const savedFiles = await processFileParts(fileParts, pipeline);
		const status: ProjectStatus = autoPublish ? 'PUBLISHED' : 'DRAFT';

		// Retry on slug TOCTOU: between generateUniqueSlug's SELECT and createProjectWithAssets'
		// INSERT, a concurrent submit can claim the same slug. P2002 on `slug` → pick the next
		// candidate and retry. Cap retries so a truly stuck state (e.g. DB error) surfaces.
		let project: Awaited<ReturnType<typeof repo.createProjectWithAssets>> | undefined;
		let retryAttempt = 0;
		const maxRetries = 5;
		while (true) {
			try {
				project = await repo.createProjectWithAssets({
					exhibitionId: exhibition!.id,
					slug,
					title,
					summary,
					description,
					status,
					creatorId: user.id,
					members: members.map((m) => ({
						...m,
						userId: m.userId,
					})),
					savedFiles: savedFiles.map((sf) => ({
						kind: sf.kind,
						storageKey: sf.storageKey,
						playbackStorageKey: sf.playbackStorageKey ?? null,
						originalName: sf.originalName,
						mimeType: sf.mimeType,
						playbackMimeType: sf.playbackMimeType ?? '',
						sizeBytes: sf.sizeBytes,
						playbackSizeBytes: sf.playbackSizeBytes ?? 0,
						playbackStatus: sf.playbackStatus,
						playbackError: sf.playbackError,
					})),
				});
				break;
			} catch (err) {
				if (isUniqueConstraintError(err, 'slug') && retryAttempt < maxRetries) {
					retryAttempt++;
					// Walk past any slugs that arrived while we were losing races.
					let candidate = nextSlugCandidate(baseSlug, retryAttempt);
					while (await repo.findProjectByExhibitionAndSlug(exhibition!.id, candidate)) {
						retryAttempt++;
						if (retryAttempt > maxRetries) break;
						candidate = nextSlugCandidate(baseSlug, retryAttempt);
					}
					if (retryAttempt > maxRetries) {
						throw conflict('Failed to allocate a unique slug after repeated contention');
					}
					slug = candidate;
					continue;
				}
				throw err;
			}
		}

		return {
			id: project!.id,
			slug: project!.slug,
			year: exhibition!.year,
			status,
			adminEditUrl: `${cfg.WEB_PUBLIC_URL}/admin/projects/${project!.id}/edit`,
			publicUrl: status === 'PUBLISHED'
				? `${cfg.WEB_PUBLIC_URL}/years/${exhibition!.year}/${slug}`
				: undefined,
		};
	} catch (err) {
		await pipeline.rollbackCommitted();
		throw err;
	} finally {
		releaseUploadSlot();
		await pipeline.cleanupTemp();
	}
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
		let kind: AssetKind = 'IMAGE';
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
				const streamMax = Math.max(limits.imageMaxBytes, limits.gameMaxBytes);
				const tmpPath = path.join(os.tmpdir(), crypto.randomUUID());
				pipeline.trackTempFile(tmpPath);

				const limiter = createByteLimiter(streamMax, part.filename ?? 'file');
				await streamPipeline(part.file, limiter, createWriteStream(tmpPath));
				fileTmpPath = tmpPath;
				fileOriginalName = part.filename ?? '';
			}
		}

		if (!fileTmpPath) throw badRequest('No file provided');

		// Post-collection size check: now that kind and file type are known,
		// verify against the exact role/type limit.
		const headerBuf = Buffer.alloc(16);
		const fd = await fsp.open(fileTmpPath, 'r');
		await fd.read(headerBuf, 0, 16, 0);
		await fd.close();
		const fileType = detectFileType(headerBuf);
		const isPdf = fileType?.mime === 'application/pdf';
		const exactLimit =
			kind === 'POSTER' && isPdf
				? Math.max(kindLimit(limits, kind), SIZE_LIMITS.posterPdf)
				: kind === 'IMAGE' && isPdf
				? Math.max(kindLimit(limits, kind), SIZE_LIMITS.imagePdf)
				: kindLimit(limits, kind);
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

/** Set a project's poster to the given asset (with validation) */
export async function setPoster(projectId: number, assetId: number) {
	const asset = await repo.findAssetById(assetId);
	assertValidPosterAsset(asset, projectId);
	await repo.setProjectPoster(projectId, assetId);
	return { posterAssetId: assetId };
}

// ── Bulk operations ───────────────────────────────────────

/** Bulk delete projects: remove S3 objects + DB records. NAS originals are untouched. */
export async function bulkDeleteProjects(ids: number[]) {
	const assets = await repo.findAssetsByProjectIds(ids);

	// Failures go through safeDeleteObject — orphan reaper handles retry.
	await Promise.all(
		assets.map((a) => deleteAssetObjects(a, 'project-bulk-delete')),
	);

	const result = await repo.bulkDeleteProjects(ids);
	return { deleted: result.count, assetsRemoved: assets.length };
}
