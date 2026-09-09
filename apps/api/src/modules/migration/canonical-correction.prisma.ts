import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { createCanonicalBackfillRepository } from './canonical-backfill.prisma.js';
import { correctionAssetId, stableJson } from './canonical-correction.js';
import type { CorrectionItem, CorrectionManifest, CorrectionOutput, CorrectionRepository } from './canonical-correction.types.js';
import { OBJECT_REFERENCE_CLAIM_LOCK_ID } from '../orphan/reference-resolver.js';

type SqlClient = PrismaClient | Prisma.TransactionClient;
type Row = Record<string, unknown>;
const activeUploads = Prisma.sql`('ALLOCATING', 'UPLOADING', 'COMPLETING', 'VERIFYING')`;

async function snapshot(client: SqlClient, projectIds: number[], keys: string[]): Promise<Record<string, unknown>> {
	const owners = Prisma.join([...projectIds].sort((a, b) => a - b));
	const sourceKeys = Prisma.join(keys);
	const queries: Record<string, Prisma.Sql> = {
		projects: Prisma.sql`SELECT to_jsonb(t) AS row FROM projects t WHERE id IN (${owners}) ORDER BY id`,
		assets: Prisma.sql`SELECT to_jsonb(t) AS row FROM assets t WHERE project_id IN (${owners}) ORDER BY id`,
		representations: Prisma.sql`SELECT to_jsonb(t) AS row FROM asset_representations t WHERE asset_id IN (SELECT id FROM assets WHERE project_id IN (${owners})) ORDER BY id`,
		uploads: Prisma.sql`SELECT to_jsonb(t) AS row FROM asset_upload_sessions t WHERE project_id IN (${owners}) AND state::text IN ${activeUploads} ORDER BY id`,
		legacyUploads: Prisma.sql`SELECT to_jsonb(t) AS row FROM game_upload_sessions t WHERE project_id IN (${owners}) AND status::text NOT IN ('COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED') ORDER BY id`,
		submissionItems: Prisma.sql`SELECT to_jsonb(t) AS row FROM project_submission_items t WHERE result_asset_id IN (SELECT id FROM assets WHERE project_id IN (${owners})) ORDER BY id`,
		posterReferences: Prisma.sql`SELECT to_jsonb(t) AS row FROM projects t WHERE poster_asset_id IN (SELECT id FROM assets WHERE project_id IN (${owners})) ORDER BY id`,
		exhibitionReferences: Prisma.sql`SELECT to_jsonb(t) AS row FROM exhibitions t WHERE poster_asset_id IN (SELECT id FROM assets WHERE project_id IN (${owners})) ORDER BY id`,
		sourceClaims: Prisma.sql`SELECT to_jsonb(t) AS row FROM assets t WHERE storage_key IN (${sourceKeys}) OR playback_storage_key IN (${sourceKeys}) ORDER BY id`,
		sourceRepresentations: Prisma.sql`SELECT to_jsonb(t) AS row FROM asset_representations t WHERE object_key IN (${sourceKeys}) OR publication_object_key IN (${sourceKeys}) ORDER BY id`,
	};
	const result: Record<string, unknown> = {};
	for (const [name, query] of Object.entries(queries)) result[name] = (await client.$queryRaw<Array<{ row: Row }>>(query)).map((r) => r.row);
	return result;
}

