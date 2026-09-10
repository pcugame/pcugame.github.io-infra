import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import {
	LEGACY_BRIDGE_METRIC_NAMES,
	type ContractAssetRepresentation,
	type ContractPreflightRepository,
	type ContractPreflightSnapshot,
} from './contract-preflight.js';

/** Pre-contract raw SQL adapter, compatible with a freshly generated final client. */
export function createContractPreflightRepository(client: PrismaClient): ContractPreflightRepository {
	return {
		readSnapshot() {
			return client.$transaction(async (tx): Promise<ContractPreflightSnapshot> => {
				const [assets, representations, exhibitions, projects, deployments, metrics, uploadSessions, cleanupTasks, storageBuckets, relocations] = await Promise.all([
					tx.$queryRaw<Array<Omit<ContractPreflightSnapshot['assets'][number], 'representations'>>>(Prisma.sql`
						SELECT "id", "project_id" AS "projectId", "exhibition_id" AS "exhibitionId",
							"kind"::text AS "kind", "status"::text AS "status", "storage_key" AS "storageKey",
							"playback_storage_key" AS "playbackStorageKey", "playback_status"::text AS "playbackStatus",
							"card_480_height" AS "card480Height", "display_960_height" AS "display960Height"
						FROM "assets" ORDER BY "id"
					`),
					tx.$queryRaw<ContractAssetRepresentation[]>(Prisma.sql`
						SELECT "id", "asset_id" AS "assetId", "role"::text AS "role", "bucket",
							"object_key" AS "objectKey", "publication_bucket" AS "publicationBucket",
							"publication_object_key" AS "publicationObjectKey", "mime_type" AS "mimeType", "size_bytes" AS "sizeBytes",
							"checksum_algorithm" AS "checksumAlgorithm", "checksum", "etag",
							"source_identity_algorithm" AS "sourceIdentityAlgorithm",
							"source_identity" AS "sourceIdentity", "state"::text AS "state"
						FROM "asset_representations" ORDER BY "asset_id", "role"::text
					`),
					tx.$queryRaw<ContractPreflightSnapshot['exhibitions']>(Prisma.sql`
						SELECT "id", "poster_storage_key" AS "posterStorageKey", "poster_asset_id" AS "posterAssetId",
							"poster_card_480_height" AS "posterCard480Height",
							"poster_display_960_height" AS "posterDisplay960Height"
						FROM "exhibitions" ORDER BY "id"
					`),
					tx.$queryRaw<Array<Omit<ContractPreflightSnapshot['projects'][number], 'currentWebglDeployment'>>>(Prisma.sql`
						SELECT "id", "status"::text AS "status", "webgl_entry_key" AS "webglEntryKey",
							"current_webgl_deployment_id" AS "currentWebglDeploymentId"
						FROM "projects" ORDER BY "id"
					`),
					tx.$queryRaw<ContractPreflightSnapshot['deployments']>(Prisma.sql`
						SELECT "id", "project_id" AS "projectId", "source_representation_id" AS "sourceRepresentationId",
							"public_bucket" AS "publicBucket", "public_prefix" AS "publicPrefix",
							"entry_object_key" AS "entryObjectKey", "object_manifest" AS "objectManifest",
							"staging_bucket" AS "stagingBucket", "staging_prefix" AS "stagingPrefix",
							"staging_entry_object_key" AS "stagingEntryObjectKey",
							"staging_object_manifest" AS "stagingObjectManifest",
							"state"::text AS "state"
						FROM "webgl_deployments" ORDER BY "id"
					`),
					tx.$queryRaw<ContractPreflightSnapshot['metrics']>(Prisma.sql`
						SELECT "name", "scope", "value", "last_observed_at" AS "lastObservedAt", "details"
						FROM "migration_metrics"
						ORDER BY "name", "scope"
					`),
					tx.$queryRaw<ContractPreflightSnapshot['uploadSessions']>(Prisma.sql`
						SELECT "id", "status", "upload_kind"::text AS "uploadKind", "storage_key" AS "storageKey"
						FROM "game_upload_sessions"
						UNION ALL
						SELECT "id", "state"::text AS "status", "kind"::text AS "uploadKind", "object_key" AS "storageKey"
						FROM "asset_upload_sessions"
						ORDER BY "id"
					`),
					tx.$queryRaw<ContractPreflightSnapshot['cleanupTasks']>(Prisma.sql`
						SELECT 'MULTIPART_ABORT'::text AS "kind", "id"::text, "state"::text
						FROM "multipart_abort_tasks" WHERE "state"::text <> 'RESOLVED'
						UNION ALL
						SELECT 'ORPHAN_OBJECT'::text AS "kind", "id"::text, "state"::text
						FROM "orphan_objects" WHERE "state"::text NOT IN ('RESOLVED', 'CANCELLED')
						UNION ALL
						SELECT 'UPLOAD_INTENT'::text AS "kind", "id"::text, "state"::text
						FROM "upload_intents" WHERE "state"::text IN ('PREPARED', 'UPLOADED', 'CLEANUP_QUEUED')
						ORDER BY "kind", "id"
					`),
					tx.$queryRaw<ContractPreflightSnapshot['storageBuckets']>(Prisma.sql`
						SELECT "bucket", "visibility"::text AS "visibility"
						FROM "storage_buckets" ORDER BY "bucket"
					`),
					tx.$queryRaw<ContractPreflightSnapshot['relocations']>(Prisma.sql`
						SELECT "id", "work_kind" AS "workKind", "work_ref" AS "workRef", "role",
							"source_bucket" AS "sourceBucket", "source_object_key" AS "sourceObjectKey",
							"destination_bucket" AS "destinationBucket", "destination_object_key" AS "destinationObjectKey",
							"size_bytes" AS "sizeBytes", "mime_type" AS "mimeType",
							"checksum_sha256" AS "checksumSha256", "state"
						FROM "canonical_object_relocations" ORDER BY "id"
					`),
				]);
				const byAsset = new Map<number, ContractAssetRepresentation[]>();
				for (const representation of representations) {
					const rows = byAsset.get(representation.assetId) ?? [];
					rows.push(representation);
					byAsset.set(representation.assetId, rows);
				}
				const deploymentById = new Map(deployments.map((deployment) => [deployment.id, deployment]));
				return {
					assets: assets.map((asset) => ({ ...asset, representations: byAsset.get(asset.id) ?? [] })),
					exhibitions,
					projects: projects.map((project) => ({
						...project,
						currentWebglDeployment: project.currentWebglDeploymentId
							? deploymentById.get(project.currentWebglDeploymentId) ?? null
							: null,
					})),
					deployments, metrics, uploadSessions, cleanupTasks, storageBuckets, relocations,
				};
			}, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
		},
		async resetLegacyBridgeObservations(observedAt) {
			await client.$transaction(async (tx) => {
				// Producers upsert arbitrary scopes. A table write lock makes the reset
				// one observation boundary: no existing or newly inserted scope can
				// race between the all-scope reset and the baseline-row seed.
				await tx.$executeRawUnsafe('LOCK TABLE "migration_metrics" IN SHARE ROW EXCLUSIVE MODE');
				await tx.$executeRaw(Prisma.sql`
					UPDATE "migration_metrics"
					SET "value" = 0, "last_observed_at" = ${observedAt},
						"details" = '{"reset":"contract-preflight"}'::jsonb,
						"updated_at" = CURRENT_TIMESTAMP
					WHERE "name" IN (${Prisma.join([...LEGACY_BRIDGE_METRIC_NAMES])})
				`);
				await tx.$executeRaw(Prisma.sql`
					INSERT INTO "migration_metrics" ("name", "scope", "value", "last_observed_at", "details", "updated_at")
					SELECT "name", '', 0, ${observedAt}, '{"reset":"contract-preflight"}'::jsonb, CURRENT_TIMESTAMP
					FROM (VALUES ${Prisma.join(LEGACY_BRIDGE_METRIC_NAMES.map((name) => Prisma.sql`(${name})`))}) AS requested("name")
					ON CONFLICT ("name", "scope") DO UPDATE SET
						"value" = 0, "last_observed_at" = EXCLUDED."last_observed_at",
						"details" = EXCLUDED."details", "updated_at" = CURRENT_TIMESTAMP
				`);
			}, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
		},
	};
}
