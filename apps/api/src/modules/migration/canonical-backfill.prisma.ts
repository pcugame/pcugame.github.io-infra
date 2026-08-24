import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { parseWebglEntryKey, parseWebglSourceKey } from '../webgl/paths.js';
import type {
	CanonicalApplyOutcome,
	CanonicalAssetPlan,
	CanonicalBackfillRepository,
	CanonicalExhibitionPlan,
	CanonicalMaterializationTarget,
	CanonicalObjectRelocation,
	CanonicalRepresentationPlan,
	CanonicalWebglPlan,
	LegacyAssetRow,
	LegacyExhibitionRow,
	LegacyWebglRow,
	LegacyWebglSourceProof,
} from './canonical-backfill.types.js';

/**
 * Phase-1 reader compiled against the final Phase-2 Prisma client. Legacy
 * tables/columns intentionally occur only in SQL, never generated model types.
 */
type SqlClient = PrismaClient | Prisma.TransactionClient;

const assetColumns = Prisma.sql`
	"id", "project_id" AS "projectId", "exhibition_id" AS "exhibitionId",
	"kind"::text AS "kind", "status"::text AS "status", "storage_key" AS "storageKey",
	"playback_storage_key" AS "playbackStorageKey", "original_name" AS "originalName",
	"mime_type" AS "mimeType", "playback_mime_type" AS "playbackMimeType",
	"size_bytes" AS "sizeBytes", "playback_size_bytes" AS "playbackSizeBytes",
	"playback_status"::text AS "playbackStatus", "is_public" AS "isPublic",
	"width", "height", "card_480_height" AS "card480Height",
	"display_960_height" AS "display960Height", "updated_at" AS "updatedAt",
	CASE
		WHEN "status"::text <> 'READY' THEN false
		WHEN "kind"::text IN ('IMAGE', 'POSTER', 'THUMBNAIL') THEN
			(SELECT count(DISTINCT r."role"::text) = 3
			 FROM "asset_representations" r
			 WHERE r."asset_id" = "assets"."id" AND r."state"::text = 'READY'
			   AND r."role"::text IN ('ORIGINAL', 'CARD_480', 'DISPLAY_960')
			   AND r."object_key" LIKE 'public/images/' || "assets"."id"::text || '/%')
		ELSE
			EXISTS (SELECT 1 FROM "asset_representations" r
			 WHERE r."asset_id" = "assets"."id" AND r."state"::text = 'READY'
			   AND r."role"::text = CASE WHEN "assets"."kind"::text = 'WEBGL' THEN 'WEBGL_SOURCE' ELSE 'ORIGINAL' END
			   AND r."object_key" LIKE 'protected/assets/' || "assets"."id"::text || '/%')
			AND ("kind"::text <> 'VIDEO' OR "playback_status"::text <> 'READY'
			  OR EXISTS (SELECT 1 FROM "asset_representations" r
				 WHERE r."asset_id" = "assets"."id" AND r."state"::text = 'READY'
				   AND r."role"::text = 'PLAYBACK'
				   AND r."object_key" LIKE 'protected/assets/' || "assets"."id"::text || '/%'))
	END AS "canonicalBackfillComplete"
`;

const exhibitionColumns = Prisma.sql`
	"id", "poster_asset_id" AS "posterAssetId", "poster_storage_key" AS "posterStorageKey",
	"poster_original_name" AS "posterOriginalName", "poster_mime_type" AS "posterMimeType",
	"poster_size_bytes" AS "posterSizeBytes", "poster_width" AS "posterWidth",
	"poster_height" AS "posterHeight", "poster_card_480_height" AS "posterCard480Height",
	"poster_display_960_height" AS "posterDisplay960Height", "updated_at" AS "updatedAt"
`;

