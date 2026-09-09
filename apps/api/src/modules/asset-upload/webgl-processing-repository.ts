import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { withAssetMutationTransaction } from '../assets/mutation-transaction.js';
import { queueDurableDeletions } from '../orphan/outbox.js';
import type {
	CanonicalWebglUploadSession,
	ReservedWebglDeployment,
	WebglProcessingRepository,
} from '../webgl/processing.js';
import { assertWebglPublishedObjectManifest } from '../webgl/processing.js';
import type { WebglProcessingWorkerRepository } from '../webgl/processing-worker.js';

type WebglProcessingPersistence = WebglProcessingRepository & WebglProcessingWorkerRepository;

class WebglPointerFenceError extends Error {}

function completionResultWithReservation(
	current: unknown,
	expectedCurrentDeploymentId: string | null,
): Prisma.InputJsonValue {
	const base = current && typeof current === 'object' && !Array.isArray(current)
		? current as Record<string, unknown>
		: {};
	return {
		...base,
		webglReservation: { expectedCurrentDeploymentId },
	};
}

function expectedPointerFromCompletionResult(value: unknown): string | null | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const reservation = (value as { webglReservation?: unknown }).webglReservation;
	if (!reservation || typeof reservation !== 'object' || Array.isArray(reservation)) return undefined;
	const expected = (reservation as { expectedCurrentDeploymentId?: unknown }).expectedCurrentDeploymentId;
	return expected === null || typeof expected === 'string' ? expected : undefined;
}

function reservationState(value: string): ReservedWebglDeployment['state'] {
	if (value === 'PENDING' || value === 'PROCESSING' || value === 'READY') return value;
	throw new Error(`Reserved WebGL deployment is not processable (${value})`);
}

function canonicalSession(session: {
	id: string;
	projectId: number;
	kind: 'WEBGL';
	state: 'VERIFYING';
	generation: number;
	totalBytes: bigint;
	bucket: string;
	objectKey: string;
	sourceIdentityAlgorithm: string;
	sourceIdentity: string;
	sourceIdentityBlockSizeBytes: number;
	sourceIdentityBlockManifest: unknown;
	resultAssetId: number | null;
	resultRepresentationId: string | null;
	reservedWebglDeploymentId: string | null;
	resultRepresentation: {
		id: string;
		assetId: number;
		role: 'WEBGL_SOURCE';
		state: 'VERIFYING';
		bucket: string;
		objectKey: string;
		sizeBytes: bigint;
		updatedAt: Date;
		sourceIdentityAlgorithm: string | null;
		sourceIdentity: string | null;
	} | null;
}): CanonicalWebglUploadSession | null {
	const source = session.resultRepresentation;
	if (!source || session.resultAssetId === null || session.resultRepresentationId === null
		|| source.sourceIdentityAlgorithm === null || source.sourceIdentity === null) return null;
	return {
		id: session.id,
		projectId: session.projectId,
		kind: session.kind,
		state: session.state,
		generation: session.generation,
		totalBytes: session.totalBytes,
		bucket: session.bucket,
		objectKey: session.objectKey,
		sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
		sourceIdentity: session.sourceIdentity,
		sourceIdentityBlockSizeBytes: session.sourceIdentityBlockSizeBytes,
		sourceIdentityBlockManifest: session.sourceIdentityBlockManifest,
		resultAssetId: session.resultAssetId,
		resultRepresentationId: session.resultRepresentationId,
		reservedWebglDeploymentId: session.reservedWebglDeploymentId,
		sourceRepresentation: {
			id: source.id,
			assetId: source.assetId,
			role: source.role,
			state: source.state,
			bucket: source.bucket,
			objectKey: source.objectKey,
			sizeBytes: source.sizeBytes,
			updatedAt: source.updatedAt,
			sourceIdentityAlgorithm: source.sourceIdentityAlgorithm,
			sourceIdentity: source.sourceIdentity,
		},
	};
}

