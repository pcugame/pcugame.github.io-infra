import { promises as fsp, createWriteStream } from 'node:fs';
import { pipeline as streamPipeline } from 'node:stream/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import type { AssetKind, ProjectStatus } from '@prisma/client';
import { env } from '../../../config/env.js';
import { badRequest, forbidden, notFound, payloadTooLarge } from '../../../shared/errors.js';
import { bucketForKind } from '../../../lib/s3.js';
import { deleteObject } from '../../../lib/storage.js';
import { toSlug } from '../../../shared/slug.js';
import { isPosterUrlSafe, assertValidPosterAsset } from '../../../shared/poster-validation.js';
import {
	getUploadLimits,
	kindLimit,
	fieldnameToKind,
	createByteLimiter,
	acquireUploadSlot,
	releaseUploadSlot,
} from '../../../shared/upload-limits.js';
import { UploadPipeline } from '../../assets/upload/index.js';
import type { SavedFile } from '../../assets/upload/index.js';
import { assertUploadAllowed } from '../upload-guard.js';
import * as repo from './repository.js';

// ── Helpers ─────────────────────────────────────────────────

/** Build a full asset URL from storageKey and kind */
export function assetUrl(storageKey: string, kind: AssetKind): string {
	const base = env().API_PUBLIC_URL;
	if (kind === 'GAME' || kind === 'VIDEO') return `${base}/api/assets/protected/${storageKey}`;
	return `${base}/api/assets/public/${storageKey}`;
}

/** Serialize a project detail record to the API response shape */
export function serializeProjectDetail(project: {
	id: number;
	title: string;
	slug: string;
	exhibition: { year: number };
	summary: string;
	description: string;
	isLegacy: boolean;
	status: string;
	sortOrder: number;
	posterAssetId: number | null;
	poster: { storageKey: string; kind: AssetKind; status: string } | null;
	members: { id: number; name: string; studentId: string; sortOrder: number; userId: number | null }[];
	assets: { id: number; kind: AssetKind; storageKey: string; originalName: string; mimeType: string; sizeBytes: bigint }[];
}) {
	const videoAsset = project.assets.find((a) => a.kind === 'VIDEO');
	const video = videoAsset
		? { url: assetUrl(videoAsset.storageKey, 'VIDEO'), mimeType: videoAsset.mimeType || 'video/mp4' }
		: null;

	return {
		id: project.id,
		title: project.title,
		slug: project.slug,
		year: project.exhibition.year,
		summary: project.summary || undefined,
		description: project.description || undefined,
		isLegacy: project.isLegacy,
		video,
		status: project.status,
		sortOrder: project.sortOrder,
		posterAssetId: project.posterAssetId ?? undefined,
		posterUrl: isPosterUrlSafe(project.poster)
			? assetUrl(project.poster!.storageKey, 'POSTER')
			: undefined,
		members: project.members.map((m) => ({
			id: m.id,
			name: m.name,
			studentId: m.studentId,
			sortOrder: m.sortOrder,
			userId: m.userId,
		})),
		assets: project.assets.map((a) => ({
			id: a.id,
			kind: a.kind,
			url: assetUrl(a.storageKey, a.kind),
			originalName: a.originalName,
			size: Number(a.sizeBytes),
		})),
	};
}

// ── Business logic ──────────────────────────────────────────