export function assertCorrectionSnapshot(manifest: CorrectionManifest, current: Record<string, unknown>): void {
	if (stableJson(current) !== stableJson(manifest.snapshots)) throw new Error('Owner, asset, representation, reference or upload reservation changed concurrently');
	const assets = current['assets'] as Row[];
	const projects = current['projects'] as Row[];
	const claims = current['sourceClaims'] as Row[];
	const sourceRepresentations = current['sourceRepresentations'] as Row[];
	const affected = new Set(manifest.items.map((item) => item.assetId));
	for (const item of manifest.items) {
		if (!projects.some((row) => row['id'] === item.projectId)) throw new Error('Owning project does not exist');
		const original = assets.find((row) => row['id'] === item.assetId);
		const owners = claims.filter((row) => row['storage_key'] === item.source.key || row['playback_storage_key'] === item.source.key);
		if (item.sourceAlias) {
			const representations = current['representations'] as Row[];
			if (!original || original['project_id'] !== item.projectId || original['kind'] !== item.targetKind || owners.length
				|| !representations.some((row) => row['asset_id'] === item.assetId && row['role'] === 'ORIGINAL' && row['state'] === 'READY'
					&& row['checksum'] === item.source.sha256 && String(row['size_bytes']) === item.source.sizeBytes)) throw new Error('Alias is not proven by the existing original');
		} else if (item.assetId !== null) {
			if (!original || original['project_id'] !== item.projectId || original['exhibition_id'] !== null || original['status'] !== 'READY'
				|| original['storage_key'] !== item.source.key || String(original['size_bytes']) !== item.source.sizeBytes
				|| original['mime_type'] !== item.source.mimeType || original['original_name'] !== item.originalName
				|| owners.length !== 1 || owners[0]?.['id'] !== item.assetId) throw new Error('Existing source owner or legacy metadata is not proven');
			if (item.targetKind === 'VIDEO' && original['kind'] !== 'IMAGE') throw new Error('Video correction requires a misclassified IMAGE');
			if (item.targetKind === 'POSTER' && (original['kind'] !== 'POSTER'
				|| !projects.some((row) => row['id'] === item.projectId && row['poster_asset_id'] === item.assetId))) throw new Error('Poster pointer does not prove ownership');
		} else if (owners.length || assets.some((row) => row['id'] === item.reservedAssetId)) throw new Error('Unregistered object or reserved asset ID already has an owner');
		if (sourceRepresentations.some((row) => (row['object_key'] === item.source.key || row['publication_object_key'] === item.source.key)
			&& row['asset_id'] !== item.assetId)) throw new Error('Source representation has another owner');
		if (item.targetKind === 'VIDEO' && assets.some((row) => row['project_id'] === item.projectId && row['kind'] === 'VIDEO'
			&& row['status'] === 'READY' && row['video_sort_order'] === item.videoSortOrder && !affected.has(row['id'] as number))) throw new Error('Target order conflicts with an existing video');
		if (item.targetKind === 'VIDEO' && ((current['uploads'] as Row[]).some((row) => row['project_id'] === item.projectId && row['kind'] === 'VIDEO')
			|| (current['legacyUploads'] as Row[]).some((row) => row['project_id'] === item.projectId && row['upload_kind'] === 'VIDEO'))) throw new Error('Video has an active upload reservation');
		if (item.targetKind === 'DOCUMENT' || item.targetKind === 'ATTACHMENT') {
			const kinds = new Set(['DOCUMENT', 'ATTACHMENT']);
			const count = assets.filter((r) => r['project_id'] === item.projectId && r['status'] === 'READY' && kinds.has(r['kind'] as string) && !affected.has(r['id'] as number)).length
				+ (current['uploads'] as Row[]).filter((r) => r['project_id'] === item.projectId && kinds.has(r['kind'] as string)).length
				+ manifest.items.filter((i) => i.projectId === item.projectId && kinds.has(i.targetKind)).length;
			if (count > 5 || BigInt(item.source.sizeBytes) > 50n * 1024n * 1024n) throw new Error('Project document/attachment limit exceeded');
		}
	}
}

function relocation(item: CorrectionItem, output: CorrectionOutput) {
	return { workKind: 'asset' as const, workRef: String(correctionAssetId(item)), role: output.role,
		copy: { sourceBucket: item.source.bucket, sourceKey: item.source.key, destinationBucket: output.bucket, destinationKey: output.objectKey,
			expected: { size: BigInt(item.source.sizeBytes), mimeType: item.source.mimeType, checksumSha256: item.source.sha256 } },
		verified: { size: BigInt(output.sizeBytes), mimeType: output.mimeType, checksumSha256: output.checksum! } };
}
function relocationId(item: CorrectionItem, output: CorrectionOutput): string {
	return createHash('sha256').update([item.source.bucket, item.source.key, output.bucket, output.objectKey].join('\0')).digest('hex');
}

