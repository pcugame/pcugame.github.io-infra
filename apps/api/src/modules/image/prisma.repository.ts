import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { queueDurableDeletions } from '../orphan/outbox.js';
import { WorkerGenerationFencedError } from '../upload-lifecycle/worker-errors.js';
import { commitUploadIntents } from '../upload-intent/repository.js';
import { assertProjectUploadWriteAccessInTransaction } from '../admin/project-access.service.js';
import type {
	ImageUploadKind,
	ImageWorkerRepository,
	PreparedImagePlan,
	VerifyingImageSession,
} from './ports.js';

function sessionRecord(value: {
	id: string;
	kind: string;
	state: string;
	projectId: number | null;
	exhibitionId: number | null;
	userId: number;
	originalName: string;
	declaredMimeType: string;
	totalBytes: bigint;
	bucket: string;
	objectKey: string;
	generation: number;
	sourceIdentityAlgorithm: string;
	sourceIdentity: string;
	sourceIdentityBlockSizeBytes: number;
	sourceIdentityBlockManifest: unknown;
	validationAttemptCount: number;
	expectedTargetAssetId: number | null;
	expectedTargetAssetUpdatedAt: Date | null;
}): VerifyingImageSession {
	if ((value.projectId === null) === (value.exhibitionId === null)) {
		throw new Error(`Image upload ${value.id} violates owner XOR`);
	}
	if (!['IMAGE', 'POSTER'].includes(value.kind) || value.state !== 'VERIFYING') {
		throw new Error(`Image upload ${value.id} is not verifying image work`);
	}
	return {
		id: value.id,
		kind: value.kind as ImageUploadKind,
		state: 'VERIFYING',
		owner: value.projectId === null
			? { type: 'EXHIBITION', id: String(value.exhibitionId) }
			: { type: 'PROJECT', id: String(value.projectId) },
		actorId: String(value.userId),
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
		validationAttemptCount: value.validationAttemptCount,
		expectedTargetAssetId: value.expectedTargetAssetId,
		expectedTargetAssetUpdatedAt: value.expectedTargetAssetUpdatedAt,
	};
}

function ownerData(session: VerifyingImageSession): { projectId?: number; exhibitionId?: number } {
	const id = Number(session.owner.id);
	if (!Number.isSafeInteger(id) || id < 1) throw new Error('Image upload owner id is invalid');
	return session.owner.type === 'PROJECT' ? { projectId: id } : { exhibitionId: id };
}

function publicObjectKey(assetId: number, role: string, generation: number, extension: string): string {
	if (!/^[a-z0-9]+$/i.test(extension)) throw new Error('Image output extension is invalid');
	return `public/images/${assetId}/${role.toLowerCase()}/${generation}.${extension}`;
}

function stagingObjectKey(projectId: number, submissionItemId: string, role: string, generation: number, extension: string): string {
	if (!/^[a-z0-9]+$/i.test(extension)) throw new Error('Image output extension is invalid');
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(submissionItemId)) {
		throw new Error('DRAFT image staging identity is not a UUID');
	}
	return `protected/publication-staging/projects/${projectId}/images/${submissionItemId}/${role.toLowerCase()}/${generation}.${extension}`;
}

