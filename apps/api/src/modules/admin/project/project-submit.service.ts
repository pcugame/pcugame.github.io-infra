import { createHash } from 'node:crypto';
import type { ProjectSubmissionItemStatus, ProjectSubmissionStatusResponse } from '@pcu/contracts';
import { AppError, badRequest, conflict, forbidden, isUniqueConstraintError } from '../../../shared/errors.js';
import { toSlug } from '../../../shared/slug.js';
import { parseBody, SubmitProjectPayload } from '../../../shared/validation.js';
import { assertUploadAllowed } from '../upload-guard.js';
import { generateUniqueSlug, nextSlugCandidate } from './slug.service.js';
import type { ProjectSubmissionRecord, SubmitProjectRepository } from './ports.js';

export type SubmitProjectAudience = 'admin' | 'user';

export interface MetadataProjectCommand {
	actor: { id: number; role: string };
	payload: unknown;
	idempotencyKey?: string;
}

export interface SubmitProjectOptions { audience: SubmitProjectAudience; }

export interface SubmitProjectResult {
	id: number;
	slug: string;
	year: number;
	status: 'DRAFT';
	submissionId: string;
	items: ProjectSubmissionItemStatus[];
	adminEditUrl: string;
	publicUrl?: string;
}

export interface SubmitProjectDependencies {
	webPublicUrl: string;
	repository: SubmitProjectRepository;
	idempotency?: {
		claim(input: { actorId: number; scope: string; key: string; requestHash: string }): Promise<
			| { kind: 'acquired'; operationId: string; ownerToken: string }
			| { kind: 'succeeded'; result: unknown }
		>;
		markFailed(input: { operationId: string; ownerToken: string; terminal: boolean; error: unknown }): Promise<void>;
	};
}

const USER_SUBMIT_FORBIDDEN_TOP_LEVEL_FIELDS = [
	'status', 'sortOrder', 'isIncomplete', 'creator', 'creatorId', 'creatorUserId',
	'createdBy', 'createdByUserId', 'createdByUserName', 'posterAssetId', 'assetIds',
	'ids', 'bulkStatus', 'bulkDelete',
] as const;
const USER_SUBMIT_FORBIDDEN_MEMBER_FIELDS = ['userId', 'sortOrder'] as const;

function hasOwn(value: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function assertUserSubmitPayloadPolicy(rawPayload: unknown): void {
	if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) return;
	const payload = rawPayload as Record<string, unknown>;
	for (const field of USER_SUBMIT_FORBIDDEN_TOP_LEVEL_FIELDS) {
		if (hasOwn(payload, field)) throw badRequest(`Field "${field}" is not allowed for user project submission`, 'USER_SUBMIT_FORBIDDEN_FIELD');
	}
	if (!Array.isArray(payload.members)) return;
	payload.members.forEach((member, index) => {
		if (!member || typeof member !== 'object' || Array.isArray(member)) return;
		for (const field of USER_SUBMIT_FORBIDDEN_MEMBER_FIELDS) {
			if (hasOwn(member as Record<string, unknown>, field)) {
				throw badRequest(`Field "members.${index}.${field}" is not allowed for user project submission`, 'USER_SUBMIT_FORBIDDEN_FIELD');
			}
		}
	});
}

function resultShape(value: unknown): value is SubmitProjectResult {
	if (!value || typeof value !== 'object') return false;
	const result = value as Record<string, unknown>;
	return typeof result.id === 'number' && typeof result.slug === 'string'
		&& typeof result.year === 'number' && result.status === 'DRAFT'
		&& typeof result.submissionId === 'string' && Array.isArray(result.items)
		&& typeof result.adminEditUrl === 'string';
}

function serializeSubmissionItems(submission: ProjectSubmissionRecord): ProjectSubmissionItemStatus[] {
	return submission.items.map((item) => ({
		id: item.id,
		kind: item.kind,
		slot: item.slot,
		clientToken: item.clientToken,
		required: true,
		state: item.state,
		...(item.uploadSession ? {
			sessionId: item.uploadSession.id,
			generation: item.uploadSession.generation,
		} : {}),
		...(item.failureReason ? { failureReason: item.failureReason } : {}),
		...(item.playbackState !== 'NONE' ? { playbackState: item.playbackState } : {}),
		...(item.playbackError ? { playbackError: item.playbackError } : {}),
	}));
}

function serializeSubmission(submission: ProjectSubmissionRecord): ProjectSubmissionStatusResponse {
	return {
		submissionId: submission.id,
		projectId: submission.projectId,
		projectStatus: submission.project.status,
		state: submission.state,
		...(submission.publicationJob ? { publicationState: submission.publicationJob.state } : {}),
		...(submission.publicationJob?.lastError ? { publicationError: submission.publicationJob.lastError } : {}),
		items: serializeSubmissionItems(submission),
	};
}