function completedResultProvesSource(result: unknown, storageKey: string, totalBytes: bigint): boolean {
	if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
	const record = result as Record<string, unknown>;
	return record['status'] === 'COMPLETED' && record['storageKey'] === storageKey
		&& typeof record['sizeBytes'] === 'number' && Number.isSafeInteger(record['sizeBytes'])
		&& BigInt(record['sizeBytes']) === totalBytes;
}

async function sourceProofForProject(client: SqlClient, projectId: number, entryKey: string): Promise<LegacyWebglSourceProof | null> {
	const entryGeneration = parseWebglEntryKey(projectId, entryKey);
	if (!entryGeneration) return null;
	const candidates = await client.$queryRaw<Array<{
		id: string; storageKey: string; s3Key: string | null; originalName: string;
		totalBytes: bigint; completionResult: unknown; updatedAt: Date;
	}>>(Prisma.sql`
		SELECT "id", "storage_key" AS "storageKey", "s3_key" AS "s3Key",
			"original_name" AS "originalName", "total_bytes" AS "totalBytes",
			"completion_result" AS "completionResult", "updated_at" AS "updatedAt"
		FROM "game_upload_sessions"
		WHERE "project_id" = ${projectId} AND "upload_kind"::text = 'WEBGL'
			AND "status" = 'COMPLETED' AND "storage_key" IS NOT NULL
	`);
	const proven = candidates.filter((candidate) => candidate.s3Key === candidate.storageKey
		&& completedResultProvesSource(candidate.completionResult, candidate.storageKey, candidate.totalBytes)
		&& parseWebglSourceKey(projectId, candidate.storageKey)?.deploymentId === entryGeneration.deploymentId);
	if (proven.length !== 1) return null;
	const candidate = proven[0]!;
	return {
		sessionId: candidate.id, deploymentId: entryGeneration.deploymentId,
		storageKey: candidate.storageKey, originalName: candidate.originalName,
		totalBytes: candidate.totalBytes, updatedAt: candidate.updatedAt,
	};
}

async function toWebglRow(client: SqlClient, project: {
	id: number; webglEntryKey: string; currentWebglDeploymentId: string | null; updatedAt: Date;
}): Promise<LegacyWebglRow> {
	const sourceProof = project.currentWebglDeploymentId ? null : await sourceProofForProject(client, project.id, project.webglEntryKey);
	const candidates = sourceProof ? await client.$queryRaw<Array<{
		id: number; projectId: number | null; status: string; kind: string;
	}>>(Prisma.sql`
		SELECT "id", "project_id" AS "projectId", "status"::text AS "status", "kind"::text AS "kind"
		FROM "assets" WHERE "storage_key" = ${sourceProof.storageKey}
	`) : [];
	const sourceAsset = candidates.length === 1 ? candidates[0]! : null;
	const sourceKind = sourceAsset?.projectId === project.id && sourceAsset.status === 'READY'
		&& (sourceAsset.kind === 'GAME' || sourceAsset.kind === 'WEBGL')
		? sourceAsset.kind : null;
	return {
		...project, sourceProof,
		sourceLegacyAssetId: sourceKind ? sourceAsset?.id ?? null : null,
		sourceLegacyAssetKind: sourceKind,
		sourceOwnershipConflict: candidates.length > 1 || (candidates.length === 1 && sourceKind === null),
	};
}

function sameDate(left: Date, right: Date): boolean { return left.getTime() === right.getTime(); }

const MATERIALIZATION_CLEANUP_GRACE_HOURS = 24;

function relocationId(relocation: Omit<CanonicalObjectRelocation, 'verified'>): string {
	return createHash('sha256').update([
		relocation.copy.sourceBucket,
		relocation.copy.sourceKey,
		relocation.copy.destinationBucket,
		relocation.copy.destinationKey,
	].join('\0')).digest('hex');
}

