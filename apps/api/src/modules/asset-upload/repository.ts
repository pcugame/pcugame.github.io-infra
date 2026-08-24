import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { createCanonicalAsset } from '../assets/representation-write.js';
import { withAssetMutationTransaction } from '../assets/mutation-transaction.js';
import { queueDurableDeletions } from '../orphan/outbox.js';
import { queueMultipartAbortTask } from '../multipart-abort/repository.js';
import type { AssetUploadRepository, AssetUploadSessionRecord, DirectAssetUploadOwner } from './ports.js';
import { WorkerGenerationFencedError } from '../upload-lifecycle/worker-errors.js';

function asRecord(value: unknown): AssetUploadSessionRecord {
	return value as AssetUploadSessionRecord;
}

function completionEtag(value: unknown): string | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const etag = (value as Record<string, unknown>).etag;
	return typeof etag === 'string' && etag.length > 0 ? etag : undefined;
}

function assertCompletionProof(value: unknown, input: {
	sessionId: string;
	generation: number;
	completedSize: number;
}): void {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Direct upload completion proof is malformed');
	}
	const proof = value as Record<string, unknown>;
	if (proof.status !== 'VERIFYING' || proof.sessionId !== input.sessionId
		|| proof.generation !== input.generation || proof.sizeBytes !== input.completedSize
		|| (proof.etag !== undefined && (typeof proof.etag !== 'string' || proof.etag.trim() === ''))) {
		throw new Error('Direct upload completion proof lost its generation or object identity fence');
	}
}

function recoveryBatchLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
		throw new RangeError('Asset upload recovery batch limit must be between 1 and 200');
	}
	return limit;
}

export function reservePartCapabilityCount(input: {
	totalParts: number;
	issued: number;
	requested: number;
	maxRefreshIssues: number;
}): number {
	if (![input.totalParts, input.issued, input.requested, input.maxRefreshIssues]
		.every((value) => Number.isSafeInteger(value) && value >= 0)
		|| input.totalParts < 1 || input.requested < 1) {
		throw new Error('DIRECT_UPLOAD_CAPABILITY_REJECTED');
	}
	const count = input.issued + input.requested;
	if (count > input.totalParts + input.maxRefreshIssues) {
		throw new Error('DIRECT_UPLOAD_CAPABILITY_QUOTA');
	}
	return count;
}