/**
 * A malformed legacy/partially-written VERIFYING row still needs a terminal
 * worker outcome.  This deliberate impossible source never reaches Garage:
 * `assertCanonicalSource` rejects it before an object-body read.
 */
function invalidCanonicalSession(session: {
	id: string;
	projectId: number | null;
	generation: number;
	totalBytes: bigint;
	bucket: string;
	objectKey: string;
	sourceIdentityAlgorithm: string;
	sourceIdentity: string;
	sourceIdentityBlockSizeBytes: number;
	sourceIdentityBlockManifest: unknown;
	resultAssetId: number | null;
	resultRepresentationId: string | null;
	reservedWebglDeploymentId: string | null;
}): CanonicalWebglUploadSession {
	const assetId = session.resultAssetId ?? -1;
	const representationId = session.resultRepresentationId ?? `invalid-${session.id}`;
	return {
		id: session.id,
		projectId: session.projectId ?? -1,
		kind: 'WEBGL', state: 'VERIFYING', generation: session.generation,
		totalBytes: session.totalBytes, bucket: session.bucket, objectKey: session.objectKey,
		sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
		sourceIdentity: session.sourceIdentity,
		sourceIdentityBlockSizeBytes: session.sourceIdentityBlockSizeBytes,
		sourceIdentityBlockManifest: session.sourceIdentityBlockManifest,
		resultAssetId: assetId,
		resultRepresentationId: representationId,
		reservedWebglDeploymentId: session.reservedWebglDeploymentId,
		sourceRepresentation: {
			id: representationId, assetId, role: 'WEBGL_SOURCE', state: 'VERIFYING',
			bucket: '', objectKey: '', sizeBytes: 0n, updatedAt: new Date(0),
			sourceIdentityAlgorithm: '', sourceIdentity: '',
		},
	};
}

/**
 * Processing-only persistence adapter.  The Fastify graph imports neither this
 * adapter nor WebGL processing; the standalone worker owns both capabilities.
 */