async function commitRelocations(
	tx: Prisma.TransactionClient,
	relocations: readonly CanonicalObjectRelocation[],
): Promise<void> {
	for (const relocation of relocations) {
		const checksum = relocation.verified.checksumSha256?.toLowerCase();
		if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) {
			throw new Error(`relocation destination lacks verified SHA-256: ${relocation.copy.destinationBucket}/${relocation.copy.destinationKey}`);
		}
		const committed = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
			UPDATE "canonical_object_relocations"
			SET "state" = 'COMMITTED', "committed_at" = COALESCE("committed_at", CURRENT_TIMESTAMP),
				"updated_at" = CURRENT_TIMESTAMP
			WHERE "id" = ${relocationId(relocation)}
				AND "work_kind" = ${relocation.workKind} AND "work_ref" = ${relocation.workRef}
				AND "role" = ${relocation.role}
				AND "source_bucket" = ${relocation.copy.sourceBucket}
				AND "source_object_key" = ${relocation.copy.sourceKey}
				AND "destination_bucket" = ${relocation.copy.destinationBucket}
				AND "destination_object_key" = ${relocation.copy.destinationKey}
				AND "size_bytes" = ${relocation.verified.size}
				AND lower("mime_type") = lower(${relocation.verified.mimeType})
				AND "checksum_sha256" = ${checksum}
				AND "state" IN ('MATERIALIZED', 'COMMITTED')
			RETURNING "id"
		`);
		if (committed.length !== 1) {
			throw new Error(`relocation is not materialized: ${relocation.copy.destinationBucket}/${relocation.copy.destinationKey}`);
		}
	}
}

async function cancelMaterializationCleanup(
	tx: Prisma.TransactionClient,
	plan: CanonicalRepresentationPlan,
): Promise<void> {
	const activeClaims = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
		SELECT "id" FROM "orphan_objects"
		WHERE "bucket" = ${plan.bucket} AND "storage_key" = ${plan.objectKey}
			AND "state" = 'DELETE_CLAIMED'::"OrphanState"
			AND "claim_until" > clock_timestamp()
		FOR UPDATE
	`);
	if (activeClaims.length > 0) {
		throw new Error(`canonical object cleanup is actively claimed: ${plan.bucket}/${plan.objectKey}`);
	}
	await tx.$executeRaw(Prisma.sql`
		UPDATE "orphan_objects"
		SET "state" = 'CANCELLED'::"OrphanState",
			"claim_token" = NULL,
			"claim_until" = NULL,
			"cancel_reason" = 'canonical-backfill-committed',
			"resolved_at" = CURRENT_TIMESTAMP
		WHERE "bucket" = ${plan.bucket} AND "storage_key" = ${plan.objectKey}
			AND (
				"state" = 'PENDING'::"OrphanState"
				OR ("state" = 'DELETE_CLAIMED'::"OrphanState"
					AND ("claim_until" IS NULL OR "claim_until" <= clock_timestamp()))
			)
	`);
}

function assertAssetSnapshot(current: LegacyAssetRow, planned: LegacyAssetRow): void {
	const fields: Array<keyof LegacyAssetRow> = [
		'projectId', 'exhibitionId', 'kind', 'status', 'storageKey', 'playbackStorageKey',
		'originalName', 'mimeType', 'playbackMimeType', 'sizeBytes', 'playbackSizeBytes',
		'playbackStatus', 'isPublic', 'width', 'height', 'card480Height', 'display960Height',
	];
	if (!sameDate(current.updatedAt, planned.updatedAt) || fields.some((field) => current[field] !== planned[field])) {
		throw new Error(`asset ${planned.id} changed concurrently`);
	}
}

function assertExhibitionSnapshot(current: LegacyExhibitionRow, planned: LegacyExhibitionRow): void {
	const fields: Array<keyof LegacyExhibitionRow> = [
		'posterAssetId', 'posterStorageKey', 'posterOriginalName', 'posterMimeType', 'posterSizeBytes',
		'posterWidth', 'posterHeight', 'posterCard480Height', 'posterDisplay960Height',
	];
	if (!sameDate(current.updatedAt, planned.updatedAt) || fields.some((field) => current[field] !== planned[field])) {
		throw new Error(`exhibition ${planned.id} changed concurrently`);
	}
}

