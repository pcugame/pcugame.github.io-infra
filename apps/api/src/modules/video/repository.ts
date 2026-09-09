import { nextProjectVideoOrder } from '../assets/video-order.js';
import {
	Prisma,
	type AssetUploadSession,
	type PrismaClient,
} from '../../generated/prisma/client.js';
import { createCanonicalAsset } from '../assets/representation-write.js';
import { withAssetMutationTransaction } from '../assets/mutation-transaction.js';
import { assertNoDeletionClaim } from '../orphan/reference-resolver.js';
import { queueDurableDeletions } from '../orphan/outbox.js';
import { commitUploadIntents } from '../upload-intent/repository.js';
import type {
	GeneratedPlaybackIntent,
	VerifyingVideoSession,
	VideoWorkerRepository,
} from './ports.js';

const SERIALIZABLE = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;
const PLAYBACK_PURPOSE = 'direct-video-playback-generation';

function asVideoSession(value: AssetUploadSession): VerifyingVideoSession {
	if (
		value.projectId === null
		|| value.exhibitionId !== null
		|| value.kind !== 'VIDEO'
		|| value.state !== 'VERIFYING'
	) {
		throw new Error('Claimed VIDEO upload session must be project-owned and VERIFYING');
	}
	return {
		id: value.id,
		projectId: value.projectId,
		userId: value.userId,
		kind: value.kind,
		state: value.state,
		originalName: value.originalName,
		declaredMimeType: value.declaredMimeType,
		totalBytes: value.totalBytes,
		bucket: value.bucket,
		objectKey: value.objectKey,
		generation: value.generation,
		sourceIdentityAlgorithm: value.sourceIdentityAlgorithm,
		sourceIdentity: value.sourceIdentity,
		sourceIdentityBlockSizeBytes: value.sourceIdentityBlockSizeBytes,
		sourceIdentityBlockManifest: value.sourceIdentityBlockManifest,
		validationLeaseToken: value.validationLeaseToken,
		validationLeaseUntil: value.validationLeaseUntil,
	};
}