function assertManifestIsUnambiguous(manifest: Array<{ kind: string; slot: string; clientToken: string }>): void {
	const slots = new Set<string>();
	const tokens = new Set<string>();
	for (const item of manifest) {
		if ((item.kind === 'VIDEO') !== item.slot.startsWith('video:')) {
			throw badRequest('VIDEO submission slots must have kind VIDEO');
		}
		if (slots.has(item.slot) || tokens.has(item.clientToken)) {
			throw badRequest('Project submission manifest slots and client tokens must be unique');
		}
		slots.add(item.slot);
		tokens.add(item.clientToken);
	}
	if (manifest.filter((item) => item.kind === 'DOCUMENT' || item.kind === 'ATTACHMENT').length > 5) throw badRequest('A project supports at most 5 materials');
	for (const item of manifest) {
		if ((item.kind === 'DOCUMENT') !== item.slot.startsWith('document:') || (item.kind === 'ATTACHMENT') !== item.slot.startsWith('attachment:')) throw badRequest('Material kind and slot must match');
	}
	const videos = manifest.filter((item) => item.kind === 'VIDEO');
	if (videos.length > 5 || videos.some((_item, index) => !slots.has(`video:${index}`))) {
		throw badRequest('VIDEO submission slots must be consecutive video:0 through video:4, with at most 5 videos');
	}
}

/** Creates project metadata only; bytes use direct AssetUpload sessions. */
export async function submitProject(
	deps: SubmitProjectDependencies,
	input: MetadataProjectCommand,
	options: SubmitProjectOptions = { audience: 'admin' },
): Promise<SubmitProjectResult> {
	if (options.audience === 'admin' && input.actor.role !== 'ADMIN' && input.actor.role !== 'OPERATOR') {
		throw forbidden('Admin project submission requires operator or admin role');
	}
	if (options.audience === 'user') assertUserSubmitPayloadPolicy(input.payload);
	const { exhibitionId, title, summary, description, members, manifest } = parseBody(SubmitProjectPayload, input.payload);
	assertManifestIsUnambiguous(manifest);
	const exhibition = await deps.repository.findExhibitionById(exhibitionId);
	assertUploadAllowed(exhibition, exhibitionId, options.audience === 'user' ? 'USER' : input.actor.role as never);

	let operation: { operationId: string; ownerToken: string } | undefined;
	try {
		if (input.idempotencyKey && deps.idempotency) {
			const requestHash = createHash('sha256').update(JSON.stringify(input.payload)).digest('hex');
			const claimed = await deps.idempotency.claim({
				actorId: input.actor.id, scope: `project-submit:${options.audience}`,
				key: input.idempotencyKey, requestHash,
			});
			if (claimed.kind === 'succeeded') {
				if (!resultShape(claimed.result)) throw new Error('Stored idempotency result is malformed');
				return claimed.result;
			}
			operation = claimed;
		}

		const baseSlug = toSlug(title);
		let slug = await generateUniqueSlug(deps.repository, exhibition.id, title);
		let project: Awaited<ReturnType<SubmitProjectRepository['createProjectWithAssets']>> | undefined;
		let retryAttempt = 0;
		const status = 'DRAFT' as const;
		while (true) {
			try {
				project = await deps.repository.createProjectWithAssets({
					exhibitionId: exhibition.id, slug, title, summary, description, status,
					creatorId: input.actor.id,
					manifest,
					members: options.audience === 'user'
						? members.map((member) => ({ name: member.name, studentId: member.studentId }))
						: members.map((member) => ({ ...member, userId: member.userId })),
					...(operation ? { idempotency: {
						...operation,
						resultForProject: (created) => ({
							id: created.id, slug: created.slug, year: exhibition.year, status,
							submissionId: created.submission.id,
							items: serializeSubmissionItems(created.submission),
							adminEditUrl: `${deps.webPublicUrl}/admin/projects/${created.id}/edit`,
						}),
					} } : {}),
				});
				break;
			} catch (error) {
				if (!isUniqueConstraintError(error, 'slug') || retryAttempt >= 5) throw error;
				retryAttempt++;
				let candidate = nextSlugCandidate(baseSlug, retryAttempt);
				while (await deps.repository.findProjectByExhibitionAndSlug(exhibition.id, candidate)) {
					retryAttempt++;
					if (retryAttempt > 5) throw conflict('Failed to allocate a unique slug after repeated contention');
					candidate = nextSlugCandidate(baseSlug, retryAttempt);
				}
				slug = candidate;
			}
			}
			return {
				id: project.id, slug: project.slug, year: exhibition.year, status,
				submissionId: project.submission.id,
				items: serializeSubmissionItems(project.submission),
				adminEditUrl: `${deps.webPublicUrl}/admin/projects/${project.id}/edit`,
			};
	} catch (error) {
		if (operation && deps.idempotency) {
			await deps.idempotency.markFailed({
				...operation,
				terminal: error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 409,
				error,
			}).catch(() => undefined);
		}
		throw error;
	}
}

export function createSubmitProjectService(deps: SubmitProjectDependencies) {
	return {
		submitProject: (input: MetadataProjectCommand, options?: SubmitProjectOptions) => submitProject(deps, input, options),
		async status(actor: { id: number; role: string }, projectId: number) {
			const submission = await deps.repository.findSubmissionForActor(projectId, actor);
			if (!submission) throw badRequest('Project submission not found');
			return serializeSubmission(submission);
		},
		async finalize(actor: { id: number; role: string }, projectId: number) {
			return serializeSubmission(await deps.repository.finalizeSubmission(projectId, actor));
		},
		async cancel(actor: { id: number; role: string }, projectId: number) {
			return serializeSubmission(await deps.repository.cancelSubmission(projectId, actor));
		},
		audit: () => deps.repository.auditActiveSubmissions(),
	};
}