async function readAsset(client: SqlClient, id: number, lock = false): Promise<LegacyAssetRow | null> {
	const rows = await client.$queryRaw<LegacyAssetRow[]>(Prisma.sql`
		SELECT ${assetColumns} FROM "assets" WHERE "id" = ${id} ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}
	`);
	return rows[0] ?? null;
}

async function readExhibition(client: SqlClient, id: number, lock = false): Promise<LegacyExhibitionRow | null> {
	const rows = await client.$queryRaw<LegacyExhibitionRow[]>(Prisma.sql`
		SELECT ${exhibitionColumns} FROM "exhibitions" WHERE "id" = ${id} ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}
	`);
	return rows[0] ?? null;
}

async function upsertRepresentations(tx: Prisma.TransactionClient, assetId: number, plans: readonly CanonicalRepresentationPlan[]): Promise<Map<string, string>> {
	const ids = new Map<string, string>();
	for (const plan of plans) {
		const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
			INSERT INTO "asset_representations" (
				"id", "asset_id", "role", "bucket", "object_key", "mime_type", "size_bytes",
				"checksum_algorithm", "checksum", "etag", "source_identity_algorithm", "source_identity",
				"state", "error", "width", "height", "updated_at"
			) VALUES (
				${randomUUID()}, ${assetId}, ${plan.role}::"AssetRepresentationRole", ${plan.bucket},
				${plan.objectKey}, ${plan.mimeType}, ${plan.sizeBytes}, ${plan.checksumAlgorithm},
				${plan.checksum}, ${plan.etag}, ${plan.sourceIdentityAlgorithm}, ${plan.sourceIdentity},
				'READY'::"AssetRepresentationState", NULL, ${plan.width}, ${plan.height}, CURRENT_TIMESTAMP
			)
			ON CONFLICT ("asset_id", "role") DO UPDATE SET
				"bucket"=EXCLUDED."bucket", "object_key"=EXCLUDED."object_key", "mime_type"=EXCLUDED."mime_type",
				"size_bytes"=EXCLUDED."size_bytes", "checksum_algorithm"=EXCLUDED."checksum_algorithm",
				"checksum"=EXCLUDED."checksum", "etag"=EXCLUDED."etag",
				"source_identity_algorithm"=EXCLUDED."source_identity_algorithm",
				"source_identity"=EXCLUDED."source_identity", "state"=EXCLUDED."state", "error"=NULL,
				"width"=EXCLUDED."width", "height"=EXCLUDED."height", "updated_at"=CURRENT_TIMESTAMP
			WHERE "asset_representations"."bucket" = EXCLUDED."bucket"
				AND "asset_representations"."object_key" = EXCLUDED."object_key"
				AND "asset_representations"."state" = 'READY'::"AssetRepresentationState"
			RETURNING "id"
		`);
		if (rows.length !== 1) {
			throw new Error(`canonical representation conflicts with ${assetId}/${plan.role}`);
		}
		await cancelMaterializationCleanup(tx, plan);
		ids.set(plan.role, rows[0]!.id);
	}
	return ids;
}

async function createCanonicalAsset(tx: Prisma.TransactionClient, input: {
	projectId: number | null; exhibitionId: number | null; kind: 'POSTER' | 'WEBGL';
	originalName: string; mimeType: string; sizeBytes: bigint; isPublic: boolean;
	width?: number | null; height?: number | null; card480Height?: number | null; display960Height?: number | null;
}): Promise<number> {
	const rows = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
		INSERT INTO "assets" (
			"project_id", "exhibition_id", "kind", "status", "storage_key", "original_name", "mime_type",
			"size_bytes", "is_public", "width", "height", "card_480_height", "display_960_height", "updated_at"
		) VALUES (
			${input.projectId}, ${input.exhibitionId}, ${input.kind}::"AssetKind", 'READY'::"AssetStatus", NULL,
			${input.originalName}, ${input.mimeType}, ${input.sizeBytes}, ${input.isPublic}, ${input.width ?? null},
			${input.height ?? null}, ${input.card480Height ?? null}, ${input.display960Height ?? null}, CURRENT_TIMESTAMP
		) RETURNING "id"
	`);
	return rows[0]!.id;
}

