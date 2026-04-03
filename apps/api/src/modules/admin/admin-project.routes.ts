import type { FastifyInstance } from 'fastify';
import { promises as fsp, createWriteStream } from 'node:fs';
import { pipeline as streamPipeline } from 'node:stream/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { sendOk, sendCreated } from '../../shared/http.js';
import { badRequest, notFound, forbidden } from '../../shared/errors.js';
import {
	parseBody,
	UpdateProjectBody,
	SubmitProjectPayload,
	SetPosterBody,
	AssetKindEnum,
} from '../../shared/validation.js';
import { requireLogin } from '../../plugins/auth.js';
import { buildStoragePath } from '../../shared/storage-path.js';
import { toSlug } from '../../shared/slug.js';
import type { AssetKind } from '@prisma/client';
import { UploadPipeline } from '../assets/upload/index.js';
import type { SavedFile } from '../assets/upload/index.js';
import { loadProjectWithAccess } from './project-access.js';
import { assertUploadAllowed } from './upload-guard.js';
import {
	getUploadLimits,
	kindLimit,
	fieldnameToKind,
	createByteLimiter,
	acquireUploadSlot,
	releaseUploadSlot,
} from '../../shared/upload-limits.js';
import { payloadTooLarge } from '../../shared/errors.js';
import { assertValidPosterAsset, isPosterUrlSafe } from '../../shared/poster-validation.js';

function assetUrl(storageKey: string, kind: AssetKind): string {
	const base = env().API_PUBLIC_URL;
	if (kind === 'GAME') return `${base}/api/assets/protected/${storageKey}`;
	return `${base}/api/assets/public/${storageKey}`;
}