/** List projects visible to the current user */
export async function listProjects(userId: number, userRole: string) {
	const isPrivileged = userRole === 'ADMIN' || userRole === 'OPERATOR';
	const projects = await repo.findProjectsForUser(userId, isPrivileged);
	return projects.map((p) => ({
		id: p.id,
		title: p.title,
		slug: p.slug,
		year: p.exhibition.year,
		status: p.status,
		createdByUserName: p.creator.name || undefined,
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

/**
 * Validate that a status transition is allowed for the given role.
 *
 * - ADMIN / OPERATOR: all transitions allowed.
 * - USER: DRAFT ↔ PUBLISHED only. ARCHIVED transitions are blocked.
 */
export function assertStatusTransition(
	currentStatus: string,
	targetStatus: string,
	role: string,
): void {
	if (role === 'ADMIN' || role === 'OPERATOR') return;

	const allowed =
		(currentStatus === 'DRAFT' && targetStatus === 'PUBLISHED') ||
		(currentStatus === 'PUBLISHED' && targetStatus === 'DRAFT');

	if (!allowed) {
		throw forbidden(
			`Users can only toggle between DRAFT and PUBLISHED. Cannot change ${currentStatus} → ${targetStatus}.`,
		);
	}
}

/** Partial-update a project */
export async function updateProject(
	projectId: number,
	patch: {
		title?: string; summary?: string; description?: string;
		isLegacy?: boolean; status?: ProjectStatus; sortOrder?: number;
	},
) {
	const updated = await repo.updateProject(projectId, {
		...(patch.title !== undefined ? { title: patch.title } : {}),
		...(patch.summary !== undefined ? { summary: patch.summary } : {}),
		...(patch.description !== undefined ? { description: patch.description } : {}),
		...(patch.isLegacy !== undefined ? { isLegacy: patch.isLegacy } : {}),
		...(patch.status !== undefined ? { status: patch.status } : {}),
		...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
	});

	return serializeProjectDetail(updated);
}

/** Delete a project and its associated asset files from S3 */
export async function deleteProject(projectId: number) {
	const assets = await repo.findAssetsByProjectId(projectId);
	await Promise.allSettled(
		assets.map((asset) => deleteObject(bucketForKind(asset.kind), asset.storageKey)),
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
			const perFileMax = fileKind ? kindLimit(limits, fileKind) : limits.imageMaxBytes;

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

		const slug = await generateUniqueSlug(exhibition!.id, title);
		const savedFiles = await processFileParts(fileParts, pipeline);
		const status: ProjectStatus = autoPublish ? 'PUBLISHED' : 'DRAFT';

		const project = await repo.createProjectWithAssets({
			exhibitionId: exhibition!.id,
			slug,
			title,
			summary,
			description,
			status,
			creatorId: user.id,
			members: members.map((m) => ({
				...m,
				// If no userId provided, auto-link creator by checking member name
				userId: m.userId,
			})),
			savedFiles: savedFiles.map((sf) => ({
				kind: sf.kind,
				storageKey: sf.storageKey,
				originalName: sf.originalName,
				mimeType: sf.mimeType,
				sizeBytes: sf.sizeBytes,
			})),
		});

		return {
			id: project.id,
			slug: project.slug,
			year: exhibition!.year,
			status,
			adminEditUrl: `${cfg.WEB_PUBLIC_URL}/admin/projects/${project.id}/edit`,
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

		// Post-collection size check: now that kind is known, verify against the exact limit
		const exactLimit = kindLimit(limits, kind);
		const fileStat = await fsp.stat(fileTmpPath);
		if (fileStat.size > exactLimit) {
			const limitMB = Math.round(exactLimit / 1024 / 1024);
			throw payloadTooLarge(`File exceeds ${kind} size limit of ${limitMB}MB`);
		}

		const savedFile = await pipeline.processFile(fileTmpPath, kind, fileOriginalName);

		// Replace existing GAME or VIDEO asset if uploading a new one
		let existingReplaceable: { id: number; storageKey: string } | null = null;
		if (savedFile.kind === 'GAME') {
			existingReplaceable = await repo.findReadyGameAsset(projectId);
		} else if (savedFile.kind === 'VIDEO') {
			existingReplaceable = await repo.findReadyVideoAsset(projectId);
		}

		let asset;
		if (existingReplaceable) {
			await deleteObject(bucketForKind(savedFile.kind), existingReplaceable.storageKey).catch(() => {});

			asset = await repo.updateAssetFile(existingReplaceable.id, {
				storageKey: savedFile.storageKey,
				originalName: savedFile.originalName,
				mimeType: savedFile.mimeType,
				sizeBytes: BigInt(savedFile.sizeBytes),
			});
		} else {
			asset = await repo.createAsset({
				projectId,
				kind: savedFile.kind,
				storageKey: savedFile.storageKey,
				originalName: savedFile.originalName,
				mimeType: savedFile.mimeType,
				sizeBytes: BigInt(savedFile.sizeBytes),
				isPublic: savedFile.kind !== 'GAME' && savedFile.kind !== 'VIDEO',
			});
		}

		return { assetId: asset.id, url: assetUrl(savedFile.storageKey, savedFile.kind) };
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

/** Bulk update project status */
export async function bulkUpdateStatus(ids: number[], status: ProjectStatus) {
	const result = await repo.bulkUpdateStatus(ids, status);
	return { updated: result.count };
}

/** Bulk delete projects: remove S3 objects + DB records. NAS originals are untouched. */
export async function bulkDeleteProjects(ids: number[]) {
	const assets = await repo.findAssetsByProjectIds(ids);

	// Delete from S3 (best-effort, don't block on failures)
	await Promise.allSettled(
		assets.map((a) => deleteObject(bucketForKind(a.kind), a.storageKey)),
	);

	const result = await repo.bulkDeleteProjects(ids);
	return { deleted: result.count, assetsRemoved: assets.length };
}