function transaction<T>(client: PrismaClient, operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
	return client.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export function createCanonicalBackfillRepository(client: PrismaClient): CanonicalBackfillRepository {
	return {
		listAssets(afterId, limit) {
			return client.$queryRaw<LegacyAssetRow[]>(Prisma.sql`SELECT ${assetColumns} FROM "assets" WHERE "id" > ${afterId} ORDER BY "id" ASC LIMIT ${limit}`);
		},
		listExhibitions(afterId, limit) {
			return client.$queryRaw<LegacyExhibitionRow[]>(Prisma.sql`SELECT ${exhibitionColumns} FROM "exhibitions" WHERE "id" > ${afterId} ORDER BY "id" ASC LIMIT ${limit}`);
		},
		async listWebglProjects(afterId, limit) {
			const projects = await client.$queryRaw<Array<{ id: number; webglEntryKey: string; currentWebglDeploymentId: string | null; updatedAt: Date }>>(Prisma.sql`
				SELECT "id", "webgl_entry_key" AS "webglEntryKey", "current_webgl_deployment_id" AS "currentWebglDeploymentId", "updated_at" AS "updatedAt"
				FROM "projects" WHERE "id" > ${afterId} AND "webgl_entry_key" <> '' ORDER BY "id" ASC LIMIT ${limit}
			`);
			return Promise.all(projects.map((project) => toWebglRow(client, project)));
		},
		getAsset(id) { return readAsset(client, id); },
		getExhibition(id) { return readExhibition(client, id); },
		async getWebglProject(id) {
			const rows = await client.$queryRaw<Array<{ id: number; webglEntryKey: string; currentWebglDeploymentId: string | null; updatedAt: Date }>>(Prisma.sql`
				SELECT "id", "webgl_entry_key" AS "webglEntryKey", "current_webgl_deployment_id" AS "currentWebglDeploymentId", "updated_at" AS "updatedAt"
				FROM "projects" WHERE "id" = ${id}
			`);
			return rows[0] ? toWebglRow(client, rows[0]) : null;
		},
		async prepareMaterializationCleanup(target: CanonicalMaterializationTarget) {
			const prepared = await client.$queryRaw<Array<{ id: number }>>(Prisma.sql`
				INSERT INTO "orphan_objects" (
					"bucket", "storage_key", "reason", "target_kind", "state",
					"claim_token", "claim_until", "cancel_reason", "next_attempt_at",
					"attempt_count", "last_tried_at", "last_error", "resolved_at"
				) VALUES (
					${target.bucket}, ${target.objectKey}, ${target.reason}, 'EXACT'::"OrphanTargetKind",
					'PENDING'::"OrphanState", NULL, NULL, NULL,
					clock_timestamp() + (${MATERIALIZATION_CLEANUP_GRACE_HOURS} * INTERVAL '1 hour'),
					0, NULL, NULL, NULL
				)
				ON CONFLICT ("bucket", "storage_key") DO UPDATE SET
					"reason" = EXCLUDED."reason",
					"target_kind" = 'EXACT'::"OrphanTargetKind",
					"state" = 'PENDING'::"OrphanState",
					"claim_token" = NULL,
					"claim_until" = NULL,
					"cancel_reason" = NULL,
					"next_attempt_at" = EXCLUDED."next_attempt_at",
					"attempt_count" = 0,
					"last_tried_at" = NULL,
					"last_error" = NULL,
					"resolved_at" = NULL
				WHERE "orphan_objects"."state" <> 'DELETE_CLAIMED'::"OrphanState"
					OR "orphan_objects"."claim_until" IS NULL
					OR "orphan_objects"."claim_until" <= clock_timestamp()
				RETURNING "id"
			`);
			if (prepared.length !== 1) {
				throw new Error(`cannot materialize while cleanup is actively claimed: ${target.bucket}/${target.objectKey}`);
			}
		},
		async prepareObjectRelocation(relocation) {
			const expectedChecksum = relocation.copy.expected.checksumSha256?.toLowerCase() ?? null;
			const prepared = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				INSERT INTO "canonical_object_relocations" (
					"id", "work_kind", "work_ref", "role",
					"source_bucket", "source_object_key", "destination_bucket", "destination_object_key",
					"size_bytes", "mime_type", "checksum_sha256", "state", "updated_at"
				) VALUES (
					${relocationId(relocation)}, ${relocation.workKind}, ${relocation.workRef}, ${relocation.role},
					${relocation.copy.sourceBucket}, ${relocation.copy.sourceKey},
					${relocation.copy.destinationBucket}, ${relocation.copy.destinationKey},
					${relocation.copy.expected.size}, ${relocation.copy.expected.mimeType},
					${expectedChecksum}, 'PREPARED', CURRENT_TIMESTAMP
				)
				ON CONFLICT ("source_bucket", "source_object_key", "destination_bucket", "destination_object_key")
				DO UPDATE SET "updated_at" = CURRENT_TIMESTAMP
				WHERE "canonical_object_relocations"."id" = EXCLUDED."id"
					AND "canonical_object_relocations"."work_kind" = EXCLUDED."work_kind"
					AND "canonical_object_relocations"."work_ref" = EXCLUDED."work_ref"
					AND "canonical_object_relocations"."role" = EXCLUDED."role"
					AND "canonical_object_relocations"."size_bytes" = EXCLUDED."size_bytes"
					AND lower("canonical_object_relocations"."mime_type") = lower(EXCLUDED."mime_type")
					AND ("canonical_object_relocations"."checksum_sha256" IS NULL
						OR EXCLUDED."checksum_sha256" IS NULL
						OR "canonical_object_relocations"."checksum_sha256" = EXCLUDED."checksum_sha256")
				RETURNING "id"
			`);
			if (prepared.length !== 1) {
				throw new Error(`canonical relocation identity conflicts: ${relocation.copy.destinationBucket}/${relocation.copy.destinationKey}`);
			}
		},
		async markObjectRelocationMaterialized(relocation) {
			const checksum = relocation.verified.checksumSha256?.toLowerCase();
			if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) {
				throw new Error(`canonical relocation destination lacks SHA-256: ${relocation.copy.destinationBucket}/${relocation.copy.destinationKey}`);
			}
			const materialized = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "canonical_object_relocations"
				SET "size_bytes" = ${relocation.verified.size}, "mime_type" = ${relocation.verified.mimeType},
					"checksum_sha256" = ${checksum},
					"state" = CASE WHEN "state" = 'COMMITTED' THEN 'COMMITTED' ELSE 'MATERIALIZED' END,
					"materialized_at" = COALESCE("materialized_at", CURRENT_TIMESTAMP),
					"updated_at" = CURRENT_TIMESTAMP
				WHERE "id" = ${relocationId(relocation)}
					AND "source_bucket" = ${relocation.copy.sourceBucket}
					AND "source_object_key" = ${relocation.copy.sourceKey}
					AND "destination_bucket" = ${relocation.copy.destinationBucket}
					AND "destination_object_key" = ${relocation.copy.destinationKey}
					AND "size_bytes" = ${relocation.verified.size}
					AND lower("mime_type") = lower(${relocation.verified.mimeType})
					AND ("checksum_sha256" IS NULL OR "checksum_sha256" = ${checksum})
					AND "state" IN ('PREPARED', 'MATERIALIZED', 'COMMITTED')
				RETURNING "id"
			`);
			if (materialized.length !== 1) {
				throw new Error(`canonical relocation materialization conflicts: ${relocation.copy.destinationBucket}/${relocation.copy.destinationKey}`);
			}
		},
		applyAsset(plan): Promise<CanonicalApplyOutcome> {
			return transaction(client, async (tx) => {
				const current = await readAsset(tx, plan.row.id, true);
				if (!current) throw new Error(`asset ${plan.row.id} changed concurrently`);
				assertAssetSnapshot(current, plan.row);
				await upsertRepresentations(tx, plan.row.id, plan.representations);
				await commitRelocations(tx, plan.relocations ?? []);
				return { assetsCreated: 0, representationsUpserted: plan.representations.length, deploymentsUpserted: 0 };
			});
		},
		applyExhibition(plan): Promise<CanonicalApplyOutcome> {
			return transaction(client, async (tx) => {
				const current = await readExhibition(tx, plan.row.id, true);
				if (!current) throw new Error(`exhibition ${plan.row.id} changed concurrently`);
				assertExhibitionSnapshot(current, plan.row);
				let assetId = current.posterAssetId;
				let assetsCreated = 0;
				if (assetId === null) {
					assetId = await createCanonicalAsset(tx, {
						projectId: null, exhibitionId: plan.row.id, kind: 'POSTER', originalName: plan.row.posterOriginalName,
						mimeType: plan.row.posterMimeType, sizeBytes: plan.row.posterSizeBytes, isPublic: true,
						width: plan.row.posterWidth, height: plan.row.posterHeight,
						card480Height: plan.row.posterCard480Height, display960Height: plan.row.posterDisplay960Height,
					});
					assetsCreated = 1;
				} else {
					const owners = await tx.$queryRaw<Array<{ projectId: number | null; exhibitionId: number | null; kind: string }>>(Prisma.sql`
						SELECT "project_id" AS "projectId", "exhibition_id" AS "exhibitionId", "kind"::text AS "kind" FROM "assets" WHERE "id" = ${assetId} FOR UPDATE
					`);
					const existing = owners[0];
					if (!existing || existing.exhibitionId !== plan.row.id || existing.projectId !== null || existing.kind !== 'POSTER') throw new Error(`exhibition ${plan.row.id} canonical poster conflicts with its owner`);
				}
				await upsertRepresentations(tx, assetId, plan.representations);
				await commitRelocations(tx, plan.relocations ?? []);
				if (current.posterAssetId === null) await tx.$executeRaw(Prisma.sql`UPDATE "exhibitions" SET "poster_asset_id" = ${assetId} WHERE "id" = ${plan.row.id}`);
				return { assetsCreated, representationsUpserted: plan.representations.length, deploymentsUpserted: 0 };
			});
		},
		applyWebgl(plan): Promise<CanonicalApplyOutcome> {
			return transaction(client, async (tx) => {
				const projects = await tx.$queryRaw<Array<{ webglEntryKey: string; currentWebglDeploymentId: string | null; updatedAt: Date }>>(Prisma.sql`
					SELECT "webgl_entry_key" AS "webglEntryKey", "current_webgl_deployment_id" AS "currentWebglDeploymentId", "updated_at" AS "updatedAt"
					FROM "projects" WHERE "id" = ${plan.row.id} FOR UPDATE
				`);
				const current = projects[0];
				if (!current || current.webglEntryKey !== plan.row.webglEntryKey) throw new Error(`webgl ${plan.row.id} changed concurrently`);
				if (current.currentWebglDeploymentId !== null) {
					if (current.currentWebglDeploymentId !== plan.deploymentId) throw new Error(`webgl ${plan.row.id} canonical deployment conflicts with its pointer`);
					return { assetsCreated: 0, representationsUpserted: 0, deploymentsUpserted: 0 };
				}
				if (!sameDate(current.updatedAt, plan.row.updatedAt) || !plan.row.sourceProof) throw new Error(`webgl ${plan.row.id} changed concurrently`);
				await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "game_upload_sessions" WHERE "id" = ${plan.row.sourceProof.sessionId} FOR UPDATE`);
				const proof = await sourceProofForProject(tx, plan.row.id, plan.row.webglEntryKey);
				if (!proof || proof.sessionId !== plan.row.sourceProof.sessionId || proof.storageKey !== plan.row.sourceProof.storageKey
					|| proof.totalBytes !== plan.row.sourceProof.totalBytes || proof.originalName !== plan.row.sourceProof.originalName
					|| !sameDate(proof.updatedAt, plan.row.sourceProof.updatedAt)) throw new Error(`webgl ${plan.row.id} source proof changed concurrently`);
				let assetId: number;
				let assetsCreated = 0;
				if (plan.row.sourceLegacyAssetKind === 'WEBGL' && plan.row.sourceLegacyAssetId !== null) {
					const source = await readAsset(tx, plan.row.sourceLegacyAssetId, true);
					if (!source || source.projectId !== plan.row.id || source.storageKey !== proof.storageKey || source.status !== 'READY' || source.kind !== 'WEBGL') throw new Error(`webgl ${plan.row.id} legacy source asset changed concurrently`);
					assetId = source.id;
				} else {
					assetId = await createCanonicalAsset(tx, { projectId: plan.row.id, exhibitionId: null, kind: 'WEBGL', originalName: proof.originalName, mimeType: plan.source.mimeType, sizeBytes: plan.source.sizeBytes, isPublic: false });
					assetsCreated = 1;
				}
				const representationIds = await upsertRepresentations(tx, assetId, [plan.source]);
				const sourceRepresentationId = representationIds.get('WEBGL_SOURCE')!;
				const existing = await tx.$queryRaw<Array<{
					projectId: number; sourceRepresentationId: string; publicBucket: string;
					publicPrefix: string; entryObjectKey: string; manifestMatches: boolean; state: string;
				}>>(Prisma.sql`
					SELECT "project_id" AS "projectId", "source_representation_id" AS "sourceRepresentationId", "public_bucket" AS "publicBucket", "public_prefix" AS "publicPrefix", "entry_object_key" AS "entryObjectKey"
						, ("object_manifest" = ${JSON.stringify(plan.objectManifest)}::jsonb) AS "manifestMatches", "state"::text AS "state"
					FROM "webgl_deployments" WHERE "id" = ${plan.deploymentId}
				`);
				if (existing[0]) {
					const deployment = existing[0];
					if (deployment.projectId !== plan.row.id || deployment.sourceRepresentationId !== sourceRepresentationId
						|| deployment.publicBucket !== plan.publicBucket || deployment.publicPrefix !== plan.publicPrefix
						|| deployment.entryObjectKey !== plan.entryObjectKey || deployment.state !== 'READY'
						|| !deployment.manifestMatches) {
						throw new Error(`webgl ${plan.row.id} deployment identity conflicts`);
					}
				} else {
					await tx.$executeRaw(Prisma.sql`
						INSERT INTO "webgl_deployments" ("id", "project_id", "source_representation_id", "public_bucket", "public_prefix", "entry_object_key", "object_manifest", "state", "error", "updated_at")
						VALUES (${plan.deploymentId}, ${plan.row.id}, ${sourceRepresentationId}, ${plan.publicBucket}, ${plan.publicPrefix}, ${plan.entryObjectKey}, ${JSON.stringify(plan.objectManifest)}::jsonb, 'READY'::"WebglDeploymentState", NULL, CURRENT_TIMESTAMP)
					`);
				}
				await tx.$executeRaw(Prisma.sql`UPDATE "projects" SET "current_webgl_deployment_id" = ${plan.deploymentId} WHERE "id" = ${plan.row.id}`);
				return { assetsCreated, representationsUpserted: 1, deploymentsUpserted: existing[0] ? 0 : 1 };
			});
		},
	};
}