async function protectAgainstDeletes(tx: SqlClient, bucket: string, key: string, cancel: boolean): Promise<void> {
	const rows = await tx.$queryRaw<Array<{ id: number; active: boolean }>>(Prisma.sql`
		SELECT id, (state = 'DELETE_CLAIMED'::"OrphanState" AND claim_until > clock_timestamp()) AS active
		FROM orphan_objects WHERE bucket = ${bucket} AND (storage_key = ${key}
			OR (target_kind = 'PREFIX'::"OrphanTargetKind" AND starts_with(${key}, storage_key))) ORDER BY id FOR UPDATE`);
	if (rows.some((row) => row.active)) throw new Error(`Object has an active deletion claim: ${bucket}/${key}`);
	const intents = await tx.$queryRaw<Array<{ id: string; active: boolean }>>(Prisma.sql`
		SELECT id, (claim_until > clock_timestamp()) AS active FROM upload_intents
		WHERE bucket = ${bucket} AND storage_key = ${key} ORDER BY id FOR UPDATE`);
	if (intents.some((row) => row.active)) throw new Error(`Object has an active upload cleanup claim: ${bucket}/${key}`);
	if (!cancel && rows.length) await tx.$executeRaw(Prisma.sql`UPDATE orphan_objects SET state = 'PENDING'::"OrphanState",
		claim_token = NULL, claim_until = NULL, next_attempt_at = clock_timestamp() + interval '24 hours'
		WHERE id IN (${Prisma.join(rows.map((row) => row.id))}) AND state IN ('PENDING'::"OrphanState", 'DELETE_CLAIMED'::"OrphanState")`);
	if (!cancel && intents.length) await tx.$executeRaw(Prisma.sql`UPDATE upload_intents SET not_before = GREATEST(not_before, clock_timestamp() + interval '24 hours'),
		next_attempt_at = GREATEST(next_attempt_at, clock_timestamp() + interval '24 hours'), updated_at = CURRENT_TIMESTAMP
		WHERE id IN (${Prisma.join(intents.map((row) => row.id))})`);
	if (cancel && rows.length) await tx.$executeRaw(Prisma.sql`UPDATE orphan_objects SET state = 'CANCELLED'::"OrphanState",
		claim_token = NULL, claim_until = NULL, cancel_reason = 'canonical-correction-committed', resolved_at = CURRENT_TIMESTAMP
		WHERE id IN (${Prisma.join(rows.map((row) => row.id))})`);
	if (cancel && intents.length) await tx.$executeRaw(Prisma.sql`UPDATE upload_intents SET state = 'COMMITTED'::"UploadIntentState",
		claim_token = NULL, claim_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id IN (${Prisma.join(intents.map((row) => row.id))})`);
}

async function isAlreadyApplied(tx: SqlClient, manifest: CorrectionManifest): Promise<boolean> {
	for (const item of manifest.items) {
		const id = correctionAssetId(item);
		const rows = await tx.$queryRaw<Array<{ row: Row }>>(Prisma.sql`SELECT to_jsonb(a) AS row FROM assets a WHERE id = ${id}`);
		const current = rows[0]?.row;
		if (!current) return false;
		const original = item.outputs.find((o) => o.role === 'ORIGINAL')!;
		const playback = item.outputs.find((o) => o.role === 'PLAYBACK');
		const expected: Row = item.sourceAlias
			? (manifest.snapshots['assets'] as Row[]).find((row) => row['id'] === id)!
			: { project_id: item.projectId, exhibition_id: null, kind: item.targetKind, status: 'READY', video_sort_order: item.videoSortOrder,
				original_name: item.originalName, storage_key: original.objectKey, mime_type: original.mimeType, size_bytes: Number(original.sizeBytes),
				is_public: item.targetKind === 'POSTER', playback_storage_key: playback?.objectKey ?? null, playback_mime_type: playback?.mimeType ?? '',
				playback_size_bytes: Number(playback?.sizeBytes ?? '0'), playback_status: playback ? 'READY' : 'PENDING',
				width: original.width, height: original.height, card_480_height: item.outputs.find((o) => o.role === 'CARD_480')?.height ?? null,
				display_960_height: item.outputs.find((o) => o.role === 'DISPLAY_960')?.height ?? null };
		if (!expected || Object.entries(expected).some(([key, value]) => stableJson(current[key]) !== stableJson(value))) return false;
		for (const output of item.outputs) {
			const reps = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM asset_representations
				WHERE asset_id = ${id} AND role::text = ${output.role} AND bucket = ${output.bucket} AND object_key = ${output.objectKey}
				AND checksum_algorithm = 'SHA256' AND checksum = ${output.checksum} AND size_bytes = ${BigInt(output.sizeBytes)}
				AND mime_type = ${output.mimeType} AND width IS NOT DISTINCT FROM ${output.width} AND height IS NOT DISTINCT FROM ${output.height}
				AND state::text = 'READY'`);
			if (reps.length !== 1) return false;
			if (output.provenance.operation === 'COPY') {
				const ledger = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM canonical_object_relocations
					WHERE id = ${relocationId(item, output)} AND state = 'COMMITTED'`);
				if (ledger.length !== 1) return false;
			}
		}
	}
	return true;
}

