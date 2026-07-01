import type { AssetKind, ProjectStatus, UserRole } from '../../../generated/prisma/client.js';
import { env } from '../../../config/env.js';
import { badRequest, conflict, forbidden, isUniqueConstraintError } from '../../../shared/errors.js';
import { getUploadLimits, acquireUploadSlot, releaseUploadSlot } from '../../../shared/upload-limits.js';
import { toSlug } from '../../../shared/slug.js';
import { UploadPipeline } from '../../assets/upload/index.js';
import type { SavedFile } from '../../assets/upload/index.js';
import { collectMultipartParts, type CollectedFilePart } from '../../assets/upload/multipart-collector.js';
import { assertUploadAllowed } from '../upload-guard.js';
import { generateUniqueSlug, nextSlugCandidate } from './slug.service.js';
import * as repo from './repository.js';

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

export type SubmitProjectAudience = 'admin' | 'user';

export interface SubmitProjectOptions {
	audience: SubmitProjectAudience;
}

const USER_SUBMIT_FORBIDDEN_TOP_LEVEL_FIELDS = [
	'status',
	'sortOrder',
	'isIncomplete',
	'creator',
	'creatorId',
	'creatorUserId',
	'createdBy',
	'createdByUserId',
	'createdByUserName',
	'posterAssetId',
	'assetIds',
	'ids',
	'bulkStatus',
	'bulkDelete',
] as const;

const USER_SUBMIT_FORBIDDEN_MEMBER_FIELDS = ['userId', 'sortOrder'] as const;

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

function assertUserSubmitPayloadPolicy(rawPayload: unknown): void {
	if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) return;

	const payload = rawPayload as Record<string, unknown>;
	for (const field of USER_SUBMIT_FORBIDDEN_TOP_LEVEL_FIELDS) {
		if (hasOwn(payload, field)) {
			throw badRequest(`Field "${field}" is not allowed for user project submission`, 'USER_SUBMIT_FORBIDDEN_FIELD');
		}
	}

	const members = payload.members;
	if (!Array.isArray(members)) return;

	members.forEach((member, index) => {
		if (!member || typeof member !== 'object' || Array.isArray(member)) return;
		const memberPayload = member as Record<string, unknown>;
		for (const field of USER_SUBMIT_FORBIDDEN_MEMBER_FIELDS) {
			if (hasOwn(memberPayload, field)) {
				throw badRequest(`Field "members.${index}.${field}" is not allowed for user project submission`, 'USER_SUBMIT_FORBIDDEN_FIELD');
			}
		}
	});
}

/**
 * Full submit flow: validate payload, generate slug, process files,
 * create project in DB. Handles upload slot and pipeline lifecycle.
 */
export async function submitProject(
	request: { parts(): AsyncIterable<any>; currentUser: { id: number; name: string; role: string } },
	options: SubmitProjectOptions = { audience: 'admin' },
) {
	const cfg = env();
	const user = request.currentUser;
	const isAdminAudience = options.audience === 'admin';
	if (isAdminAudience && user.role !== 'ADMIN' && user.role !== 'OPERATOR') {
		throw forbidden('Admin project submission requires operator or admin role');
	}

	const policyRole: UserRole = options.audience === 'user' ? 'USER' : user.role as UserRole;
	const limits = getUploadLimits(policyRole);
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

		if (options.audience === 'user') {
			assertUserSubmitPayloadPolicy(rawPayload);
		}

		// Lazy import to avoid circular — validation is shared
		const { parseBody, SubmitProjectPayload } = await import('../../../shared/validation.js');
		const { exhibitionId, title, summary, description, members } =
			parseBody(SubmitProjectPayload, rawPayload);

		const exhibition = await repo.findExhibitionById(exhibitionId);
		assertUploadAllowed(exhibition, exhibitionId, policyRole);

		const baseSlug = toSlug(title);
		let slug = await generateUniqueSlug(exhibition!.id, title);
		const savedFiles = await processFileParts(fileParts, pipeline);
		const status: ProjectStatus = 'PUBLISHED';

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
					members: options.audience === 'user'
						? members.map((m) => ({
								name: m.name,
								studentId: m.studentId,
							}))
						: members.map((m) => ({
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
			publicUrl: `${cfg.WEB_PUBLIC_URL}/years/${exhibition!.year}/${slug}`,
		};
	} catch (err) {
		await pipeline.rollbackCommitted();
		throw err;
	} finally {
		releaseUploadSlot();
		await pipeline.cleanupTemp();
	}
}