/** Worker-only Prisma adapter. It is deliberately not imported by Fastify. */
export function createPrismaImageWorkerRepository(
	client: PrismaClient,
	input: { publicBucket: string; protectedBucket: string },
): ImageWorkerRepository {
	return {
		async claimVerifying(kinds, limit, token, leaseMs) {
			if (kinds.length === 0) return [];
			const claimed = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				WITH candidates AS (
					SELECT "id" FROM "asset_upload_sessions"
					WHERE "state" = 'VERIFYING'::"AssetUploadSessionState"
						AND "kind" IN (${Prisma.join(kinds.map((kind) => Prisma.sql`${kind}::"AssetUploadKind"`))})
						AND ("validation_lease_until" IS NULL OR "validation_lease_until" <= clock_timestamp())
					ORDER BY "completed_at", "created_at" LIMIT ${limit} FOR UPDATE SKIP LOCKED
				)
				UPDATE "asset_upload_sessions" AS session
				SET "validation_lease_token" = ${token},
					"validation_lease_until" = clock_timestamp() + (${leaseMs} * INTERVAL '1 millisecond'),
					"validation_attempt_count" = "validation_attempt_count" + 1,
					"updated_at" = clock_timestamp()
				FROM candidates WHERE session."id" = candidates."id" RETURNING session."id"
			`);
			if (claimed.length === 0) return [];
			const sessions = await client.assetUploadSession.findMany({
				where: { id: { in: claimed.map(({ id }) => id) }, validationLeaseToken: token },
			});
			return sessions.map(sessionRecord);
		},

		async renewLease(sessionId, token, leaseMs) {
			const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "asset_upload_sessions"
				SET "validation_lease_until" = clock_timestamp() + (${leaseMs} * INTERVAL '1 millisecond'), "updated_at" = clock_timestamp()
				WHERE "id" = ${sessionId} AND "state" = 'VERIFYING'::"AssetUploadSessionState"
					AND "validation_lease_token" = ${token} AND "validation_lease_until" > clock_timestamp()
				RETURNING "id"
			`);
			return rows.length === 1;
		},

		async prepareOutputPlan({ session, token, outputs, notBefore }): Promise<PreparedImagePlan> {
			return client.$transaction(async (tx) => {
				const owned = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
					SELECT "id" FROM "asset_upload_sessions"
					WHERE "id" = ${session.id} AND "generation" = ${session.generation}
						AND "state" = 'VERIFYING'::"AssetUploadSessionState"
						AND "validation_lease_token" = ${token}
						AND "validation_lease_until" > clock_timestamp()
				`);
				if (owned.length !== 1) throw new Error('Image processing lease lost');
				const current = await tx.assetUploadSession.findUnique({ where: { id: session.id } });
				if (!current || current.state !== 'VERIFYING') throw new Error('Image session is no longer verifying');
				const owner = ownerData(session);
				const project = current.projectId === null ? null : await tx.project.findUniqueOrThrow({
					where: { id: current.projectId }, select: { status: true },
				});
				const staged = project?.status === 'DRAFT';
				if (staged && !current.submissionItemId) throw new Error('DRAFT image upload lacks its submission item identity');
				let assetId = current.resultAssetId;
				if (!assetId) {
					const asset = await tx.asset.create({
						data: {
							...owner,
							kind: session.kind,
							status: 'PROCESSING',
							originalName: session.originalName,
						},
						select: { id: true },
					});
					assetId = asset.id;
					await tx.assetUploadSession.update({ where: { id: session.id }, data: { resultAssetId: assetId } });
				}
				const planned = [] as PreparedImagePlan['outputs'];
				for (const output of outputs) {
					const publicationObjectKey = publicObjectKey(assetId, output.role, session.generation, output.extension);
					const bucket = staged ? input.protectedBucket : input.publicBucket;
					const objectKey = staged
						? stagingObjectKey(current.projectId!, current.submissionItemId!, output.role, session.generation, output.extension)
						: publicationObjectKey;
					const intent = await tx.uploadIntent.upsert({
						where: { upload_intent_bucket_storage_key: { bucket, storageKey: objectKey } },
						create: {
							bucket, storageKey: objectKey, purpose: staged
								? 'project-publication-staged-image' : 'direct-image-representation',
							ownerOperationId: session.id, ownerActorId: Number(session.actorId),
							...(owner.projectId ? { ownerProjectId: owner.projectId } : { ownerExhibitionId: owner.exhibitionId! }),
							state: 'PREPARED', notBefore,
						},
						update: { notBefore },
						select: { id: true, state: true },
					});
					planned.push({
						role: output.role,
						bucket,
						objectKey,
						intentId: intent.id,
						intentState: intent.state === 'UPLOADED' ? 'UPLOADED' : 'PREPARED',
						...(staged ? { publicationBucket: input.publicBucket, publicationObjectKey } : {}),
					});
				}
				return { assetId: String(assetId), outputs: planned };
			});
		},

		async markOutputUploaded({ session, token, intentId }) {
			await client.$transaction(async (tx) => {
				const owned = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
					SELECT "id" FROM "asset_upload_sessions"
					WHERE "id" = ${session.id} AND "generation" = ${session.generation}
						AND "state" = 'VERIFYING'::"AssetUploadSessionState"
						AND "validation_lease_token" = ${token}
						AND "validation_lease_until" > clock_timestamp()
				`);
				if (owned.length !== 1) throw new Error('Image processing lease lost');
				const updated = await tx.uploadIntent.updateMany({
					where: { id: intentId, ownerOperationId: session.id, state: 'PREPARED' },
					data: { state: 'UPLOADED' },
				});
				if (updated.count === 0) {
					const current = await tx.uploadIntent.findUnique({ where: { id: intentId } });
					if (current?.state !== 'UPLOADED' || current.ownerOperationId !== session.id) {
						throw new Error('Image output intent ownership was lost');
					}
				}
			});
		},

		async commitReady({ session, token, assetId: assetIdText, sourceCleanup, outputs }) {
			const assetId = Number(assetIdText);
			if (!Number.isSafeInteger(assetId) || assetId < 1) throw new Error('Image output asset id is invalid');
			await client.$transaction(async (tx) => {
				if (session.owner.type === 'PROJECT') {
					const actor = await tx.user.findUniqueOrThrow({
						where: { id: Number(session.actorId) }, select: { id: true, role: true },
					});
					await assertProjectUploadWriteAccessInTransaction(tx, actor, Number(session.owner.id));
				}
				if (session.kind === 'POSTER' && session.expectedTargetAssetId == null
					&& session.expectedTargetAssetUpdatedAt != null) {
					throw new WorkerGenerationFencedError('POSTER');
				}
				const owned = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
					SELECT "id" FROM "asset_upload_sessions"
					WHERE "id" = ${session.id} AND "generation" = ${session.generation}
						AND "state" = 'VERIFYING'::"AssetUploadSessionState"
						AND "validation_lease_token" = ${token} AND "validation_lease_until" > clock_timestamp()
				`);
				if (owned.length !== 1) throw new Error('Image processing lease lost');
				const original = outputs.find((output) => output.role === 'ORIGINAL');
				if (!original) throw new Error('Image output plan has no ORIGINAL representation');
				for (const output of outputs) {
					await tx.assetRepresentation.upsert({
						where: { asset_representation_asset_role: { assetId, role: output.role } },
						create: {
							assetId, role: output.role, bucket: output.bucket, objectKey: output.objectKey,
							publicationBucket: output.publicationBucket ?? null,
							publicationObjectKey: output.publicationObjectKey ?? null,
							mimeType: output.mimeType, sizeBytes: BigInt(output.sizeBytes),
							checksumAlgorithm: 'SHA256', checksum: output.checksumSha256,
							sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
							sourceIdentity: session.sourceIdentity,
							state: 'READY', width: output.width, height: output.height,
						},
						update: {
							bucket: output.bucket, objectKey: output.objectKey, mimeType: output.mimeType,
							publicationBucket: output.publicationBucket ?? null,
							publicationObjectKey: output.publicationObjectKey ?? null,
							sizeBytes: BigInt(output.sizeBytes), checksumAlgorithm: 'SHA256', checksum: output.checksumSha256,
							sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
							sourceIdentity: session.sourceIdentity,
							state: 'READY', error: null, width: output.width, height: output.height,
						},
					});
				}
				await tx.asset.update({ where: { id: assetId }, data: {
					status: 'READY', originalName: session.originalName,
				} });
				await commitUploadIntents(tx, outputs.map((output) => output.intentId));
				if (session.kind === 'POSTER') {
					if (session.owner.type === 'PROJECT') {
						const ownerId = Number(session.owner.id);
						await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "projects" WHERE "id" = ${ownerId} FOR UPDATE`);
						const previous = await tx.project.findUnique({ where: { id: ownerId }, select: { posterAssetId: true } });
						if (previous?.posterAssetId !== session.expectedTargetAssetId) throw new WorkerGenerationFencedError('POSTER');
						const pointer = await tx.project.updateMany({ where: { id: ownerId, posterAssetId: session.expectedTargetAssetId }, data: { posterAssetId: assetId } });
						if (pointer.count !== 1) throw new WorkerGenerationFencedError('POSTER');
						if (previous?.posterAssetId && previous.posterAssetId !== assetId) {
							const old = await tx.asset.findUnique({ where: { id: previous.posterAssetId }, include: { representations: true } });
							if (old) {
								await tx.asset.update({ where: { id: old.id }, data: { status: 'DELETED' } });
								await queueDurableDeletions(tx, old.representations.map((representation) => ({ bucket: representation.bucket, storageKey: representation.objectKey, reason: 'direct-project-poster-replaced' })));
							}
						}
					} else {
						const ownerId = Number(session.owner.id);
						await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "exhibitions" WHERE "id" = ${ownerId} FOR UPDATE`);
						const previous = await tx.exhibition.findUnique({ where: { id: ownerId }, select: { posterAssetId: true } });
						if (previous?.posterAssetId !== session.expectedTargetAssetId) throw new WorkerGenerationFencedError('POSTER');
						const pointer = await tx.exhibition.updateMany({ where: { id: ownerId, posterAssetId: session.expectedTargetAssetId }, data: { posterAssetId: assetId } });
						if (pointer.count !== 1) throw new WorkerGenerationFencedError('POSTER');
						if (previous?.posterAssetId && previous.posterAssetId !== assetId) {
							const old = await tx.asset.findUnique({ where: { id: previous.posterAssetId }, include: { representations: true } });
							if (old) {
								await tx.asset.update({ where: { id: old.id }, data: { status: 'DELETED' } });
								await queueDurableDeletions(tx, old.representations.map((representation) => ({ bucket: representation.bucket, storageKey: representation.objectKey, reason: 'direct-exhibition-poster-replaced' })));
							}
						}
					}
				}
				await tx.assetUploadSession.update({ where: { id: session.id }, data: {
					state: 'READY', resultAssetId: assetId,
					resultRepresentationId: (await tx.assetRepresentation.findUniqueOrThrow({ where: { asset_representation_asset_role: { assetId, role: 'ORIGINAL' } }, select: { id: true } })).id,
					validationLeaseToken: null, validationLeaseUntil: null,
					completionResult: { status: 'READY', assetId, representation: 'ORIGINAL' },
				} });
				if (session.owner.type === 'PROJECT') {
					await tx.project.update({ where: { id: Number(session.owner.id) }, data: { version: { increment: 1 } } });
				}
					await queueDurableDeletions(tx, [{ bucket: sourceCleanup.bucket, storageKey: sourceCleanup.objectKey, reason: 'direct-image-source-processed' }]);
			});
		},

		async reject({ session, token, reason }) {
			return client.$transaction(async (tx) => {
				const updated = await tx.$queryRaw<Array<{ assetId: number | null }>>(Prisma.sql`
					UPDATE "asset_upload_sessions"
					SET "state" = 'REJECTED'::"AssetUploadSessionState",
						"validation_error" = ${reason.slice(0, 500)},
						"validation_lease_token" = NULL, "validation_lease_until" = NULL,
						"updated_at" = clock_timestamp()
					WHERE "id" = ${session.id} AND "generation" = ${session.generation}
						AND "state" = 'VERIFYING'::"AssetUploadSessionState"
						AND "validation_lease_token" = ${token}
						AND "validation_lease_until" > clock_timestamp()
					RETURNING "result_asset_id" AS "assetId"
				`);
				if (updated.length !== 1) return false;
				if (updated[0]!.assetId !== null) await tx.asset.updateMany({
					where: { id: updated[0]!.assetId, status: 'PROCESSING' }, data: { status: 'FAILED' },
				});
				const intents = await tx.uploadIntent.findMany({ where: { ownerOperationId: session.id }, select: { bucket: true, storageKey: true } });
				await queueDurableDeletions(tx, [
					...(!reason.startsWith('OPERATOR_REQUIRED:')
						? [{ bucket: session.bucket, storageKey: session.objectKey, reason: 'direct-image-rejected' }]
						: []),
					...intents.map((intent) => ({ bucket: intent.bucket, storageKey: intent.storageKey, reason: 'direct-image-rejected-output' })),
				]);
				await tx.uploadIntent.updateMany({
					where: { ownerOperationId: session.id, state: { in: ['PREPARED', 'UPLOADED'] } },
					data: { state: 'CLEANUP_QUEUED', claimToken: null, claimUntil: null },
				});
				return true;
			});
		},
	};
}