export function createCanonicalCorrectionRepository(client: PrismaClient): CorrectionRepository {
	const backfill = createCanonicalBackfillRepository(client);
	return {
		snapshot: (ids, keys) => snapshot(client, ids, keys),
		async reserveAssetId() {
			const rows = await client.$queryRaw<Array<{ id: bigint }>>(Prisma.sql`SELECT nextval(pg_get_serial_sequence('assets', 'id')) AS id`);
			const id = Number(rows[0]?.id);
			if (!Number.isSafeInteger(id) || id < 1) throw new Error('Could not reserve asset sequence ID');
			return id;
		},
		async protect(item, output) {
			await client.$transaction(async (tx) => {
				await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${OBJECT_REFERENCE_CLAIM_LOCK_ID})`);
				const committed = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM canonical_object_relocations
					WHERE work_kind = 'asset' AND work_ref = ${String(correctionAssetId(item))} AND role = 'ORIGINAL'
					AND source_bucket = ${item.source.bucket} AND source_object_key = ${item.source.key} AND state = 'COMMITTED'`);
				if (committed.length) return;
				await protectAgainstDeletes(tx, item.source.bucket, item.source.key, false);
				await protectAgainstDeletes(tx, output.bucket, output.objectKey, false);
				// Upload intents are actual resolver references, so a newly enqueued
				// overlapping prefix also cannot delete objects after this transaction.
				for (const target of [{ bucket: item.source.bucket, key: item.source.key, source: true }, { bucket: output.bucket, key: output.objectKey, source: false }]) {
					const intent = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`INSERT INTO upload_intents
						(id, bucket, storage_key, purpose, owner_project_id, state, not_before, next_attempt_at, updated_at)
						VALUES (${randomUUID()}, ${target.bucket}, ${target.key}, 'canonical-correction-protection', ${item.projectId}, 'PREPARED'::"UploadIntentState",
						${target.source ? Prisma.sql`TIMESTAMP '9999-01-01'` : Prisma.sql`clock_timestamp() + interval '24 hours'`}, clock_timestamp() + interval '24 hours', CURRENT_TIMESTAMP)
						ON CONFLICT (bucket, storage_key) DO UPDATE SET state = 'PREPARED'::"UploadIntentState",
						not_before = GREATEST(upload_intents.not_before, EXCLUDED.not_before), next_attempt_at = EXCLUDED.next_attempt_at,
						claim_token = NULL, claim_until = NULL, updated_at = CURRENT_TIMESTAMP
						WHERE upload_intents.purpose = EXCLUDED.purpose AND upload_intents.owner_project_id = EXCLUDED.owner_project_id RETURNING id`);
					if (intent.length !== 1) throw new Error('Existing upload intent conflicts with correction protection');
				}
				if (output.provenance.operation === 'COPY') {
					const ledger = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`INSERT INTO canonical_object_relocations
						(id, work_kind, work_ref, role, source_bucket, source_object_key, destination_bucket, destination_object_key,
						 size_bytes, mime_type, checksum_sha256, state, updated_at)
						VALUES (${relocationId(item, output)}, 'asset', ${String(correctionAssetId(item))}, ${output.role}, ${item.source.bucket}, ${item.source.key},
						${output.bucket}, ${output.objectKey}, ${BigInt(output.sizeBytes)}, ${output.mimeType}, ${output.checksum}, 'PREPARED', CURRENT_TIMESTAMP)
						ON CONFLICT (source_bucket, source_object_key, destination_bucket, destination_object_key) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
						WHERE canonical_object_relocations.id = EXCLUDED.id AND canonical_object_relocations.work_kind = EXCLUDED.work_kind
						AND canonical_object_relocations.work_ref = EXCLUDED.work_ref AND canonical_object_relocations.role = EXCLUDED.role
						AND canonical_object_relocations.size_bytes = EXCLUDED.size_bytes AND canonical_object_relocations.mime_type = EXCLUDED.mime_type
						AND canonical_object_relocations.checksum_sha256 = EXCLUDED.checksum_sha256 RETURNING id`);
					if (ledger.length !== 1) throw new Error('Canonical relocation identity conflicts');
				}
				await tx.$executeRaw(Prisma.sql`INSERT INTO orphan_objects(bucket, storage_key, reason, target_kind, state, next_attempt_at)
					VALUES (${output.bucket}, ${output.objectKey}, 'canonical-correction-prepared', 'EXACT'::"OrphanTargetKind", 'PENDING'::"OrphanState", clock_timestamp() + interval '24 hours')
					ON CONFLICT (bucket, storage_key) DO UPDATE SET state = 'PENDING'::"OrphanState", claim_token = NULL, claim_until = NULL,
					next_attempt_at = EXCLUDED.next_attempt_at, cancel_reason = NULL, resolved_at = NULL`);
			});
		},
		async materialized(item, output) {
			if (output.provenance.operation === 'COPY') await backfill.markObjectRelocationMaterialized(relocation(item, output));
		},
		async apply(manifest, verifyObjects) {
			return client.$transaction(async (tx) => {
				const ids = [...new Set(manifest.items.map((i) => i.projectId))].sort((a, b) => a - b);
				// Same lock order as normal asset mutations: project owners, then assets, then references.
				await tx.$queryRaw(Prisma.sql`SELECT id FROM projects WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`);
				await tx.$queryRaw(Prisma.sql`SELECT id FROM assets WHERE project_id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`);
				await tx.$queryRaw(Prisma.sql`SELECT id FROM asset_representations WHERE asset_id IN (SELECT id FROM assets WHERE project_id IN (${Prisma.join(ids)})) ORDER BY id FOR UPDATE`);
				await tx.$queryRaw(Prisma.sql`SELECT id FROM asset_upload_sessions WHERE project_id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`);
				await tx.$queryRaw(Prisma.sql`SELECT id FROM game_upload_sessions WHERE project_id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`);
				await tx.$queryRaw(Prisma.sql`SELECT id FROM project_submission_items WHERE result_asset_id IN (SELECT id FROM assets WHERE project_id IN (${Prisma.join(ids)})) ORDER BY id FOR UPDATE`);
				const alreadyApplied = await isAlreadyApplied(tx, manifest);
				if (!alreadyApplied) assertCorrectionSnapshot(manifest, await snapshot(tx, ids, manifest.items.map((i) => i.source.key)));
				await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${OBJECT_REFERENCE_CLAIM_LOCK_ID})`);
				for (const item of manifest.items) {
					await protectAgainstDeletes(tx, item.source.bucket, item.source.key, true);
					for (const output of item.outputs) await protectAgainstDeletes(tx, output.bucket, output.objectKey, true);
				}
				// Full-byte checks run after locks, before the first asset change.
				await verifyObjects();
				if (alreadyApplied) return 'ALREADY_APPLIED';
				for (const item of manifest.items) {
					const id = correctionAssetId(item);
					const original = item.outputs.find((o) => o.role === 'ORIGINAL')!;
					const playback = item.outputs.find((o) => o.role === 'PLAYBACK');
					const card = item.outputs.find((o) => o.role === 'CARD_480');
					const display = item.outputs.find((o) => o.role === 'DISPLAY_960');
					if (item.assetId === null) await tx.$executeRaw(Prisma.sql`INSERT INTO assets
						(id, project_id, exhibition_id, kind, status, original_name, storage_key, mime_type, size_bytes, is_public, updated_at)
						VALUES (${id}, ${item.projectId}, NULL, ${item.targetKind}::"AssetKind", 'READY'::"AssetStatus", ${item.originalName},
						${original.objectKey}, ${original.mimeType}, ${BigInt(original.sizeBytes)}, false, CURRENT_TIMESTAMP)`);
					if (!item.sourceAlias) await tx.$executeRaw(Prisma.sql`UPDATE assets SET kind = ${item.targetKind}::"AssetKind", video_sort_order = ${item.videoSortOrder},
						is_public = ${item.targetKind === 'POSTER'}, storage_key = ${original.objectKey},
						mime_type = ${original.mimeType}, size_bytes = ${BigInt(original.sizeBytes)},
						playback_storage_key = ${playback?.objectKey ?? null}, playback_mime_type = ${playback?.mimeType ?? ''},
						playback_size_bytes = ${BigInt(playback?.sizeBytes ?? '0')},
						playback_status = ${playback ? 'READY' : 'PENDING'}::"AssetPlaybackStatus",
						width = ${original.width}, height = ${original.height}, card_480_height = ${card?.height ?? null},
						display_960_height = ${display?.height ?? null}, updated_at = CURRENT_TIMESTAMP WHERE id = ${id}`);
					for (const output of item.outputs) {
						const written = item.sourceAlias ? [{ id: 'existing-alias-original' }] : await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`INSERT INTO asset_representations
							(id, asset_id, role, bucket, object_key, mime_type, size_bytes, checksum_algorithm, checksum, etag,
							 source_identity_algorithm, source_identity, state, width, height, updated_at)
							VALUES (${randomUUID()}, ${id}, ${output.role}::"AssetRepresentationRole", ${output.bucket}, ${output.objectKey},
							${output.mimeType}, ${BigInt(output.sizeBytes)}, 'SHA256', ${output.checksum}, ${output.etag},
							${output.sourceIdentityAlgorithm}, ${output.sourceIdentity}, 'READY'::"AssetRepresentationState", ${output.width}, ${output.height}, CURRENT_TIMESTAMP)
							ON CONFLICT (asset_id, role) DO UPDATE SET bucket = EXCLUDED.bucket, object_key = EXCLUDED.object_key,
							mime_type = EXCLUDED.mime_type, size_bytes = EXCLUDED.size_bytes, checksum_algorithm = EXCLUDED.checksum_algorithm,
							checksum = EXCLUDED.checksum, etag = EXCLUDED.etag, source_identity_algorithm = EXCLUDED.source_identity_algorithm,
							source_identity = EXCLUDED.source_identity, state = EXCLUDED.state, width = EXCLUDED.width, height = EXCLUDED.height, updated_at = CURRENT_TIMESTAMP
							WHERE asset_representations.bucket = EXCLUDED.bucket AND asset_representations.object_key = EXCLUDED.object_key
							AND asset_representations.state::text = 'READY' RETURNING id`);
						if (written.length !== 1) throw new Error(`Existing representation conflicts: ${id}/${output.role}`);
						if (output.provenance.operation === 'COPY') {
							const committed = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`UPDATE canonical_object_relocations SET state = 'COMMITTED',
								committed_at = COALESCE(committed_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
								WHERE id = ${relocationId(item, output)} AND work_kind = 'asset' AND work_ref = ${String(id)} AND role = ${output.role}
								AND state IN ('MATERIALIZED', 'COMMITTED') AND checksum_sha256 = ${output.checksum}
								AND size_bytes = ${BigInt(output.sizeBytes)} AND mime_type = ${output.mimeType} RETURNING id`);
							if (committed.length !== 1) throw new Error('Relocation is not durably materialized');
						}
					}
				}
				return 'APPLIED';
			}, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 30_000, timeout: 60 * 60_000 });
		},
	};
}
