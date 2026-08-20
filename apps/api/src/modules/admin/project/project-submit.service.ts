import type { ProjectStatus } from '@pcu/contracts';
import { AppError, badRequest, conflict, forbidden, isUniqueConstraintError } from '../../../shared/errors.js';
import { toSlug } from '../../../shared/slug.js';
import type { JsonCommandInput } from '../../../application/http-input.js';
import { parseBody, SubmitProjectPayload } from '../../../shared/validation.js';
import type { MultipartRequestHasher } from '../../../application/upload-ports.js';
import { assertUploadAllowed } from '../upload-guard.js';
import { generateUniqueSlug, nextSlugCandidate } from './slug.service.js';
import type { SubmitProjectRepository } from './ports.js';

export interface SubmitProjectDependencies {
	webPublicUrl: string;
	repository: SubmitProjectRepository;
	requestHasher: MultipartRequestHasher;
	logger?: { error(context: Record<string, unknown>, message: string): void };
	idempotency?: {
		claim(input: { actorId: number; scope: string; key: string; requestHash: string }): Promise<
			| { kind: 'acquired'; operationId: string; ownerToken: string }
			| { kind: 'succeeded'; result: unknown }
		>;
		markFailed(input: {
			operationId: string;
			ownerToken: string;
			terminal: boolean;
			error: unknown;
		}): Promise<void>;
		renew?(input: { operationId: string; ownerToken: string }): Promise<void>;
	};
}

export type SubmitProjectAudience = 'admin' | 'user';
export interface SubmitProjectOptions { audience: SubmitProjectAudience }
export interface SubmitProjectResult {
	id: number;
	slug: string;
	year: number;
	status: ProjectStatus;
	adminEditUrl: string;
	publicUrl: string;
}

function isSubmitProjectResult(value: unknown): value is SubmitProjectResult {
	if (!value || typeof value !== 'object') return false;
	const result = value as Record<string, unknown>;
	return typeof result.id === 'number'
		&& typeof result.slug === 'string'
		&& typeof result.year === 'number'
		&& (result.status === 'PUBLISHED' || result.status === 'ARCHIVED')
		&& typeof result.adminEditUrl === 'string'
		&& typeof result.publicUrl === 'string';
}

const USER_SUBMIT_FORBIDDEN_TOP_LEVEL_FIELDS = [
	'status', 'sortOrder', 'isIncomplete', 'creator', 'creatorId', 'creatorUserId',
	'createdBy', 'createdByUserId', 'createdByUserName', 'posterAssetId', 'assetIds',
	'ids', 'bulkStatus', 'bulkDelete',
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

/** Create project metadata only. Client file bytes are handled after commit. */
export async function submitProject(
	deps: SubmitProjectDependencies,
	input: JsonCommandInput,
	options: SubmitProjectOptions = { audience: 'admin' },
): Promise<SubmitProjectResult> {
	const user = input.actor;
	if (options.audience === 'admin' && user.role !== 'ADMIN' && user.role !== 'OPERATOR') {
		throw forbidden('Admin project submission requires operator or admin role');
	}
	if (options.audience === 'user') assertUserSubmitPayloadPolicy(input.body);

	const { exhibitionId, title, summary, description, members } = parseBody(
		SubmitProjectPayload,
		input.body,
	);
	const exhibition = await deps.repository.findExhibitionById(exhibitionId);
	assertUploadAllowed(exhibition, exhibitionId, options.audience === 'user' ? 'USER' : user.role);

	let operation: { operationId: string; ownerToken: string } | undefined;
	let operationHeartbeat: NodeJS.Timeout | undefined;
	const stopOperationHeartbeat = () => {
		if (operationHeartbeat) clearInterval(operationHeartbeat);
		operationHeartbeat = undefined;
	};

	try {
		if (input.idempotencyKey && deps.idempotency) {
			const claimed = await deps.idempotency.claim({
				actorId: user.id,
				scope: `project-submit:${options.audience}`,
				key: input.idempotencyKey,
				requestHash: await deps.requestHasher.hash(input.body, []),
			});
			if (claimed.kind === 'succeeded') {
				if (!isSubmitProjectResult(claimed.result)) throw new Error('Stored idempotency result is malformed');
				return claimed.result;
			}
			operation = claimed;
			if (deps.idempotency.renew) {
				operationHeartbeat = setInterval(() => {
					void deps.idempotency!.renew!(operation!).catch((error) => deps.logger?.error(
						{ error, operationId: operation?.operationId },
						'Idempotency operation heartbeat failed',
					));
				}, 30 * 1000);
				operationHeartbeat.unref();
			}
		}

		const baseSlug = toSlug(title);
		let slug = await generateUniqueSlug(deps.repository, exhibition.id, title);
		const status: ProjectStatus = 'PUBLISHED';
		let project: { id: number; slug: string } | undefined;
		let retryAttempt = 0;
		const maxRetries = 5;
		while (true) {
			try {
				project = await deps.repository.createProjectMetadata({
					exhibitionId: exhibition.id,
					slug,
					title,
					summary,
					description,
					isIncomplete: true,
					status,
					creatorId: user.id,
					members: options.audience === 'user'
						? members.map((member) => ({ name: member.name, studentId: member.studentId }))
						: members.map((member) => ({ ...member, userId: member.userId })),
					...(operation ? {
						idempotency: {
							...operation,
							resultForProject: (created: { id: number; slug: string }) => ({
								id: created.id,
								slug: created.slug,
								year: exhibition.year,
								status,
								adminEditUrl: `${deps.webPublicUrl}/admin/projects/${created.id}/edit`,
								publicUrl: `${deps.webPublicUrl}/years/${exhibition.year}/${created.slug}`,
							}),
						},
					} : {}),
				});
				break;
			} catch (error) {
				if (!isUniqueConstraintError(error, 'slug') || retryAttempt >= maxRetries) throw error;
				retryAttempt++;
				let candidate = nextSlugCandidate(baseSlug, retryAttempt);
				while (await deps.repository.findProjectByExhibitionAndSlug(exhibition.id, candidate)) {
					retryAttempt++;
					if (retryAttempt > maxRetries) break;
					candidate = nextSlugCandidate(baseSlug, retryAttempt);
				}
				if (retryAttempt > maxRetries) throw conflict('Failed to allocate a unique slug after repeated contention');
				slug = candidate;
			}
		}

		return {
			id: project.id,
			slug: project.slug,
			year: exhibition.year,
			status,
			adminEditUrl: `${deps.webPublicUrl}/admin/projects/${project.id}/edit`,
			publicUrl: `${deps.webPublicUrl}/years/${exhibition.year}/${project.slug}`,
		};
	} catch (error) {
		if (operation && deps.idempotency) {
			await deps.idempotency.markFailed({
				...operation,
				terminal: error instanceof AppError
					&& error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 409,
				error,
			}).catch((markError) => deps.logger?.error(
				{ error: markError, operationId: operation?.operationId },
				'Failed to persist idempotency operation failure',
			));
		}
		throw error;
	} finally {
		stopOperationHeartbeat();
	}
}

export function createSubmitProjectService(deps: SubmitProjectDependencies) {
	return {
		submitProject: (
			input: JsonCommandInput,
			options: SubmitProjectOptions = { audience: 'admin' },
		) => submitProject(deps, input, options),
	};
}
