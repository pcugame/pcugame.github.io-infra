import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { createCanonicalAsset } from '../assets/representation-write.js';
import { withAssetMutationTransaction } from '../assets/mutation-transaction.js';
import { queueDurableDeletions } from '../orphan/outbox.js';
import { queueMultipartAbortTask } from '../multipart-abort/repository.js';
import type { AssetUploadRepository, AssetUploadSessionRecord, DirectAssetUploadOwner } from './ports.js';

function asRecord(value: unknown): AssetUploadSessionRecord {
	return value as AssetUploadSessionRecord;
}

function completionEtag(value: unknown): string | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const etag = (value as Record<string, unknown>).etag;
	return typeof etag === 'string' && etag.length > 0 ? etag : undefined;
}

export function createAssetUploadRepository(client: PrismaClient): AssetUploadRepository {
	return {
		async createAllocating(input) {
			return withAssetMutationTransaction(client, async (tx) => {
				// The snapshot and active-session insert share a serializable scope so a
				// later READY replacement cannot silently overwrite a newer GAME.
				if ((input.projectId === null) === (input.exhibitionId === null)) {
					throw new Error('Direct upload session requires exactly one owner');
				}
				if (input.projectId !== null) {
					await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "projects" WHERE "id" = ${input.projectId} FOR UPDATE`);
				} else {
					await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "exhibitions" WHERE "id" = ${input.exhibitionId!} FOR UPDATE`);
				}
				const expected = input.kind === 'GAME' && input.projectId !== null
					? await tx.asset.findFirst({
						where: { projectId: input.projectId, kind: 'GAME', status: 'READY' },
						select: { id: true, updatedAt: true },
					})
					: null;
				const created = await tx.assetUploadSession.create({
					data: {
						...input,
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
				const now = (await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`))[0]!.now;
				const reset = !session.partUrlIssueWindowStartedAt
					|| now.getTime() - session.partUrlIssueWindowStartedAt.getTime() >= input.windowMs;
				const count = (reset ? 0 : session.partUrlIssueWindowCount) + input.partCount;
				if (count > input.maxIssues) throw new Error('DIRECT_UPLOAD_CAPABILITY_QUOTA');
				const updated = await tx.assetUploadSession.update({
					where: { id: input.sessionId },
					data: {
						partUrlIssueWindowCount: count,
						partUrlIssueWindowStartedAt: reset ? now : session.partUrlIssueWindowStartedAt,
						partUrlLastIssuedAt: now,
					},
				});
				return asRecord(updated);
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
						mimeType: session.declaredMimeType,
						sizeBytes: session.totalBytes,
						isPublic: false,
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
		async revertUploading(sessionId, token, error) {
			const result = await client.assetUploadSession.updateMany({
				where: { id: sessionId, state: 'COMPLETING', completionLeaseToken: token },
				data: { state: 'UPLOADING', completionLeaseToken: null, completionLeaseUntil: null, completionError: error.slice(0, 500) },
			});
			return result.count === 1;
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
					throw new Error('GAME_REPLACEMENT_FENCE_LOST');
				}
					if (current) {
					await tx.asset.update({ where: { id: current.id }, data: { status: 'DELETED' } });
					await queueDurableDeletions(tx, current.representations.map((representation) => ({ bucket: representation.bucket, storageKey: representation.objectKey, reason: 'direct-game-replaced' })));
					}
					if (session.projectId === null) throw new Error('GAME session must be project-owned');
					const asset = await createCanonicalAsset(tx, {
					projectId: session.projectId, kind: 'GAME', originalBucket: session.bucket, storageKey: session.objectKey,
					originalName: session.originalName, mimeType: input.mimeType, sizeBytes: session.totalBytes, isPublic: false,
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
		async markRejected(sessionId, token, reason) {
			return client.$transaction(async (tx) => {
				const session = await tx.assetUploadSession.findUnique({ where: { id: sessionId } });
				if (!session || session.state !== 'VERIFYING' || session.validationLeaseToken !== token) return false;
				const result = await tx.assetUploadSession.updateMany({
					where: { id: sessionId, state: 'VERIFYING', validationLeaseToken: token },
					data: { state: 'REJECTED', validationError: reason.slice(0, 500), validationLeaseToken: null, validationLeaseUntil: null },
				});
				if (!result.count) return false;
				await queueDurableDeletions(tx, [{ bucket: session.bucket, storageKey: session.objectKey, reason: 'direct-game-validation-rejected' }]);
				return true;
			});
		},
	};
}