export function createVideoWorkerRepository(client: PrismaClient): VideoWorkerRepository {
	return {
		async claimVideoVerifying(limit, token, leaseMs) {
			const claimed = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				WITH candidates AS (
					SELECT "id"
					FROM "asset_upload_sessions"
					WHERE "kind" = 'VIDEO'::"AssetUploadKind"
						AND "state" = 'VERIFYING'::"AssetUploadSessionState"
						AND "project_id" IS NOT NULL
						AND "exhibition_id" IS NULL
						AND ("validation_lease_until" IS NULL OR "validation_lease_until" <= clock_timestamp())
					ORDER BY "completed_at", "created_at"
					LIMIT ${limit}
					FOR UPDATE SKIP LOCKED
				)
				UPDATE "asset_upload_sessions" AS session
				SET "validation_lease_token" = ${token},
					"validation_lease_until" = clock_timestamp() + (${leaseMs} * INTERVAL '1 millisecond'),
					"validation_attempt_count" = "validation_attempt_count" + 1,
					"updated_at" = clock_timestamp()
				FROM candidates
				WHERE session."id" = candidates."id"
				RETURNING session."id"
			`);
			if (claimed.length === 0) return [];
			const sessions = await client.assetUploadSession.findMany({
				where: {
					id: { in: claimed.map(({ id }) => id) },
					kind: 'VIDEO',
					state: 'VERIFYING',
					projectId: { not: null },
					exhibitionId: null,
					validationLeaseToken: token,
				},
			});
			return sessions.map(asVideoSession);
		},

		async renewVideoLease(sessionId, token, leaseMs) {
			const renewed = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "asset_upload_sessions"
				SET "validation_lease_until" = clock_timestamp() + (${leaseMs} * INTERVAL '1 millisecond'),
					"updated_at" = clock_timestamp()
				WHERE "id" = ${sessionId}
					AND "kind" = 'VIDEO'::"AssetUploadKind"
					AND "state" = 'VERIFYING'::"AssetUploadSessionState"
					AND "project_id" IS NOT NULL
					AND "exhibition_id" IS NULL
					AND "validation_lease_token" = ${token}
					AND "validation_lease_until" > clock_timestamp()
				RETURNING "id"
			`);
			return renewed.length === 1;
		},

		async preparePlaybackIntent(input): Promise<GeneratedPlaybackIntent> {
			const existing = await client.uploadIntent.findUnique({
				where: {
					upload_intent_bucket_storage_key: {
						bucket: input.bucket,
						storageKey: input.objectKey,
					},
				},
				select: {
					id: true,
					state: true,
					purpose: true,
					ownerOperationId: true,
					ownerProjectId: true,
				},
			});
			if (existing) {
				const sameOwner = existing.purpose === PLAYBACK_PURPOSE
					&& existing.ownerOperationId === input.session.id
					&& existing.ownerProjectId === input.session.projectId;
				if (sameOwner && (existing.state === 'PREPARED' || existing.state === 'UPLOADED')) {
					return { id: existing.id, state: existing.state };
				}
				throw new Error(`Playback object is already owned in state ${existing.state}`);
			}
			return client.$transaction(async (tx) => {
				await assertNoDeletionClaim(tx, { bucket: input.bucket, key: input.objectKey });
				const intent = await tx.uploadIntent.create({
					data: {
						bucket: input.bucket,
						storageKey: input.objectKey,
						purpose: PLAYBACK_PURPOSE,
						ownerOperationId: input.session.id,
						ownerActorId: input.session.userId,
						ownerProjectId: input.session.projectId,
						notBefore: input.notBefore,
					},
				});
				return { id: intent.id, state: 'PREPARED' as const };
			}, SERIALIZABLE);
		},

		async markPlaybackUploaded(intentId) {
			const updated = await client.uploadIntent.updateMany({
				where: { id: intentId, state: 'PREPARED' },
				data: { state: 'UPLOADED', lastError: null },
			});
			if (updated.count === 1) return;
			const current = await client.uploadIntent.findUnique({
				where: { id: intentId },
				select: { state: true },
			});
			if (current?.state !== 'UPLOADED') throw new Error('Playback upload intent was lost');
		},

		commitVideoReady(input) {
			return withAssetMutationTransaction(client, async (tx) => {
				await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "projects" WHERE "id" = ${input.session.projectId} FOR UPDATE`);
				const session = await tx.assetUploadSession.findUnique({ where: { id: input.session.id } });
				if (!session || session.projectId === null || session.exhibitionId !== null) {
					throw new Error('VIDEO upload session must be project-owned');
				}
				const owned = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
					SELECT "id" FROM "asset_upload_sessions"
					WHERE "id" = ${input.session.id}
						AND "kind" = 'VIDEO'::"AssetUploadKind"
						AND "state" = 'VERIFYING'::"AssetUploadSessionState"
						AND "project_id" IS NOT NULL
						AND "exhibition_id" IS NULL
						AND "validation_lease_token" = ${input.token}
						AND "validation_lease_until" > clock_timestamp()
				`);
				if (owned.length !== 1) {
					throw new Error('VIDEO validation lease lost');
				}
				const videoSortOrder = await nextProjectVideoOrder(tx, session.projectId, session.id);
				const separatePlayback = input.playback.objectKey !== session.objectKey
					|| input.playback.bucket !== session.bucket;
				const asset = await createCanonicalAsset(tx, {
					projectId: session.projectId,
					kind: 'VIDEO',
					videoSortOrder,
					originalBucket: session.bucket,
					storageKey: session.objectKey,
					playbackBucket: input.playback.bucket,
					playbackStorageKey: separatePlayback ? input.playback.objectKey : null,
					originalName: session.originalName,
					mimeType: input.originalMimeType,
					playbackMimeType: input.playback.mimeType,
					sizeBytes: input.originalSizeBytes,
					playbackSizeBytes: input.playback.sizeBytes,
					playbackStatus: 'READY',
					isPublic: false,
				});
				const original = asset.representations.find(({ role }) => role === 'ORIGINAL');
				const playback = asset.representations.find(({ role }) => role === 'PLAYBACK');
				if (!original || !playback) throw new Error('Canonical VIDEO representations were not created');
				await tx.assetRepresentation.update({
					where: { id: original.id },
					data: {
						sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
						sourceIdentity: session.sourceIdentity,
						...(input.originalEtag ? { etag: input.originalEtag } : {}),
					},
				});
				if (!separatePlayback) {
					await tx.assetRepresentation.update({
						where: { id: playback.id },
						data: {
							sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
							sourceIdentity: session.sourceIdentity,
							...(input.originalEtag ? { etag: input.originalEtag } : {}),
						},
					});
				}
				await commitUploadIntents(tx, input.playback.intentId ? [input.playback.intentId] : []);
				await tx.assetUploadSession.update({
					where: { id: session.id },
					data: {
						state: 'READY',
						resultAssetId: asset.id,
						resultRepresentationId: original.id,
						validationLeaseToken: null,
						validationLeaseUntil: null,
						validationError: null,
						completionResult: {
							status: 'READY',
							assetId: asset.id,
							originalRepresentationId: original.id,
							playbackRepresentationId: playback.id,
						},
					},
				});
				return {
					assetId: asset.id,
					originalRepresentationId: original.id,
					playbackRepresentationId: playback.id,
				};
			});
		},

		async rejectVideo(input) {
			return client.$transaction(async (tx) => {
				const playbackIntent = input.playbackIntentId
					? await tx.uploadIntent.findUnique({
						where: { id: input.playbackIntentId },
						select: { bucket: true, storageKey: true },
					})
					: null;
				const rejected = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
					UPDATE "asset_upload_sessions"
					SET "state" = 'REJECTED'::"AssetUploadSessionState",
						"validation_error" = ${input.reason.slice(0, 500)},
						"validation_lease_token" = NULL,
						"validation_lease_until" = NULL,
						"updated_at" = clock_timestamp()
					WHERE "id" = ${input.session.id}
						AND "kind" = 'VIDEO'::"AssetUploadKind"
						AND "state" = 'VERIFYING'::"AssetUploadSessionState"
						AND "validation_lease_token" = ${input.token}
						AND "validation_lease_until" > clock_timestamp()
					RETURNING "id"
				`);
				if (rejected.length !== 1) return false;
				const targets = [{
					bucket: input.session.bucket,
					storageKey: input.session.objectKey,
					reason: 'direct-video-rejected-source',
				}];
				if (playbackIntent || input.playbackObjectKey) targets.push({
					bucket: playbackIntent?.bucket ?? input.session.bucket,
					storageKey: playbackIntent?.storageKey ?? input.playbackObjectKey!,
					reason: 'direct-video-rejected-playback',
				});
				await queueDurableDeletions(tx, targets);
				if (input.playbackIntentId) {
					await tx.uploadIntent.updateMany({
						where: { id: input.playbackIntentId, state: { in: ['PREPARED', 'UPLOADED'] } },
						data: { state: 'CLEANUP_QUEUED', claimToken: null, claimUntil: null },
					});
				}
				return true;
			}, SERIALIZABLE);
		},
	};
}
