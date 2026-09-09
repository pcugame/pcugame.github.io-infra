import {
	Prisma,
	type AssetUploadSession,
	type PrismaClient,
} from '../../generated/prisma/client.js';
import { withAssetMutationTransaction } from '../assets/mutation-transaction.js';
import { assertNoDeletionClaim } from '../orphan/reference-resolver.js';
import { queueDurableDeletions } from '../orphan/outbox.js';
import { commitUploadIntents } from '../upload-intent/repository.js';
import { assertProjectUploadWriteAccessInTransaction } from '../admin/project-access.service.js';
import type {
	GeneratedPlaybackIntent,
	VerifyingVideoSession,
	VideoWorkerRepository,
} from './ports.js';
import { videoPlaybackObjectKey } from './playback-identity.js';
import { countReservedProjectVideos, getProjectVideos, MAX_PROJECT_VIDEOS, normalizeProjectVideoOrder } from '../assets/video-order.js';
import { conflict } from '../../shared/errors.js';

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
		validationAttemptCount: value.validationAttemptCount,
		resultAssetId: value.resultAssetId,
		resultRepresentationId: value.resultRepresentationId,
		completionResult: value.completionResult,
	};
}

function assertSourceFence(
	stored: AssetUploadSession,
	claimed: VerifyingVideoSession,
): void {
	if (
		stored.generation !== claimed.generation
		|| stored.bucket !== claimed.bucket
		|| stored.objectKey !== claimed.objectKey
		|| stored.sourceIdentityAlgorithm !== claimed.sourceIdentityAlgorithm
		|| stored.sourceIdentity !== claimed.sourceIdentity
	) {
		throw new Error('VIDEO source generation fence lost');
	}
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

		commitVideoOriginalReady(input) {
			return withAssetMutationTransaction(client, async (tx) => {
				const session = await tx.assetUploadSession.findUnique({ where: { id: input.session.id } });
				if (!session || session.projectId === null || session.exhibitionId !== null) {
					throw new Error('VIDEO upload session must be project-owned');
				}
				const actor = await tx.user.findUniqueOrThrow({ where: { id: session.userId }, select: { id: true, role: true } });
				await assertProjectUploadWriteAccessInTransaction(tx, actor, session.projectId);
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
				assertSourceFence(session, input.session);

				if (session.resultAssetId !== null || session.resultRepresentationId !== null) {
					if (session.resultAssetId === null || session.resultRepresentationId === null) {
						throw new Error('VIDEO canonical result pointer is incomplete');
					}
					const existing = await tx.asset.findUnique({
						where: { id: session.resultAssetId },
						include: { representations: true },
					});
					const original = existing?.representations.find(({ role }) => role === 'ORIGINAL');
					const playback = existing?.representations.find(({ role }) => role === 'PLAYBACK');
					if (!existing || existing.projectId !== session.projectId || existing.kind !== 'VIDEO'
						|| existing.status !== 'READY' || original?.id !== session.resultRepresentationId
						|| original.state !== 'READY' || original.bucket !== session.bucket
						|| original.objectKey !== session.objectKey
						|| original.sourceIdentityAlgorithm !== session.sourceIdentityAlgorithm
						|| original.sourceIdentity !== session.sourceIdentity
						|| !playback || playback.bucket !== input.playback.bucket
						|| playback.objectKey !== input.playback.objectKey) {
						throw new Error('VIDEO canonical source identity fence lost');
					}
					if (playback.state === 'FAILED') {
						await tx.assetRepresentation.update({
							where: { id: playback.id },
							data: { state: 'VERIFYING', error: null },
						});
					} else if (playback.state !== 'VERIFYING' && playback.state !== 'READY') {
						throw new Error(`VIDEO playback cannot resume from ${playback.state}`);
					}
					return {
						assetId: existing.id,
						originalRepresentationId: original.id,
						playbackRepresentationId: playback.id,
						playbackState: playback.state === 'READY' ? 'READY' as const : 'VERIFYING' as const,
					};
				}

				// Submission slots are durable order reservations: workers may finish
				// in any order, so do not compact their temporarily sparse sequence.
				const videos = session.submissionItemId
					? await getProjectVideos(tx, session.projectId)
					: await normalizeProjectVideoOrder(tx, session.projectId);
				const reserved = await countReservedProjectVideos(tx, session.projectId, session.id);
				if (videos.length + reserved + 1 > MAX_PROJECT_VIDEOS) throw conflict('A project supports at most 5 videos');
				let videoSortOrder = videos.length;
				if (session.submissionItemId) {
					const item = await tx.projectSubmissionItem.findUnique({
						where: { id: session.submissionItemId },
						include: { projectSubmission: { select: { projectId: true, state: true } } },
					});
					if (!item || item.kind !== 'VIDEO' || !/^video:[0-4]$/.test(item.slot)
						|| item.projectSubmission.projectId !== session.projectId || item.projectSubmission.state !== 'PENDING') {
						throw conflict('VIDEO upload does not match a pending submission slot');
					}
					videoSortOrder = Number(item.slot.slice('video:'.length));
				}
				const asset = await tx.asset.create({
					data: {
						projectId: session.projectId,
						kind: 'VIDEO',
						videoSortOrder,
						status: 'READY',
						originalName: session.originalName,
						representations: {
							create: [{
								role: 'ORIGINAL',
								bucket: session.bucket,
								objectKey: session.objectKey,
								mimeType: input.originalMimeType,
								sizeBytes: input.originalSizeBytes,
								sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
								sourceIdentity: session.sourceIdentity,
								...(input.originalEtag ? { etag: input.originalEtag } : {}),
								state: 'READY',
							}, {
								role: 'PLAYBACK',
								bucket: input.playback.bucket,
								objectKey: input.playback.objectKey,
								mimeType: input.playback.mimeType,
								sizeBytes: 0n,
								state: 'VERIFYING',
							}],
						},
					},
					include: { representations: true },
				});
				const original = asset.representations.find(({ role }) => role === 'ORIGINAL');
				const playback = asset.representations.find(({ role }) => role === 'PLAYBACK');
				if (!original || !playback) throw new Error('Canonical VIDEO representations were not created');
				await tx.assetUploadSession.update({
					where: { id: session.id },
					data: {
						resultAssetId: asset.id,
						resultRepresentationId: original.id,
						validationError: null,
						completionResult: {
							status: 'VERIFYING',
							phase: 'PLAYBACK',
							generation: session.generation,
							sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
							sourceIdentity: session.sourceIdentity,
							assetId: asset.id,
							originalRepresentationId: original.id,
							playbackRepresentationId: playback.id,
						},
					},
				});
				await tx.project.update({ where: { id: session.projectId }, data: { version: { increment: 1 } } });
				return {
					assetId: asset.id,
					originalRepresentationId: original.id,
					playbackRepresentationId: playback.id,
					playbackState: 'VERIFYING' as const,
				};
			});
		},

		commitVideoPlaybackReady(input) {
			return withAssetMutationTransaction(client, async (tx) => {
				const session = await tx.assetUploadSession.findUnique({ where: { id: input.session.id } });
				const owned = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
					SELECT "id" FROM "asset_upload_sessions"
					WHERE "id" = ${input.session.id}
						AND "kind" = 'VIDEO'::"AssetUploadKind"
						AND "state" = 'VERIFYING'::"AssetUploadSessionState"
						AND "validation_lease_token" = ${input.token}
						AND "validation_lease_until" > clock_timestamp()
				`);
				if (!session || owned.length !== 1) throw new Error('VIDEO validation lease lost');
				assertSourceFence(session, input.session);
				if (session.resultAssetId !== input.assetId
					|| session.resultRepresentationId !== input.originalRepresentationId) {
					throw new Error('VIDEO canonical result fence lost');
				}
				const asset = await tx.asset.findUnique({
					where: { id: input.assetId },
					include: { representations: true },
				});
				const original = asset?.representations.find(({ id }) => id === input.originalRepresentationId);
				const playback = asset?.representations.find(({ id }) => id === input.playbackRepresentationId);
				if (!asset || asset.kind !== 'VIDEO' || asset.projectId !== session.projectId
					|| asset.status !== 'READY' || original?.role !== 'ORIGINAL' || original.state !== 'READY'
					|| original.bucket !== session.bucket || original.objectKey !== session.objectKey
					|| original.sourceIdentityAlgorithm !== session.sourceIdentityAlgorithm
					|| original.sourceIdentity !== session.sourceIdentity
					|| playback?.role !== 'PLAYBACK'
					|| playback.bucket !== input.playback.bucket
					|| playback.objectKey !== input.playback.objectKey
					|| (playback.state !== 'VERIFYING' && playback.state !== 'READY')) {
					throw new Error('VIDEO playback representation fence lost');
				}
				const sharesSource = input.playback.bucket === session.bucket
					&& input.playback.objectKey === session.objectKey;
				await tx.assetRepresentation.update({
					where: { id: playback.id },
					data: {
						mimeType: input.playback.mimeType,
						sizeBytes: input.playback.sizeBytes,
						state: 'READY',
						error: null,
						...(sharesSource ? {
							sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
							sourceIdentity: session.sourceIdentity,
							...(original.etag ? { etag: original.etag } : {}),
						} : input.playback.checksumSha256 ? {
							checksumAlgorithm: 'SHA256', checksum: input.playback.checksumSha256,
						} : {}),
					},
				});
				await commitUploadIntents(tx, input.playback.intentId ? [input.playback.intentId] : []);
				await tx.assetUploadSession.update({
					where: { id: session.id },
					data: {
						state: 'READY',
						validationLeaseToken: null,
						validationLeaseUntil: null,
						validationError: null,
						completionResult: {
							status: 'READY',
							generation: session.generation,
							sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
							sourceIdentity: session.sourceIdentity,
							assetId: asset.id,
							originalRepresentationId: original.id,
							playbackRepresentationId: playback.id,
							playbackState: 'READY',
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

		commitVideoPlaybackFailed(input) {
			return withAssetMutationTransaction(client, async (tx) => {
				const session = await tx.assetUploadSession.findUnique({ where: { id: input.session.id } });
				const owned = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
					SELECT "id" FROM "asset_upload_sessions"
					WHERE "id" = ${input.session.id}
						AND "kind" = 'VIDEO'::"AssetUploadKind"
						AND "state" = 'VERIFYING'::"AssetUploadSessionState"
						AND "validation_lease_token" = ${input.token}
						AND "validation_lease_until" > clock_timestamp()
				`);
				if (!session || owned.length !== 1) return false;
				assertSourceFence(session, input.session);
				if (session.resultAssetId !== input.assetId
					|| session.resultRepresentationId !== input.originalRepresentationId) return false;
				const asset = await tx.asset.findUnique({
					where: { id: input.assetId },
					include: { representations: true },
				});
				const original = asset?.representations.find(({ id }) => id === input.originalRepresentationId);
				const playback = asset?.representations.find(({ id }) => id === input.playbackRepresentationId);
				if (!asset || asset.kind !== 'VIDEO' || asset.projectId !== session.projectId
					|| asset.status !== 'READY'
					|| original?.role !== 'ORIGINAL' || original.state !== 'READY'
					|| original.bucket !== session.bucket || original.objectKey !== session.objectKey
					|| original.sourceIdentityAlgorithm !== session.sourceIdentityAlgorithm
					|| original.sourceIdentity !== session.sourceIdentity
					|| playback?.role !== 'PLAYBACK' || playback.state !== 'VERIFYING') return false;
				const reason = input.reason.slice(0, 2_000);
				await tx.assetRepresentation.update({
					where: { id: playback.id },
					data: { state: 'FAILED', error: reason },
				});
				await tx.assetUploadSession.update({
					where: { id: session.id },
					data: {
						state: 'READY',
						validationLeaseToken: null,
						validationLeaseUntil: null,
						validationError: null,
						completionResult: {
							status: 'READY',
							generation: session.generation,
							sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
							sourceIdentity: session.sourceIdentity,
							assetId: asset.id,
							originalRepresentationId: original.id,
							playbackRepresentationId: playback.id,
							playbackState: 'FAILED',
							playbackError: reason,
						},
					},
				});
				return true;
			});
		},

		requestPlaybackRepair(input) {
			return withAssetMutationTransaction(client, async (tx) => {
				await tx.$queryRaw(Prisma.sql`
					SELECT "id" FROM "asset_upload_sessions" WHERE "id" = ${input.sessionId} FOR UPDATE
				`);
				const frozen = await tx.$queryRaw<Array<{ frozen: boolean }>>(Prisma.sql`
					SELECT EXISTS (
						SELECT 1
						FROM "asset_upload_sessions" session
						JOIN "project_submission_items" item ON item."id" = session."submission_item_id"
						JOIN "project_submissions" submission ON submission."id" = item."submission_id"
						WHERE session."id" = ${input.sessionId}
							AND submission."state" = 'FINALIZING'::"ProjectSubmissionState"
					) AS "frozen"
				`);
				if (frozen[0]?.frozen) return false;
				const session = await tx.assetUploadSession.findUnique({ where: { id: input.sessionId } });
				if (!session || session.kind !== 'VIDEO' || session.state !== 'READY'
					|| session.projectId === null || session.exhibitionId !== null
					|| session.generation !== input.generation
					|| session.sourceIdentityAlgorithm !== input.sourceIdentityAlgorithm
					|| session.sourceIdentity !== input.sourceIdentity
					|| session.resultAssetId === null || session.resultRepresentationId === null) return false;
				const asset = await tx.asset.findUnique({
					where: { id: session.resultAssetId },
					include: { representations: true },
				});
				const original = asset?.representations.find(({ id }) => id === session.resultRepresentationId);
				const playback = asset?.representations.find(({ role }) => role === 'PLAYBACK');
				if (!asset || asset.kind !== 'VIDEO' || asset.status !== 'READY'
					|| asset.projectId !== session.projectId
					|| original?.role !== 'ORIGINAL' || original.state !== 'READY'
					|| original.bucket !== session.bucket || original.objectKey !== session.objectKey
					|| original.sourceIdentityAlgorithm !== input.sourceIdentityAlgorithm
					|| original.sourceIdentity !== input.sourceIdentity
					|| playback?.state !== 'FAILED'
					|| playback.bucket !== session.bucket
					|| playback.objectKey !== videoPlaybackObjectKey({
						id: session.id,
						projectId: session.projectId,
						generation: session.generation,
					})) return false;
				await tx.assetRepresentation.update({
					where: { id: playback.id },
					data: { state: 'VERIFYING', error: null },
				});
				await tx.assetUploadSession.update({
					where: { id: session.id },
					data: {
						state: 'VERIFYING',
						validationLeaseToken: null,
						validationLeaseUntil: null,
						validationError: null,
						completionResult: {
							status: 'VERIFYING',
							phase: 'PLAYBACK_REPAIR',
							generation: session.generation,
							sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
							sourceIdentity: session.sourceIdentity,
							assetId: asset.id,
							originalRepresentationId: original.id,
							playbackRepresentationId: playback.id,
						},
					},
				});
				return true;
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
						AND "result_asset_id" IS NULL
						AND "result_representation_id" IS NULL
						AND "validation_lease_token" = ${input.token}
						AND "validation_lease_until" > clock_timestamp()
					RETURNING "id"
				`);
				if (rejected.length !== 1) return false;
				const targets = input.reason.startsWith('OPERATOR_REQUIRED:') ? [] : [{
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