function serializeProjectDetail(project: {
	id: string;
	title: string;
	slug: string;
	year: { year: number };
	summary: string;
	description: string;
	isLegacy: boolean;
	videoUrl: string;
	videoMimeType: string;
	status: string;
	sortOrder: number;
	posterAssetId: string | null;
	poster: { storageKey: string; kind: AssetKind; status: string } | null;
	members: { id: string; name: string; studentId: string; sortOrder: number; userId: string | null }[];
	assets: { id: string; kind: AssetKind; storageKey: string; originalName: string; sizeBytes: bigint }[];
}) {
	return {
		id: project.id,
		title: project.title,
		slug: project.slug,
		year: project.year.year,
		summary: project.summary || undefined,
		description: project.description || undefined,
		isLegacy: project.isLegacy,
		video: project.videoUrl
			? {
					provider: 'NAS' as const,
					url: project.videoUrl,
					mimeType: project.videoMimeType || 'video/mp4',
				}
			: null,
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

const projectDetailInclude = {
	year: true,
	members: { orderBy: { sortOrder: 'asc' as const } },
	assets: { where: { status: 'READY' as const }, orderBy: { createdAt: 'asc' as const } },
	poster: true,
} as const;

export async function adminProjectRoutes(app: FastifyInstance): Promise<void> {
	// GET /projects
	app.get('/projects', { preHandler: requireLogin }, async (request, reply) => {
		const user = request.currentUser!;
		const isPrivileged = user.role === 'ADMIN' || user.role === 'OPERATOR';
		const projects = await prisma.project.findMany({
			where: isPrivileged
				? {}
				: {
						OR: [
							{ creatorId: user.id },
							{ members: { some: { userId: user.id } } },
						],
					},
			orderBy: { createdAt: 'desc' },
			include: { year: true, creator: true },
		});
		const items = projects.map((p) => ({
			id: p.id,
			title: p.title,
			slug: p.slug,
			year: p.year.year,
			status: p.status,
			createdByUserName: p.creator.name || undefined,
			updatedAt: p.updatedAt.toISOString(),
		}));
		sendOk(reply, { items });
	});

	// GET /projects/:id
	app.get<{ Params: { id: string } }>(
		'/projects/:id',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const project = await prisma.project.findUnique({
				where: { id: request.params.id },
				include: projectDetailInclude,
			});
			if (!project) throw notFound('Project not found');

			const user = request.currentUser!;
			if (
				user.role !== 'ADMIN' &&
				user.role !== 'OPERATOR' &&
				project.creatorId !== user.id
			) {
				// Check if user is a linked member of this project
				const isMember = !!(await prisma.projectMember.findFirst({
					where: { projectId: project.id, userId: user.id },
				}));
				if (!isMember) {
					throw forbidden('Not your project');
				}
			}

			sendOk(reply, serializeProjectDetail(project));
		},
	);

	// PATCH /projects/:id
	app.patch<{ Params: { id: string } }>(
		'/projects/:id',
		{ preHandler: requireLogin },
		async (request, reply) => {
			await loadProjectWithAccess(request, request.params.id, { requireDraft: true });

			const { title, summary, description, videoUrl, videoMimeType, isLegacy, status, sortOrder } =
				parseBody(UpdateProjectBody, request.body);

			const updated = await prisma.project.update({
				where: { id: request.params.id },
				data: {
					...(title !== undefined ? { title } : {}),
					...(summary !== undefined ? { summary } : {}),
					...(description !== undefined ? { description } : {}),
					...(videoUrl !== undefined ? { videoUrl: videoUrl ?? '' } : {}),
					...(videoMimeType !== undefined ? { videoMimeType } : {}),
					...(isLegacy !== undefined ? { isLegacy } : {}),
					...(status !== undefined ? { status } : {}),
					...(sortOrder !== undefined ? { sortOrder } : {}),
				},
				include: projectDetailInclude,
			});

			sendOk(reply, serializeProjectDetail(updated));
		},
	);

	// DELETE /projects/:id
	app.delete<{ Params: { id: string } }>(
		'/projects/:id',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const project = await loadProjectWithAccess(request, request.params.id, { requireDraft: true });

			const assets = await prisma.asset.findMany({ where: { projectId: project.id } });
			const cfg = env();
			for (const asset of assets) {
				const root =
					asset.kind === 'GAME' ? cfg.UPLOAD_ROOT_PROTECTED : cfg.UPLOAD_ROOT_PUBLIC;
				const filePath = buildStoragePath(root, asset.storageKey);
				await fsp.unlink(filePath).catch(() => {});
			}

			await prisma.project.delete({ where: { id: project.id } });
			reply.status(204).send();
		},
	);

	// POST /projects/submit (multipart)
	const uploadBodyLimit = env().UPLOAD_PRIVILEGED_REQUEST_MAX_MB * 1024 * 1024;
	app.post('/projects/submit', { preHandler: requireLogin, bodyLimit: uploadBodyLimit }, async (request, reply) => {
		const cfg = env();
		const role = request.currentUser!.role;
		const limits = getUploadLimits(role);
		const pipeline = new UploadPipeline();

		acquireUploadSlot();
		try {
			// ── Collect multipart parts ───────────────────────────────
			const parts = request.parts();
			let payloadJson = '';
			interface FilePart { tmpPath: string; fieldname: string; filename: string; }
			const fileParts: FilePart[] = [];
			let totalBytes = 0;

			for await (const part of parts) {
				if (part.type === 'field') {
					if (part.fieldname === 'payload') payloadJson = part.value as string;
				} else {
					// Enforce file count limit
					if (fileParts.length >= limits.maxFiles) {
						throw payloadTooLarge(`Too many files (max ${limits.maxFiles})`);
					}

					// Determine per-file byte limit from fieldname
					const fileKind = fieldnameToKind(part.fieldname);
					const perFileMax = fileKind
						? kindLimit(limits, fileKind)
						: limits.imageMaxBytes; // unknown field → image limit

					const tmpPath = path.join(os.tmpdir(), crypto.randomUUID());
					pipeline.trackTempFile(tmpPath);

					// Stream through byte limiter → abort early if over limit
					const limiter = createByteLimiter(perFileMax, part.filename ?? part.fieldname);
					await streamPipeline(part.file, limiter, createWriteStream(tmpPath));

					// Track cumulative request size
					const stat = await fsp.stat(tmpPath);
					totalBytes += stat.size;
					if (totalBytes > limits.requestMaxBytes) {
						const limitMB = Math.round(limits.requestMaxBytes / 1024 / 1024);
						throw payloadTooLarge(`Total upload size exceeds ${limitMB}MB limit`);
					}

					fileParts.push({
						tmpPath,
						fieldname: part.fieldname,
						filename: part.filename ?? '',
					});
				}
			}

			if (!payloadJson) throw badRequest('Missing payload field');

			// ── Parse & validate payload ───────────────────────────────
			let rawPayload: unknown;
			try {
				rawPayload = JSON.parse(payloadJson);
			} catch {
				throw badRequest('Invalid payload JSON');
			}

			const {
				yearId,
				title,
				summary,
				description,
				videoUrl,
				videoMimeType,
				autoPublish,
				members,
			} = parseBody(SubmitProjectPayload, rawPayload);

			// Require exhibition to exist and uploads to be allowed
			const year = await prisma.year.findUnique({ where: { id: yearId } });
			assertUploadAllowed(year, yearId, request.currentUser!.role);

			// Generate unique slug
			const baseSlug = toSlug(title);
			let slug = baseSlug;
			let attempt = 0;
			while (
				await prisma.project.findUnique({
					where: { project_year_slug: { yearId: year.id, slug } },
				})
			) {
				attempt++;
				slug = `${baseSlug}-${attempt}`;
			}

			// ── Validate, process, and move files via upload pipeline ─
			const savedFiles: SavedFile[] = [];
			for (const fp of fileParts) {
				let kind: AssetKind;
				if (fp.fieldname === 'poster') kind = 'POSTER';
				else if (fp.fieldname === 'images[]') kind = 'IMAGE';
				else if (fp.fieldname === 'gameFile') kind = 'GAME';
				else continue;

				const saved = await pipeline.processFile(fp.tmpPath, kind, fp.filename);
				savedFiles.push(saved);
			}

			const status = autoPublish ? 'PUBLISHED' : 'DRAFT';

			// ── DB transaction — if this fails, committed files are rolled back ─
			const project = await prisma.$transaction(async (tx) => {
				const creatorUser = request.currentUser!;
				const p = await tx.project.create({
					data: {
						yearId: year.id,
						slug,
						title,
						summary,
						description,
						videoUrl,
						videoMimeType,
						status,
						creatorId: creatorUser.id,
						members: {
							create: members.map((m, i) => ({
								name: m.name,
								studentId: m.studentId,
								sortOrder: m.sortOrder ?? i,
								// Auto-link creator to their own member entry (name match)
								...(m.name === creatorUser.name ? { userId: creatorUser.id } : {}),
							})),
						},
					},
				});

				let posterAssetId: string | null = null;
				for (const sf of savedFiles) {
					const asset = await tx.asset.create({
						data: {
							projectId: p.id,
							kind: sf.kind,
							storageKey: sf.storageKey,
							originalName: sf.originalName,
							mimeType: sf.mimeType,
							sizeBytes: BigInt(sf.sizeBytes),
							isPublic: sf.kind !== 'GAME',
						},
					});
					if (sf.kind === 'POSTER' && !posterAssetId) posterAssetId = asset.id;
				}

				if (posterAssetId) {
					await tx.project.update({ where: { id: p.id }, data: { posterAssetId } });
				}

				return p;
			});

			const adminEditUrl = `${cfg.WEB_PUBLIC_URL}/admin/projects/${project.id}/edit`;
			const publicUrl =
				status === 'PUBLISHED'
					? `${cfg.WEB_PUBLIC_URL}/years/${year.year}/${slug}`
					: undefined;

			sendCreated(reply, {
				id: project.id,
				slug: project.slug,
				year: year.year,
				status,
				adminEditUrl,
				publicUrl,
			});
		} catch (err) {
			await pipeline.rollbackCommitted();
			throw err;
		} finally {
			releaseUploadSlot();
			await pipeline.cleanupTemp();
		}
	});

	// POST /projects/:id/assets (multipart, add one asset)
	app.post<{ Params: { id: string } }>(
		'/projects/:id/assets',
		{ preHandler: requireLogin, bodyLimit: uploadBodyLimit },
		async (request, reply) => {
			await loadProjectWithAccess(request, request.params.id, { requireDraft: true });

			const role = request.currentUser!.role;
			const limits = getUploadLimits(role);
			const pipeline = new UploadPipeline();

			acquireUploadSlot();
			try {
				// Collect all parts first so 'kind' is set before processing
				let kind: AssetKind = 'IMAGE';
				let fileTmpPath: string | null = null;
				let fileOriginalName = '';

				const parts = request.parts();
				for await (const part of parts) {
					if (part.type === 'field' && part.fieldname === 'kind') {
						const parsed = AssetKindEnum.safeParse(part.value);
						if (!parsed.success) throw badRequest(`Invalid asset kind: ${part.value}`);
						kind = parsed.data;
					} else if (part.type === 'file' && part.fieldname === 'file') {
						// Kind may not be known yet (field order varies), so use
						// the role's max possible per-file limit for streaming.
						// The exact per-kind check runs in validateFile() after write.
						const streamMax = Math.max(
							limits.imageMaxBytes,
							limits.gameMaxBytes,
						);

						const tmpPath = path.join(os.tmpdir(), crypto.randomUUID());
						pipeline.trackTempFile(tmpPath);

						const limiter = createByteLimiter(streamMax, part.filename ?? 'file');
						await streamPipeline(part.file, limiter, createWriteStream(tmpPath));
						fileTmpPath = tmpPath;
						fileOriginalName = part.filename ?? '';
					}
				}

				if (!fileTmpPath) throw badRequest('No file provided');

				const savedFile = await pipeline.processFile(fileTmpPath, kind, fileOriginalName);

				// If uploading a GAME asset, replace the existing one instead of creating a duplicate.
				let existingGame: { id: string; storageKey: string } | null = null;
				if (savedFile.kind === 'GAME') {
					existingGame = await prisma.asset.findFirst({
						where: { projectId: request.params.id, kind: 'GAME', status: 'READY' },
						select: { id: true, storageKey: true },
					});
				}

				let asset;
				if (existingGame) {
					// Replace existing GAME asset in-place
					const cfg2 = env();
					const oldFilePath = buildStoragePath(cfg2.UPLOAD_ROOT_PROTECTED, existingGame.storageKey);
					await fsp.unlink(oldFilePath).catch(() => {});

					asset = await prisma.asset.update({
						where: { id: existingGame.id },
						data: {
							storageKey: savedFile.storageKey,
							originalName: savedFile.originalName,
							mimeType: savedFile.mimeType,
							sizeBytes: BigInt(savedFile.sizeBytes),
						},
					});
				} else {
					asset = await prisma.asset.create({
						data: {
							projectId: request.params.id,
							kind: savedFile.kind,
							storageKey: savedFile.storageKey,
							originalName: savedFile.originalName,
							mimeType: savedFile.mimeType,
							sizeBytes: BigInt(savedFile.sizeBytes),
							isPublic: savedFile.kind !== 'GAME',
						},
					});
				}

				sendCreated(reply, {
					assetId: asset.id,
					url: assetUrl(savedFile.storageKey, savedFile.kind),
				});
			} catch (err) {
				await pipeline.rollbackCommitted();
				throw err;
			} finally {
				releaseUploadSlot();
				await pipeline.cleanupTemp();
			}
		},
	);

	// PATCH /projects/:id/poster
	app.patch<{ Params: { id: string } }>(
		'/projects/:id/poster',
		{ preHandler: requireLogin },
		async (request, reply) => {
			await loadProjectWithAccess(request, request.params.id, { requireDraft: true });

			const { assetId } = parseBody(SetPosterBody, request.body);
			const asset = await prisma.asset.findUnique({
				where: { id: assetId },
			});
			assertValidPosterAsset(asset, request.params.id);

			await prisma.project.update({ where: { id: request.params.id }, data: { posterAssetId: assetId } });
			sendOk(reply, { posterAssetId: assetId });
		},
	);
}
