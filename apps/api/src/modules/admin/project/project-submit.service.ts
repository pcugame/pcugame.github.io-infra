import type { AssetKind, ProjectStatus, UserRole } from '@pcu/contracts';
import { AppError, badRequest, conflict, forbidden, isUniqueConstraintError } from '../../../shared/errors.js';
import type { UploadLimits } from '../../../shared/upload-policy.js';
import { toSlug } from '../../../shared/slug.js';
import { assertUploadAllowed } from '../upload-guard.js';
import { generateUniqueSlug, nextSlugCandidate } from './slug.service.js';
import type { MultipartCommandInput } from '../../../application/http-input.js';
import { parseBody, SubmitProjectPayload } from '../../../shared/validation.js';
import type {
	CollectedUploadFile,
	MultipartCollectorPort,
	MultipartRequestHasher,
	SavedUpload,
	UploadPipelinePort,
} from '../../../application/upload-ports.js';
import type { SubmitProjectRepository } from './ports.js';

export interface SubmitProjectDependencies {
	webPublicUrl: string;
	repository: SubmitProjectRepository;
	uploadLimits(role: UserRole): UploadLimits | Promise<UploadLimits>;
	uploadSlots: { acquire(): void; release(): void };
	createPipeline(): UploadPipelinePort;
	multipartCollector: MultipartCollectorPort;
	logger?: {
		error(context: Record<string, unknown>, message: string): void;
	};
	recordPostCommitCleanupFailure?: () => void;
	requestHasher?: MultipartRequestHasher;
	idempotency?: {
		claim(input: {
			actorId: number;
			scope: string;
			key: string;
			requestHash: string;
		}): Promise<
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

/** Process collected file parts through the upload pipeline */
export async function processFileParts(
	fileParts: CollectedUploadFile[],
	pipeline: UploadPipelinePort,
): Promise<SavedUpload[]> {
	const savedFiles: SavedUpload[] = [];
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
	deps: SubmitProjectDependencies,
	input: MultipartCommandInput,
	options: SubmitProjectOptions = { audience: 'admin' },
): Promise<SubmitProjectResult> {
	const user = input.actor;
	const isAdminAudience = options.audience === 'admin';
	if (isAdminAudience && user.role !== 'ADMIN' && user.role !== 'OPERATOR') {
		throw forbidden('Admin project submission requires operator or admin role');
	}

	const policyRole: UserRole = options.audience === 'user' ? 'USER' : user.role;
	const limits = await deps.uploadLimits(policyRole);
	const pipeline = deps.createPipeline();
	let result: SubmitProjectResult | undefined;
	let failure: unknown;
	let operation: { operationId: string; ownerToken: string } | undefined;
	let operationHeartbeat: NodeJS.Timeout | undefined;
	const stopOperationHeartbeat = () => {
		if (operationHeartbeat) clearInterval(operationHeartbeat);
		operationHeartbeat = undefined;
	};

	deps.uploadSlots.acquire();
	try {
		const { payloadJson, fileParts } = await deps.multipartCollector.collect(
			input.parts,
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

		const { exhibitionId, title, summary, description, members } =
			parseBody(SubmitProjectPayload, rawPayload);
		pipeline.setOwner?.({ actorId: user.id, exhibitionId });

		const exhibition = await deps.repository.findExhibitionById(exhibitionId);
		assertUploadAllowed(exhibition, exhibitionId, policyRole);

		if (input.idempotencyKey && deps.idempotency) {
			if (!deps.requestHasher) throw new Error('Idempotency hashing is unavailable');
			const requestHash = await deps.requestHasher.hash(rawPayload, fileParts);
			const claimed = await deps.idempotency.claim({
				actorId: user.id,
				scope: `project-submit:${options.audience}`,
				key: input.idempotencyKey,
				requestHash,
			});
			if (claimed.kind === 'succeeded') {
				if (!isSubmitProjectResult(claimed.result)) {
					throw new Error('Stored idempotency result is malformed');
				}
				result = claimed.result;
				return result;
			}
			operation = claimed;
			if (deps.idempotency.renew) {
				operationHeartbeat = setInterval(() => {
					void deps.idempotency!.renew!(operation!).catch((error) => {
						deps.logger?.error(
							{ error, operationId: operation?.operationId },
							'Idempotency operation heartbeat failed',
						);
					});
				}, 30 * 1000);
				operationHeartbeat.unref();
			}
			pipeline.setOwner?.({
				operationId: operation.operationId,
				actorId: user.id,
				exhibitionId,
			});
		}

		const baseSlug = toSlug(title);
		let slug = await generateUniqueSlug(deps.repository, exhibition.id, title);
		const savedFiles = await processFileParts(fileParts, pipeline);
		const status: ProjectStatus = 'PUBLISHED';

		// Retry on slug TOCTOU: between generateUniqueSlug's SELECT and createProjectWithAssets'
		// INSERT, a concurrent submit can claim the same slug. P2002 on `slug` → pick the next
		// candidate and retry. Cap retries so a truly stuck state (e.g. DB error) surfaces.
		let project: Awaited<ReturnType<typeof deps.repository.createProjectWithAssets>> | undefined;
		let retryAttempt = 0;
		const maxRetries = 5;
		while (true) {
			try {
				project = await deps.repository.createProjectWithAssets({
					exhibitionId: exhibition.id,
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
						width: sf.width,
						height: sf.height,
						renditions: sf.renditions,
						playbackSizeBytes: sf.playbackSizeBytes ?? 0,
						playbackStatus: sf.playbackStatus,
						playbackError: sf.playbackError,
						uploadIntentIds: sf.uploadIntentIds,
					})),
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
			} catch (err) {
				if (isUniqueConstraintError(err, 'slug') && retryAttempt < maxRetries) {
					retryAttempt++;
					// Walk past any slugs that arrived while we were losing races.
					let candidate = nextSlugCandidate(baseSlug, retryAttempt);
					while (await deps.repository.findProjectByExhibitionAndSlug(exhibition.id, candidate)) {
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

		result = {
			id: project.id,
			slug: project.slug,
			year: exhibition.year,
			status,
			adminEditUrl: `${deps.webPublicUrl}/admin/projects/${project.id}/edit`,
			publicUrl: `${deps.webPublicUrl}/years/${exhibition.year}/${slug}`,
		};
		stopOperationHeartbeat();
	} catch (err) {
		stopOperationHeartbeat();
		failure = err;
		if (operation && deps.idempotency) {
			await deps.idempotency.markFailed({
				...operation,
				terminal: err instanceof AppError
					&& err.statusCode >= 400
					&& err.statusCode < 500
					&& err.statusCode !== 409,
				error: err,
			}).catch((markError) => {
				deps.logger?.error(
					{ error: markError, operationId: operation?.operationId },
					'Failed to persist idempotency operation failure',
				);
			});
		}
		try {
			await pipeline.rollbackCommitted();
		} catch (rollbackError) {
			failure = new AggregateError(
				[err, rollbackError],
				'Project submission and durable upload rollback failed',
			);
		}
	} finally {
		stopOperationHeartbeat();
		deps.uploadSlots.release();
		try {
			await pipeline.cleanupTemp();
		} catch (cleanupError) {
			if (result !== undefined && failure === undefined) {
				deps.recordPostCommitCleanupFailure?.();
				deps.logger?.error(
					{ error: cleanupError, projectId: result.id },
					'Post-commit project temp cleanup failed',
				);
			} else {
				failure = failure === undefined ? cleanupError : new AggregateError(
						[failure, cleanupError],
						'Project submission and temp cleanup failed',
					);
			}
		}
	}
	if (failure !== undefined) throw failure;
	return result!;
}

export function createSubmitProjectService(deps: SubmitProjectDependencies) {
	return {
		submitProject: (
			input: MultipartCommandInput,
			options: SubmitProjectOptions = { audience: 'admin' },
		) => submitProject(deps, input, options),
	};
}