export function createWebglProcessingRepository(client: PrismaClient): WebglProcessingPersistence {
	return {
		async claimVerifyingWebglSessions(input) {
			const leaseMs = Math.max(30_000, input.leaseUntil.getTime() - Date.now());
			const claimed = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				WITH candidates AS (
					SELECT session."id"
					FROM "asset_upload_sessions" AS session
					WHERE session."kind" = 'WEBGL'::"AssetUploadKind"
						AND session."state" = 'VERIFYING'::"AssetUploadSessionState"
						AND session."project_id" IS NOT NULL
						AND session."exhibition_id" IS NULL
						AND (session."validation_lease_until" IS NULL OR session."validation_lease_until" <= clock_timestamp())
					ORDER BY session."completed_at", session."created_at"
					LIMIT ${input.limit}
					FOR UPDATE SKIP LOCKED
				)
				UPDATE "asset_upload_sessions" AS session
				SET "validation_lease_token" = ${input.claimToken},
					"validation_lease_until" = clock_timestamp() + (${leaseMs} * INTERVAL '1 millisecond'),
					"validation_attempt_count" = session."validation_attempt_count" + 1,
					"updated_at" = clock_timestamp()
				FROM candidates
				WHERE session."id" = candidates."id"
				RETURNING session."id"
			`);
			if (!claimed.length) return [];
			const sessions = await client.assetUploadSession.findMany({
				where: { id: { in: claimed.map((row) => row.id) }, validationLeaseToken: input.claimToken },
				include: { resultRepresentation: true },
			});
			return sessions.map((session) => {
				if (session.kind !== 'WEBGL' || session.state !== 'VERIFYING') return [];
				if (session.projectId === null || session.exhibitionId !== null) {
					return invalidCanonicalSession(session);
				}
				const source = session.resultRepresentation;
				if (!source || source.role !== 'WEBGL_SOURCE' || source.state !== 'VERIFYING') {
					return invalidCanonicalSession(session);
				}
				const canonical = canonicalSession({
					...session,
					projectId: session.projectId,
					kind: 'WEBGL', state: 'VERIFYING',
					resultRepresentation: {
						...source,
						role: 'WEBGL_SOURCE', state: 'VERIFYING',
					},
				});
				return canonical ?? invalidCanonicalSession(session);
			}).flat();
		},

		async assertValidationLease(input) {
			const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				SELECT "id" FROM "asset_upload_sessions"
				WHERE "id" = ${input.sessionId} AND "generation" = ${input.generation}
					AND "kind" = 'WEBGL'::"AssetUploadKind"
					AND "state" = 'VERIFYING'::"AssetUploadSessionState"
					AND "validation_lease_token" = ${input.claimToken}
					AND "validation_lease_until" > clock_timestamp()
			`);
			if (rows.length !== 1) throw new Error('WebGL validation lease was lost');
		},

		async renewValidationLease(input) {
			const leaseMs = Math.max(30_000, input.leaseUntil.getTime() - Date.now());
			const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "asset_upload_sessions"
				SET "validation_lease_until" = clock_timestamp() + (${leaseMs} * INTERVAL '1 millisecond'), "updated_at" = clock_timestamp()
				WHERE "id" = ${input.sessionId} AND "generation" = ${input.generation}
					AND "kind" = 'WEBGL'::"AssetUploadKind"
					AND "state" = 'VERIFYING'::"AssetUploadSessionState"
					AND "validation_lease_token" = ${input.claimToken}
					AND "validation_lease_until" > clock_timestamp()
				RETURNING "id"
			`);
			return rows.length === 1;
		},

		async releaseValidationLease(input) {
			await client.$queryRaw(Prisma.sql`
				UPDATE "asset_upload_sessions"
				SET "validation_lease_token" = NULL, "validation_lease_until" = NULL,
					"validation_error" = ${input.error.slice(0, 2_000)}, "updated_at" = clock_timestamp()
				WHERE "id" = ${input.sessionId} AND "generation" = ${input.generation}
					AND "kind" = 'WEBGL'::"AssetUploadKind"
					AND "state" = 'VERIFYING'::"AssetUploadSessionState"
					AND "validation_lease_token" = ${input.claimToken}
			`);
		},

		async reserveDeployment(input): Promise<ReservedWebglDeployment> {
			return withAssetMutationTransaction(client, async (tx) => {
				const owned = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
					SELECT "id" FROM "asset_upload_sessions"
					WHERE "id" = ${input.sessionId} AND "generation" = ${input.generation}
						AND "kind" = 'WEBGL'::"AssetUploadKind"
						AND "state" = 'VERIFYING'::"AssetUploadSessionState"
						AND "validation_lease_token" = ${input.claimToken}
						AND "validation_lease_until" > clock_timestamp()
				`);
				if (owned.length !== 1) throw new Error('WebGL validation lease was lost');
				const session = await tx.assetUploadSession.findUniqueOrThrow({
					where: { id: input.sessionId },
					include: { reservedWebglDeployment: true },
				});
				if (session.projectId === null || session.exhibitionId !== null) {
					throw new Error('WebGL upload session must have exactly one project owner');
				}
				if (session.resultRepresentationId !== input.sourceRepresentationId) {
					throw new Error('WebGL source representation reservation mismatch');
				}
				await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "projects" WHERE "id" = ${session.projectId} FOR UPDATE`);
				if (session.reservedWebglDeployment) {
					const expected = expectedPointerFromCompletionResult(session.completionResult);
					if (expected === undefined) throw new Error('Reserved WebGL deployment has no durable pointer snapshot');
					return {
						id: session.reservedWebglDeployment.id,
						projectId: session.reservedWebglDeployment.projectId,
						publicBucket: session.reservedWebglDeployment.publicBucket,
						publicPrefix: session.reservedWebglDeployment.publicPrefix,
						entryObjectKey: session.reservedWebglDeployment.entryObjectKey,
						state: reservationState(session.reservedWebglDeployment.state),
						expectedCurrentDeploymentId: expected,
					} satisfies ReservedWebglDeployment;
				}
				const project = await tx.project.findUniqueOrThrow({
					where: { id: session.projectId }, select: { currentWebglDeploymentId: true },
				});
				const deployment = await tx.webglDeployment.create({
					data: {
						id: input.candidateDeploymentId,
						projectId: session.projectId,
						sourceRepresentationId: input.sourceRepresentationId,
						publicBucket: input.publicBucket,
						publicPrefix: input.publicPrefix,
						entryObjectKey: input.entryObjectKey,
						state: 'PROCESSING',
					},
				});
				await tx.assetUploadSession.update({
					where: { id: session.id },
					data: {
						reservedWebglDeploymentId: deployment.id,
						completionResult: completionResultWithReservation(
							session.completionResult,
							project.currentWebglDeploymentId,
						),
					},
				});
				return {
					id: deployment.id,
					projectId: deployment.projectId,
					publicBucket: deployment.publicBucket,
					publicPrefix: deployment.publicPrefix,
					entryObjectKey: deployment.entryObjectKey,
					state: reservationState(deployment.state),
					expectedCurrentDeploymentId: project.currentWebglDeploymentId,
				} satisfies ReservedWebglDeployment;
			});
		},

		async commitReady(input) {
			try {
				return await withAssetMutationTransaction(client, async (tx) => {
					const owned = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
						SELECT "id" FROM "asset_upload_sessions"
						WHERE "id" = ${input.sessionId} AND "generation" = ${input.generation}
							AND "kind" = 'WEBGL'::"AssetUploadKind"
							AND "state" = 'VERIFYING'::"AssetUploadSessionState"
							AND "validation_lease_token" = ${input.claimToken}
							AND "validation_lease_until" > clock_timestamp()
					`);
					if (owned.length !== 1) throw new Error('WebGL validation lease was lost');
					const session = await tx.assetUploadSession.findUniqueOrThrow({
						where: { id: input.sessionId }, include: { reservedWebglDeployment: true },
					});
					if (session.projectId === null || session.exhibitionId !== null) {
						throw new Error('WebGL upload session must have exactly one project owner');
					}
					const deployment = session.reservedWebglDeployment;
					if (!deployment || deployment.id !== input.deploymentId || session.resultAssetId !== input.assetId
						|| session.resultRepresentationId !== input.representationId) {
						throw new Error('WebGL READY commit identity mismatch');
					}
					if (deployment.state === 'READY' && session.state === 'READY') return 'ALREADY_READY' as const;
					assertWebglPublishedObjectManifest(
						input.objectManifest,
						deployment.publicPrefix,
						deployment.entryObjectKey,
					);
					const expected = expectedPointerFromCompletionResult(session.completionResult);
					if (expected === undefined || expected !== input.expectedCurrentDeploymentId) {
						throw new Error('WebGL pointer snapshot is malformed');
					}
					const pointer = await tx.project.updateMany({
						where: { id: session.projectId, currentWebglDeploymentId: expected },
						data: { currentWebglDeploymentId: deployment.id },
					});
					if (pointer.count !== 1) throw new WebglPointerFenceError();
					const representation = await tx.assetRepresentation.updateMany({
						where: {
							id: input.representationId,
							assetId: input.assetId,
							role: 'WEBGL_SOURCE', state: 'VERIFYING',
							updatedAt: input.representationUpdatedAt,
						},
						data: { state: 'READY' },
					});
					if (representation.count !== 1) throw new Error('WebGL source representation was superseded');
					await tx.asset.update({ where: { id: input.assetId }, data: { status: 'READY' } });
					await tx.webglDeployment.update({
						where: { id: deployment.id },
						data: {
							state: 'READY', error: null,
							objectManifest: input.objectManifest as unknown as Prisma.InputJsonValue,
						},
					});
					await tx.assetUploadSession.update({
						where: { id: session.id },
						data: {
							state: 'READY', validationLeaseToken: null, validationLeaseUntil: null,
							completionResult: {
								...((session.completionResult && typeof session.completionResult === 'object' && !Array.isArray(session.completionResult)) ? session.completionResult as Record<string, unknown> : {}),
								status: 'READY', deploymentId: deployment.id, assetId: input.assetId, representationId: input.representationId,
								},
						},
					});
					if (expected && expected !== deployment.id) {
						const old = await tx.webglDeployment.findUnique({ where: { id: expected } });
						if (old) await queueDurableDeletions(tx, [{
							bucket: old.publicBucket, storageKey: old.publicPrefix,
							targetKind: 'PREFIX', reason: 'webgl-public-generation-superseded',
						}]);
					}
					return 'COMMITTED' as const;
				});
			} catch (error) {
				if (error instanceof WebglPointerFenceError) return 'FENCED' as const;
				throw error;
			}
		},

		async rejectFencedAndQueueCleanup(input) {
			await client.$transaction(async (tx) => {
				const session = await tx.assetUploadSession.findUnique({
					where: { id: input.sessionId }, include: { reservedWebglDeployment: true },
				});
				if (!session || session.generation !== input.generation || session.kind !== 'WEBGL'
					|| session.state !== 'VERIFYING' || session.validationLeaseToken !== input.claimToken) return;
				const owned = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
					SELECT "id" FROM "asset_upload_sessions" WHERE "id" = ${input.sessionId}
						AND "validation_lease_until" > clock_timestamp()
				`);
				if (owned.length !== 1) return;
				await tx.assetUploadSession.update({ where: { id: session.id }, data: {
					state: 'REJECTED', validationError: input.reason.slice(0, 2_000),
					validationLeaseToken: null, validationLeaseUntil: null,
				} });
				if (session.resultRepresentationId) await tx.assetRepresentation.update({
					where: { id: session.resultRepresentationId }, data: { state: 'FAILED', error: input.reason.slice(0, 2_000) },
				});
				if (session.resultAssetId) await tx.asset.update({ where: { id: session.resultAssetId }, data: { status: 'FAILED' } });
				if (session.reservedWebglDeployment) await tx.webglDeployment.update({
					where: { id: session.reservedWebglDeployment.id }, data: { state: 'FAILED', error: input.reason.slice(0, 2_000) },
				});
				await queueDurableDeletions(tx, [
					{ bucket: input.publicBucket, storageKey: input.publicPrefix, targetKind: 'PREFIX', reason: input.reason },
					{ bucket: session.bucket, storageKey: session.objectKey, reason: input.reason },
				]);
			});
		},

		async rejectInvalidSource(input) {
			await client.$transaction(async (tx) => {
				const session = await tx.assetUploadSession.findUnique({ where: { id: input.sessionId } });
				if (!session || session.kind !== 'WEBGL' || session.generation !== input.generation
					|| session.state !== 'VERIFYING' || session.validationLeaseToken !== input.claimToken) return;
				const owned = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
					SELECT "id" FROM "asset_upload_sessions" WHERE "id" = ${session.id}
						AND "validation_lease_until" > clock_timestamp()
				`);
				if (owned.length !== 1) return;
				await tx.assetUploadSession.update({ where: { id: session.id }, data: {
					state: 'REJECTED', validationError: input.error.slice(0, 2_000),
					validationLeaseToken: null, validationLeaseUntil: null,
				} });
				if (session.resultRepresentationId) await tx.assetRepresentation.update({
					where: { id: session.resultRepresentationId }, data: { state: 'FAILED', error: input.error.slice(0, 2_000) },
				});
				if (session.resultAssetId) await tx.asset.update({ where: { id: session.resultAssetId }, data: { status: 'FAILED' } });
				if (session.reservedWebglDeploymentId) await tx.webglDeployment.update({
					where: { id: session.reservedWebglDeploymentId }, data: { state: 'FAILED', error: input.error.slice(0, 2_000) },
				});
				await queueDurableDeletions(tx, [{
					bucket: session.bucket, storageKey: session.objectKey, reason: 'webgl-source-validation-rejected',
				}]);
			});
		},
	};
}
