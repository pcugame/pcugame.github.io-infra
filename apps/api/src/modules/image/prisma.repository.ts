import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { queueDurableDeletions } from '../orphan/outbox.js';
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

/** Worker-only Prisma adapter. It is deliberately not imported by Fastify. */
export function createPrismaImageWorkerRepository(client: PrismaClient, input: { publicBucket: string }): ImageWorkerRepository {
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

		async prepareOutputPlan({ session, outputs, notBefore }): Promise<PreparedImagePlan> {
			return client.$transaction(async (tx) => {
				const current = await tx.assetUploadSession.findUnique({ where: { id: session.id } });
				if (!current || current.state !== 'VERIFYING') throw new Error('Image session is no longer verifying');
				const owner = ownerData(session);
				let assetId = current.resultAssetId;
				if (!assetId) {
					const asset = await tx.asset.create({
						data: {
							...owner,
							kind: session.kind,
							status: 'PROCESSING',
							storageKey: null,
							playbackStorageKey: null,
							originalName: session.originalName,
							mimeType: '',
							sizeBytes: session.totalBytes,
							isPublic: true,
						},
						select: { id: true },
					});
					assetId = asset.id;
					await tx.assetUploadSession.update({ where: { id: session.id }, data: { resultAssetId: assetId } });
				}
				const planned = [] as PreparedImagePlan['outputs'];
				for (const output of outputs) {
					const objectKey = publicObjectKey(assetId, output.role, session.generation, output.extension);
					const intent = await tx.uploadIntent.upsert({
						where: { upload_intent_bucket_storage_key: { bucket: input.publicBucket, storageKey: objectKey } },
						create: {
							bucket: input.publicBucket, storageKey: objectKey, purpose: 'direct-image-representation',
							ownerOperationId: session.id, ownerActorId: Number(session.actorId),
							...(owner.projectId ? { ownerProjectId: owner.projectId } : { ownerExhibitionId: owner.exhibitionId! }),
							state: 'PREPARED', notBefore,
						},
						update: { notBefore },
						select: { id: true, state: true },
					});
					planned.push({
						role: output.role,
						bucket: input.publicBucket,
						objectKey,
						intentId: intent.id,
						intentState: intent.state === 'UPLOADED' ? 'UPLOADED' : 'PREPARED',
					});
				}
				return { assetId: String(assetId), outputs: planned };
			});
		},

		async markOutputUploaded(intentId) {
			await client.uploadIntent.updateMany({ where: { id: intentId, state: 'PREPARED' }, data: { state: 'UPLOADED' } });
		},

		async commitReady({ session, token, assetId: assetIdText, sourceCleanup, outputs }) {
			const assetId = Number(assetIdText);
			if (!Number.isSafeInteger(assetId) || assetId < 1) throw new Error('Image output asset id is invalid');
			await client.$transaction(async (tx) => {
				const owned = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
					SELECT "id" FROM "asset_upload_sessions"
					WHERE "id" = ${session.id} AND "state" = 'VERIFYING'::"AssetUploadSessionState"
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
							mimeType: output.mimeType, sizeBytes: BigInt(output.sizeBytes),
							checksumAlgorithm: 'SHA256', checksum: output.checksumSha256,
							state: 'READY', width: output.width, height: output.height,
						},
						update: {
							bucket: output.bucket, objectKey: output.objectKey, mimeType: output.mimeType,
							sizeBytes: BigInt(output.sizeBytes), checksumAlgorithm: 'SHA256', checksum: output.checksumSha256,
							state: 'READY', error: null, width: output.width, height: output.height,
						},
					});
				}
				await tx.asset.update({ where: { id: assetId }, data: {
					status: 'READY', originalName: session.originalName, mimeType: original.mimeType,
					sizeBytes: BigInt(original.sizeBytes), width: original.width, height: original.height,
					card480Height: outputs.find((output) => output.role === 'CARD_480')?.height ?? null,
					display960Height: outputs.find((output) => output.role === 'DISPLAY_960')?.height ?? null,
				} });
				if (session.kind === 'POSTER') {
					if (session.owner.type === 'PROJECT') {
						const previous = await tx.project.findUnique({ where: { id: Number(session.owner.id) }, select: { posterAssetId: true } });
						await tx.project.update({ where: { id: Number(session.owner.id) }, data: { posterAssetId: assetId } });
						if (previous?.posterAssetId && previous.posterAssetId !== assetId) {
							const old = await tx.asset.findUnique({ where: { id: previous.posterAssetId }, include: { representations: true } });
							if (old) {
								await tx.asset.update({ where: { id: old.id }, data: { status: 'DELETED' } });
								await queueDurableDeletions(tx, old.representations.map((representation) => ({ bucket: representation.bucket, storageKey: representation.objectKey, reason: 'direct-project-poster-replaced' })));
							}
						}
					} else {
						const previous = await tx.exhibition.findUnique({ where: { id: Number(session.owner.id) }, select: { posterAssetId: true } });
						await tx.exhibition.update({ where: { id: Number(session.owner.id) }, data: { posterAssetId: assetId } });
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
					await queueDurableDeletions(tx, [{ bucket: sourceCleanup.bucket, storageKey: sourceCleanup.objectKey, reason: 'direct-image-source-processed' }]);
			});
		},

		async reject({ session, token, reason }) {
			return client.$transaction(async (tx) => {
				const updated = await tx.assetUploadSession.updateMany({
					where: { id: session.id, state: 'VERIFYING', validationLeaseToken: token },
					data: { state: 'REJECTED', validationError: reason.slice(0, 500), validationLeaseToken: null, validationLeaseUntil: null },
				});
				if (!updated.count) return false;
				const intents = await tx.uploadIntent.findMany({ where: { ownerOperationId: session.id }, select: { bucket: true, storageKey: true } });
				await queueDurableDeletions(tx, [
					{ bucket: session.bucket, storageKey: session.objectKey, reason: 'direct-image-rejected' },
					...intents.map((intent) => ({ bucket: intent.bucket, storageKey: intent.storageKey, reason: 'direct-image-rejected-output' })),
				]);
				return true;
			});
		},
	};
}