export function createAssetUploadRepository(client: PrismaClient): AssetUploadRepository {
	return {
		async createAllocating(input) {
			return withAssetMutationTransaction(client, async (tx) => {
				const { submissionClientToken, ...sessionInput } = input;
				// The snapshot and active-session insert share a serializable scope so a
				// later READY replacement cannot silently overwrite a newer GAME.
				if ((input.projectId === null) === (input.exhibitionId === null)) {
					throw new Error('Direct upload session requires exactly one owner');
				}
				if (input.projectId !== null) {
					await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "projects" WHERE "id" = ${input.projectId} FOR UPDATE`);
					const project = await tx.project.findUniqueOrThrow({
						where: { id: input.projectId },
						select: { status: true },
					});
					if (project.status === 'DRAFT') {
						if (!input.submissionItemId || !submissionClientToken) {
							throw new Error('PROJECT_SUBMISSION_ITEM_REQUIRED');
						}
						const item = await tx.projectSubmissionItem.findUnique({
							where: { id: input.submissionItemId },
							include: {
								projectSubmission: { select: { projectId: true, actorId: true, state: true } },
								uploadSession: { select: { id: true } },
							},
						});
						if (!item || item.projectSubmission.projectId !== input.projectId
							|| item.projectSubmission.actorId !== input.userId
							|| item.projectSubmission.state !== 'PENDING'
							|| item.kind !== input.kind || item.clientToken !== submissionClientToken
							|| item.state !== 'EXPECTED' || item.uploadSession) {
							throw new Error('PROJECT_SUBMISSION_ITEM_MISMATCH');
						}
					} else if (input.submissionItemId || submissionClientToken) {
						throw new Error('PROJECT_SUBMISSION_ITEM_NOT_ALLOWED');
					}
				} else {
					await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "exhibitions" WHERE "id" = ${input.exhibitionId!} FOR UPDATE`);
					if (input.submissionItemId || submissionClientToken) throw new Error('PROJECT_SUBMISSION_ITEM_NOT_ALLOWED');
				}
				let expected: { id: number; updatedAt: Date | null } | null = null;
				if (input.kind === 'GAME' && input.projectId !== null) {
					expected = await tx.asset.findFirst({
						where: { projectId: input.projectId, kind: 'GAME', status: 'READY' },
						select: { id: true, updatedAt: true },
					});
				} else if (input.kind === 'POSTER') {
					const posterAssetId = input.projectId !== null
						? (await tx.project.findUniqueOrThrow({ where: { id: input.projectId }, select: { posterAssetId: true } })).posterAssetId
						: (await tx.exhibition.findUniqueOrThrow({ where: { id: input.exhibitionId! }, select: { posterAssetId: true } })).posterAssetId;
					if (posterAssetId !== null) {
						const asset = await tx.asset.findUniqueOrThrow({ where: { id: posterAssetId }, select: { updatedAt: true } });
						expected = { id: posterAssetId, updatedAt: asset.updatedAt };
					}
				}
				const created = await tx.assetUploadSession.create({
					data: {
						...sessionInput,
						state: 'ALLOCATING', uploadId: null,
						completionLeaseToken: null, completionLeaseUntil: null,
						validationLeaseToken: null, validationLeaseUntil: null,
						expectedTargetAssetId: expected?.id ?? null,
						expectedTargetAssetUpdatedAt: expected?.updatedAt ?? null,
						resultAssetId: null, resultRepresentationId: null,
						sourceIdentityBlockManifest: input.sourceIdentityBlockManifest as Prisma.InputJsonValue,
					},
				});
				return asRecord(created);
			});
		},
		async expireStaleAllocations(owner: DirectAssetUploadOwner) {
			const ownerColumn = owner.type === 'PROJECT' ? Prisma.raw('"project_id"') : Prisma.raw('"exhibition_id"');
			const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "asset_upload_sessions" SET "state" = 'EXPIRED'::"AssetUploadSessionState", "updated_at" = clock_timestamp()
				WHERE ${ownerColumn} = ${owner.id} AND "state" = 'ALLOCATING'::"AssetUploadSessionState"
					AND "expires_at" <= clock_timestamp() RETURNING "id"
			`);
			return rows.length;
		},
		async failAllocation(input) {
			const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "asset_upload_sessions"
				SET "state" = 'EXPIRED'::"AssetUploadSessionState",
					"completion_error" = ${input.reason.slice(0, 500)},
					"completion_lease_token" = NULL,
					"completion_lease_until" = NULL,
					"updated_at" = clock_timestamp()
				WHERE "id" = ${input.sessionId}
					AND "generation" = ${input.generation}
					AND "state" = 'ALLOCATING'::"AssetUploadSessionState"
					AND "upload_id" IS NULL
				RETURNING "id"
			`);
			return rows.length === 1;
		},
		async setAllocated(sessionId, generation, uploadId) {
			const result = await client.assetUploadSession.updateMany({
				where: { id: sessionId, generation, state: 'ALLOCATING', uploadId: null },
				data: { state: 'UPLOADING', uploadId },
			});
			return result.count === 1;
		},
		async cancel(sessionId, actorId) {
			return client.$transaction(async (tx) => {
				const session = await tx.assetUploadSession.findUnique({ where: { id: sessionId } });
				if (!session || session.userId !== actorId || !['ALLOCATING', 'UPLOADING'].includes(session.state)) return { cancelled: false };
				const updated = await tx.assetUploadSession.updateMany({
					where: { id: sessionId, state: { in: ['ALLOCATING', 'UPLOADING'] } },
					data: { state: 'CANCELLED', uploadId: null, completionLeaseToken: null, completionLeaseUntil: null },
				});
				if (!updated.count) return { cancelled: false };
				if (session.uploadId) {
					await queueMultipartAbortTask(tx, { bucket: session.bucket, storageKey: session.objectKey, uploadId: session.uploadId, reason: 'direct-asset-upload-cancelled', uploadSessionId: session.id });
					return { cancelled: true, abort: { bucket: session.bucket, objectKey: session.objectKey, uploadId: session.uploadId } };
				}
				return { cancelled: true };
			});
		},
		async findById(sessionId) {
			const value = await client.assetUploadSession.findUnique({ where: { id: sessionId } });
			return value ? asRecord(value) : null;
		},
		async reservePartCapabilities(input) {
			return client.$transaction(async (tx) => {
				await tx.$queryRaw(Prisma.sql`
					SELECT "id" FROM "asset_upload_sessions" WHERE "id" = ${input.sessionId} FOR UPDATE
				`);
				const session = await tx.assetUploadSession.findUnique({ where: { id: input.sessionId } });
				if (!session || session.state !== 'UPLOADING' || session.generation !== input.generation || !session.uploadId || session.expiresAt <= new Date()) {
					throw new Error('DIRECT_UPLOAD_CAPABILITY_REJECTED');
				}
				// Keep this repository source buildable when a local generated client
				// predates the contract migration. The Phase 2 database contract and
				// final Prisma schema both use these canonical capability names.
				const capabilitySession = session as typeof session & {
					partCapabilityIssuedCount: number;
					partCapabilityFirstIssuedAt: Date | null;
					partCapabilityLastIssuedAt: Date | null;
				};
				const now = (await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`))[0]!.now;
				// This is deliberately a session-lifetime counter. It never resets, which
				// keeps replacement-capability abuse bounded across API restarts and
				// retry storms. The initial `totalParts` grants one capability per part;
				// only `maxRefreshIssues` additional capabilities may be minted.
				const count = reservePartCapabilityCount({
					totalParts: capabilitySession.totalParts,
					issued: capabilitySession.partCapabilityIssuedCount,
					requested: input.partCount,
					maxRefreshIssues: input.maxRefreshIssues,
				});
				const updated = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
					UPDATE "asset_upload_sessions"
					SET "part_capability_issued_count" = ${count},
						"part_capability_first_issued_at" = COALESCE("part_capability_first_issued_at", ${now}),
						"part_capability_last_issued_at" = ${now},
						"updated_at" = clock_timestamp()
					WHERE "id" = ${input.sessionId}
					RETURNING "id"
				`);
				if (updated.length !== 1) throw new Error('DIRECT_UPLOAD_CAPABILITY_REJECTED');
				return asRecord({
					...capabilitySession,
					partCapabilityIssuedCount: count,
					partCapabilityFirstIssuedAt: capabilitySession.partCapabilityFirstIssuedAt ?? now,
					partCapabilityLastIssuedAt: now,
				});
			});
		},
		async claimCompletion(input) {
			const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "asset_upload_sessions"
				SET "state" = 'COMPLETING'::"AssetUploadSessionState",
					"completion_lease_token" = ${input.token},
					"completion_lease_until" = clock_timestamp() + (${input.leaseMs} * INTERVAL '1 millisecond'),
					"completion_error" = NULL,
					"updated_at" = clock_timestamp()
				WHERE "id" = ${input.sessionId}
					AND "generation" = ${input.generation}
					AND "state" = 'UPLOADING'::"AssetUploadSessionState"
					AND "upload_id" IS NOT NULL
				RETURNING "id"
			`);
			if (rows.length === 1) return 'claimed';
			const session = await client.assetUploadSession.findUnique({ where: { id: input.sessionId } });
			if (!session || session.generation !== input.generation) return 'stale';
			return session.state === 'COMPLETING' ? 'busy' : 'invalid';
		},
		async renewCompletion(sessionId, token, leaseMs) {
			const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "asset_upload_sessions"
				SET "completion_lease_until" = clock_timestamp() + (${leaseMs} * INTERVAL '1 millisecond'), "updated_at" = clock_timestamp()
				WHERE "id" = ${sessionId} AND "state" = 'COMPLETING'::"AssetUploadSessionState"
					AND "completion_lease_token" = ${token} AND "completion_lease_until" > clock_timestamp()
				RETURNING "id"
			`);
			return rows.length === 1;
		},
		async markVerifying(input) {
			return client.$transaction(async (tx) => {
				const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
					UPDATE "asset_upload_sessions"
					SET "state" = 'VERIFYING'::"AssetUploadSessionState", "upload_id" = NULL,
						"completion_lease_token" = NULL, "completion_lease_until" = NULL,
						"completion_result" = ${input.result}, "completed_at" = clock_timestamp(), "updated_at" = clock_timestamp()
					WHERE "id" = ${input.sessionId} AND "generation" = ${input.generation}
						AND "state" = 'COMPLETING'::"AssetUploadSessionState" AND "completion_lease_token" = ${input.token}
						AND "completion_lease_until" > clock_timestamp()
					RETURNING "id"
				`);
				if (rows.length !== 1) return false;
				assertCompletionProof(input.result, input);

				// A WEBGL source is itself a canonical asset representation before the
				// worker publishes its immutable public deployment.  GAME deliberately
				// waits until validation succeeds, so an invalid archive never becomes a
				// user-visible GAME asset.
				const session = await tx.assetUploadSession.findUniqueOrThrow({ where: { id: input.sessionId } });
				if (session.kind !== 'WEBGL') return true;
				const asset = await tx.asset.create({
					data: {
						projectId: session.projectId,
						kind: 'WEBGL',
						status: 'VERIFYING',
						originalName: session.originalName,
					},
				});
				const representation = await tx.assetRepresentation.create({
					data: {
						assetId: asset.id,
						role: 'WEBGL_SOURCE',
						bucket: session.bucket,
						objectKey: session.objectKey,
						mimeType: session.declaredMimeType,
						sizeBytes: session.totalBytes,
						sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
						sourceIdentity: session.sourceIdentity,
						...(completionEtag(session.completionResult) ? { etag: completionEtag(session.completionResult) } : {}),
						state: 'VERIFYING',
					},
				});
				await tx.assetUploadSession.update({
					where: { id: session.id },
					data: { resultAssetId: asset.id, resultRepresentationId: representation.id },
				});
				return true;
			});
		},
		async revertUploading(sessionId, generation, token, error) {
			const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "asset_upload_sessions"
				SET "state" = 'UPLOADING'::"AssetUploadSessionState",
					"completion_lease_token" = NULL,
					"completion_lease_until" = NULL,
					"completion_error" = ${error.slice(0, 500)},
					"updated_at" = clock_timestamp()
				WHERE "id" = ${sessionId}
					AND "generation" = ${generation}
					AND "state" = 'COMPLETING'::"AssetUploadSessionState"
					AND "completion_lease_token" = ${token}
					AND "completion_lease_until" > clock_timestamp()
				RETURNING "id"
			`);
			return rows.length === 1;
		},
		async queueAbort(input) {
			await client.$transaction((tx) => queueMultipartAbortTask(tx, {
				bucket: input.bucket, storageKey: input.objectKey, uploadId: input.uploadId, reason: input.reason, uploadSessionId: input.sessionId,
			}));
		},
		async claimVerifying(kind, limit, token, leaseMs) {
			const claimed = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				WITH candidates AS (
					SELECT "id" FROM "asset_upload_sessions"
					WHERE "state" = 'VERIFYING'::"AssetUploadSessionState"
						AND "kind" = CAST(${kind} AS "AssetUploadKind")
						AND ("validation_lease_until" IS NULL OR "validation_lease_until" <= clock_timestamp())
					ORDER BY "completed_at", "created_at" LIMIT ${limit} FOR UPDATE SKIP LOCKED
				)
				UPDATE "asset_upload_sessions" AS session
				SET "validation_lease_token" = ${token}, "validation_lease_until" = clock_timestamp() + (${leaseMs} * INTERVAL '1 millisecond'),
					"validation_attempt_count" = "validation_attempt_count" + 1, "updated_at" = clock_timestamp()
				FROM candidates WHERE session."id" = candidates."id" RETURNING session."id"
			`);
			if (!claimed.length) return [];
			return (await client.assetUploadSession.findMany({ where: { id: { in: claimed.map((row) => row.id) }, validationLeaseToken: token } })).map(asRecord);
		},
		async renewValidation(sessionId, token, leaseMs) {
			const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "asset_upload_sessions" SET "validation_lease_until" = clock_timestamp() + (${leaseMs} * INTERVAL '1 millisecond'), "updated_at" = clock_timestamp()
				WHERE "id" = ${sessionId} AND "state" = 'VERIFYING'::"AssetUploadSessionState" AND "validation_lease_token" = ${token}
					AND "validation_lease_until" > clock_timestamp() RETURNING "id"
			`);
			return rows.length === 1;
		},
		async commitGameReady(input) {
			return withAssetMutationTransaction(client, async (tx) => {
				const session = await tx.assetUploadSession.findUnique({ where: { id: input.session.id } });
				const owned = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
					SELECT "id" FROM "asset_upload_sessions"
					WHERE "id" = ${input.session.id} AND "state" = 'VERIFYING'::"AssetUploadSessionState"
						AND "validation_lease_token" = ${input.token} AND "validation_lease_until" > clock_timestamp()
				`);
				if (!session || owned.length !== 1) throw new Error('Validation lease lost');
				const current = await tx.asset.findFirst({ where: { projectId: session.projectId, kind: 'GAME', status: 'READY' }, include: { representations: true } });
				if ((session.expectedTargetAssetId === null && current)
					|| (session.expectedTargetAssetId !== null && (!current || current.id !== session.expectedTargetAssetId || current.updatedAt.getTime() !== session.expectedTargetAssetUpdatedAt?.getTime()))) {
					throw new WorkerGenerationFencedError('GAME');
				}
					if (current) {
					await tx.asset.update({ where: { id: current.id }, data: { status: 'DELETED' } });
					await queueDurableDeletions(tx, current.representations.map((representation) => ({ bucket: representation.bucket, storageKey: representation.objectKey, reason: 'direct-game-replaced' })));
					}
					if (session.projectId === null) throw new Error('GAME session must be project-owned');
					const asset = await createCanonicalAsset(tx, {
						projectId: session.projectId,
						kind: 'GAME',
						originalName: session.originalName,
						representations: [{
							role: 'ORIGINAL',
							bucket: session.bucket,
							objectKey: session.objectKey,
							mimeType: input.mimeType,
							sizeBytes: session.totalBytes,
							state: 'READY',
						}],
					});
				const representation = asset.representations.find((item) => item.role === 'ORIGINAL');
				if (!representation) throw new Error('Canonical GAME representation was not created');
				await tx.assetRepresentation.update({
					where: { id: representation.id },
					data: {
						sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
						sourceIdentity: session.sourceIdentity,
						...(completionEtag(session.completionResult) ? { etag: completionEtag(session.completionResult) } : {}),
						...(input.checksum ? { checksumAlgorithm: 'SHA256', checksum: input.checksum } : {}),
					},
				});
				await tx.assetUploadSession.update({ where: { id: session.id }, data: {
					state: 'READY', resultAssetId: asset.id, resultRepresentationId: representation.id,
					validationLeaseToken: null, validationLeaseUntil: null,
					completionResult: { status: 'READY', assetId: asset.id, representationId: representation.id },
				} });
				return { assetId: asset.id, representationId: representation.id };
			});
		},
		async markRejected(sessionId, generation, token, reason) {
			return client.$transaction(async (tx) => {
				const session = await tx.assetUploadSession.findUnique({ where: { id: sessionId } });
				if (!session) return false;
				const rejected = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
					UPDATE "asset_upload_sessions"
					SET "state" = 'REJECTED'::"AssetUploadSessionState",
						"validation_error" = ${reason.slice(0, 500)},
						"validation_lease_token" = NULL,
						"validation_lease_until" = NULL,
						"updated_at" = clock_timestamp()
					WHERE "id" = ${sessionId} AND "generation" = ${generation}
						AND "state" = 'VERIFYING'::"AssetUploadSessionState"
						AND "validation_lease_token" = ${token}
						AND "validation_lease_until" > clock_timestamp()
					RETURNING "id"
				`);
				if (rejected.length !== 1) return false;
				if (!reason.startsWith('OPERATOR_REQUIRED:')) {
					await queueDurableDeletions(tx, [{ bucket: session.bucket, storageKey: session.objectKey, reason: 'direct-game-validation-rejected' }]);
				}
				return true;
			});
		},
		async expireTimedOutSessions(limit) {
			const batch = recoveryBatchLimit(limit);
			return client.$transaction(async (tx) => {
				// `clock_timestamp()` is deliberately inside the transaction.  An API
				// process with a skewed wall clock must never reclaim another process's
				// active slot early.
				const expired = await tx.$queryRaw<Array<{
					id: string;
					bucket: string;
					objectKey: string;
					uploadId: string | null;
				}>>(Prisma.sql`
					WITH candidates AS (
						SELECT "id", "bucket", "object_key", "upload_id"
						FROM "asset_upload_sessions"
						WHERE "state" IN (
							'ALLOCATING'::"AssetUploadSessionState",
							'UPLOADING'::"AssetUploadSessionState"
						)
						AND "expires_at" <= clock_timestamp()
						ORDER BY "expires_at", "created_at"
						LIMIT ${batch}
						FOR UPDATE SKIP LOCKED
					), expired AS (
						UPDATE "asset_upload_sessions" AS session
						SET "state" = 'EXPIRED'::"AssetUploadSessionState",
							"upload_id" = NULL,
							"completion_lease_token" = NULL,
							"completion_lease_until" = NULL,
							"validation_lease_token" = NULL,
							"validation_lease_until" = NULL,
							"updated_at" = clock_timestamp()
						FROM candidates
						WHERE session."id" = candidates."id"
						RETURNING session."id"
					)
					SELECT candidates."id", candidates."bucket",
						candidates."object_key" AS "objectKey",
						candidates."upload_id" AS "uploadId"
					FROM candidates JOIN expired ON expired."id" = candidates."id"
				`);
				for (const session of expired) {
					if (!session.uploadId) continue;
					await queueMultipartAbortTask(tx, {
						bucket: session.bucket,
						storageKey: session.objectKey,
						uploadId: session.uploadId,
						reason: 'direct-asset-upload-expired',
						uploadSessionId: session.id,
					});
				}
				return {
					expired: expired.length,
					aborts: expired.filter((session) => session.uploadId !== null).length,
				};
			});
		},
		async claimExpiredCompletions(input) {
			const batch = recoveryBatchLimit(input.limit);
			if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1) {
				throw new RangeError('Asset upload completion recovery lease must be positive');
			}
			const claimed = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				WITH candidates AS (
					SELECT "id"
					FROM "asset_upload_sessions"
					WHERE "state" = 'COMPLETING'::"AssetUploadSessionState"
						AND "upload_id" IS NOT NULL
						AND "completion_lease_until" IS NOT NULL
						AND "completion_lease_until" <= clock_timestamp()
					ORDER BY "completion_lease_until", "created_at"
					LIMIT ${batch}
					FOR UPDATE SKIP LOCKED
				)
				UPDATE "asset_upload_sessions" AS session
				SET "completion_lease_token" = ${input.token},
					"completion_lease_until" = clock_timestamp()
						+ (${input.leaseMs} * INTERVAL '1 millisecond'),
					"completion_error" = NULL,
					"updated_at" = clock_timestamp()
				FROM candidates
				WHERE session."id" = candidates."id"
				RETURNING session."id"
			`);
			if (claimed.length === 0) return [];
			return (await client.assetUploadSession.findMany({
				where: {
					id: { in: claimed.map((row) => row.id) },
					state: 'COMPLETING',
					completionLeaseToken: input.token,
				},
			})).map(asRecord);
		},
		async releaseRecoveredCompletion(input) {
			const reason = input.reason.slice(0, 500);
			return client.$transaction(async (tx) => {
				const released = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
					UPDATE "asset_upload_sessions"
					SET "state" = 'UPLOADING'::"AssetUploadSessionState",
						"completion_lease_token" = NULL,
						"completion_lease_until" = NULL,
						"completion_error" = ${reason},
						"updated_at" = clock_timestamp()
					WHERE "id" = ${input.sessionId}
						AND "generation" = ${input.generation}
						AND "state" = 'COMPLETING'::"AssetUploadSessionState"
						AND "completion_lease_token" = ${input.token}
						AND "completion_lease_until" > clock_timestamp()
						AND "expires_at" > clock_timestamp()
					RETURNING "id"
				`);
				if (released.length === 1) return 'released' as const;

				const expiring = await tx.$queryRaw<Array<{
					id: string;
					bucket: string;
					objectKey: string;
					uploadId: string;
				}>>(Prisma.sql`
					SELECT "id", "bucket", "object_key" AS "objectKey", "upload_id" AS "uploadId"
					FROM "asset_upload_sessions"
					WHERE "id" = ${input.sessionId}
						AND "generation" = ${input.generation}
						AND "state" = 'COMPLETING'::"AssetUploadSessionState"
						AND "completion_lease_token" = ${input.token}
						AND "completion_lease_until" > clock_timestamp()
						AND "expires_at" <= clock_timestamp()
					FOR UPDATE
				`);
				const session = expiring[0];
				if (!session) return 'lost' as const;
				await tx.assetUploadSession.update({
					where: { id: session.id },
					data: {
						state: 'EXPIRED',
						uploadId: null,
						completionLeaseToken: null,
						completionLeaseUntil: null,
						completionError: reason,
					},
				});
				await queueMultipartAbortTask(tx, {
					bucket: session.bucket,
					storageKey: session.objectKey,
					uploadId: session.uploadId,
					reason: 'direct-asset-upload-completion-expired',
					uploadSessionId: session.id,
				});
				return 'expired' as const;
			});
		},
		async rejectRecoveredCompletion(input) {
			const reason = input.reason.slice(0, 500);
			return client.$transaction(async (tx) => {
				const rejected = await tx.$queryRaw<Array<{
					bucket: string;
					objectKey: string;
				}>>(Prisma.sql`
					UPDATE "asset_upload_sessions"
					SET "state" = 'REJECTED'::"AssetUploadSessionState",
						"upload_id" = NULL,
						"completion_lease_token" = NULL,
						"completion_lease_until" = NULL,
						"completion_error" = ${reason},
						"validation_error" = ${reason},
						"updated_at" = clock_timestamp()
					WHERE "id" = ${input.sessionId}
						AND "generation" = ${input.generation}
						AND "state" = 'COMPLETING'::"AssetUploadSessionState"
						AND "completion_lease_token" = ${input.token}
						AND "completion_lease_until" > clock_timestamp()
					RETURNING "bucket", "object_key" AS "objectKey"
				`);
				const session = rejected[0];
				if (!session) return false;
				await queueDurableDeletions(tx, [{
					bucket: session.bucket,
					storageKey: session.objectKey,
					reason: 'direct-asset-upload-completion-corrupt',
				}]);
				return true;
			});
		},
		async queueUnknownMultipartAborts(input) {
			const uploads = [...new Map(input.uploads.map((upload) => (
				[`${upload.key}\u0000${upload.uploadId}`, upload] as const
			))).values()];
			if (uploads.length === 0) return 0;
			return client.$transaction(async (tx) => {
				const keys = [...new Set(uploads.map((upload) => upload.key))];
				const active = await tx.$queryRaw<Array<{ objectKey: string }>>(Prisma.sql`
					SELECT "object_key" AS "objectKey"
					FROM "asset_upload_sessions"
					WHERE "bucket" = ${input.bucket}
						AND "object_key" IN (${Prisma.join(keys)})
						AND "state" IN (
							'ALLOCATING'::"AssetUploadSessionState",
							'UPLOADING'::"AssetUploadSessionState",
							'COMPLETING'::"AssetUploadSessionState"
						)
					FOR UPDATE
				`);
				const activeKeys = new Set(active.map((session) => session.objectKey));
				const unknown = uploads.filter((upload) => !activeKeys.has(upload.key));
				for (const upload of unknown) {
					await queueMultipartAbortTask(tx, {
						bucket: input.bucket,
						storageKey: upload.key,
						uploadId: upload.uploadId,
						reason: 'direct-asset-upload-untracked-multipart-recovery',
					});
				}
				return unknown.length;
			});
		},
	};
}
