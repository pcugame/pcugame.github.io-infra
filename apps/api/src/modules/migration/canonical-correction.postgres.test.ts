import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClientForDatabase } from '../../lib/prisma-client.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { createCanonicalCorrectionRepository } from './canonical-correction.prisma.js';
import { applyCorrection, correctionManifestHash } from './canonical-correction.js';
import type { CorrectionItem, CorrectionManifest, CorrectionOutput } from './canonical-correction.types.js';
import { createOrphanRepository } from '../orphan/repository.js';
import { collectObjectReferences, createObjectReferenceIndex, OBJECT_REFERENCE_CLAIM_LOCK_ID } from '../orphan/reference-resolver.js';

describe.runIf(process.env['RUN_POSTGRES_INTEGRATION'] === 'true')('atomic Phase 1 correction PostgreSQL', () => {
	let db: PrismaClient;
	let control: PrismaClient;
	let schema: string;
	let projectId: number;
	const digest = 'a'.repeat(64);
	beforeAll(async () => {
		const databaseUrl = process.env['DATABASE_URL']!;
		control = createPrismaClientForDatabase(databaseUrl);
		schema = `correction_${randomUUID().replaceAll('-', '')}`;
		await control.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
		const migrationRoot = new URL('../../../prisma/migrations/', import.meta.url);
		for (const directory of (await readdir(migrationRoot)).filter((name) => name < '20260822000000' && name !== 'migration_lock.toml').sort()) {
			const connection = createPrismaClientForDatabase(databaseUrl);
			try { await connection.$executeRawUnsafe(`SET search_path TO "${schema}";\n${await readFile(new URL(`${directory}/migration.sql`, migrationRoot), 'utf8')}`); }
			finally { await connection.$disconnect(); }
		}
		const url = new URL(databaseUrl); url.searchParams.set('schema', schema); url.searchParams.set('options', `-c search_path=${schema}`);
		db = createPrismaClientForDatabase(url.toString());
		await db.$executeRawUnsafe(`INSERT INTO storage_buckets(bucket, visibility, updated_at) VALUES ('protected', 'PROTECTED', now()), ('public', 'PUBLIC', now())`);
		await db.$executeRawUnsafe(`INSERT INTO users(google_sub, updated_at) VALUES ('correction-test', now())`);
		await db.$executeRawUnsafe(`INSERT INTO exhibitions(year, title, updated_at) VALUES (2099, 'correction', now())`);
		const projects = await db.$queryRawUnsafe<Array<{ id: number }>>(`INSERT INTO projects(exhibition_id, creator_id, slug, title, status, updated_at)
			VALUES ((SELECT id FROM exhibitions LIMIT 1), (SELECT id FROM users LIMIT 1), 'correction', 'Correction', 'PUBLISHED', now()) RETURNING id`);
		projectId = projects[0]!.id;
	}, 120_000);
	afterAll(async () => { await db?.$disconnect(); if (control) { await control.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await control.$disconnect(); } });
	async function fixture(count = 1): Promise<CorrectionManifest> {
		const repo = createCanonicalCorrectionRepository(db);
		const items: CorrectionItem[] = [];
		for (let index = 0; index < count; index++) {
			const id = await repo.reserveAssetId();
			const original: CorrectionOutput = { role: 'ORIGINAL', bucket: 'protected', objectKey: `protected/assets/${id}/original/test.txt`,
				mimeType: 'text/plain', sizeBytes: '5', checksumAlgorithm: 'SHA256', checksum: digest, etag: null,
				sourceIdentityAlgorithm: 'MIGRATION_COPY_SHA256', sourceIdentity: digest, width: null, height: null,
				provenance: { operation: 'COPY', sourceSha256: digest } };
			const item: CorrectionItem = { assetId: null, reservedAssetId: id, projectId, targetKind: 'DOCUMENT', videoSortOrder: null,
				originalName: 'manual.txt', source: { bucket: 'public', key: `source-${id}.txt`, mimeType: 'text/plain', sizeBytes: '5', sha256: digest, etag: null },
				ownershipEvidence: { description: 'Exact original proof', artifact: 'proof.json', sha256: digest }, outputs: [original] };
			await repo.protect(item, original); await repo.materialized(item, original); items.push(item);
		}
		return { version: 1, id: randomUUID(), createdAt: new Date().toISOString(), preparedAt: new Date().toISOString(),
			phase: 'PREPARED', protectedBucket: 'protected', publicBucket: 'public', items,
			snapshots: await repo.snapshot([projectId], items.map((i) => i.source.key)) };
	}
	async function apply(manifest: CorrectionManifest) {
		return applyCorrection({ manifest, expectedHash: correctionManifestHash(manifest), repository: createCanonicalCorrectionRepository(db),
			objects: { verify: async () => undefined, prepare: async () => [] } });
	}
	it('rolls every asset back when a later relocation is incomplete, then commits once and reruns idempotently', async () => {
		const manifest = await fixture(2);
		const last = manifest.items[1]!;
		await db.$executeRawUnsafe(`UPDATE canonical_object_relocations SET state = 'PREPARED', materialized_at = NULL WHERE work_ref = '${last.reservedAssetId}'`);
		await expect(apply(manifest)).rejects.toThrow('not durably materialized');
		const rows = await db.$queryRawUnsafe<Array<{ count: bigint }>>('SELECT count(*) FROM assets');
		expect(Number(rows[0]?.count)).toBe(0);
		await createCanonicalCorrectionRepository(db).materialized(last, last.outputs[0]!);
		await expect(apply(manifest)).resolves.toBe('APPLIED');
		for (const item of manifest.items) await createCanonicalCorrectionRepository(db).protect(item, item.outputs[0]!);
		await expect(apply(manifest)).resolves.toBe('ALREADY_APPLIED');
		const committed = await db.$queryRawUnsafe<Array<{ count: bigint }>>("SELECT count(*) FROM canonical_object_relocations WHERE state = 'COMMITTED'");
		expect(Number(committed[0]?.count)).toBe(2);
		const cleanup = await db.$queryRawUnsafe<Array<{ count: bigint }>>("SELECT count(*) FROM orphan_objects WHERE state <> 'CANCELLED'");
		expect(Number(cleanup[0]?.count)).toBe(0);
		const pendingIntents = await db.$queryRawUnsafe<Array<{ count: bigint }>>("SELECT count(*) FROM upload_intents WHERE state <> 'COMMITTED'");
		expect(Number(pendingIntents[0]?.count)).toBe(0);
	});
	it('rejects changed owner/order state and active exact or prefix deletion claims without asset changes', async () => {
		const stale = await fixture();
		await db.$executeRawUnsafe("UPDATE projects SET title = 'Changed' WHERE slug = 'correction'");
		await expect(apply(stale)).rejects.toThrow('changed concurrently');
		const blocked = await fixture();
		const destination = blocked.items[0]!.outputs[0]!;
		await db.$executeRawUnsafe(`UPDATE orphan_objects SET state = 'DELETE_CLAIMED', claim_token = 'active', claim_until = now() + interval '1 hour' WHERE storage_key = '${destination.objectKey}'`);
		await expect(apply(blocked)).rejects.toThrow('active deletion claim');
		await db.$executeRawUnsafe(`UPDATE orphan_objects SET state = 'PENDING', claim_token = NULL, claim_until = NULL WHERE storage_key = '${destination.objectKey}'`);
		await db.$executeRawUnsafe(`INSERT INTO orphan_objects(bucket, storage_key, target_kind, state, claim_token, claim_until)
			VALUES ('protected', 'protected/assets/', 'PREFIX', 'DELETE_CLAIMED', 'prefix', now() + interval '1 hour')`);
		await expect(apply(blocked)).rejects.toThrow('active deletion claim');
		await db.$executeRawUnsafe("UPDATE orphan_objects SET state = 'CANCELLED', claim_token = NULL, claim_until = NULL");
	});
	it('serializes source/prefix protection with a concurrent reaper and retains new overlapping-prefix references', async () => {
		const manifest = await fixture();
		const item = manifest.items[0]!;
		await db.$executeRawUnsafe(`INSERT INTO orphan_objects(bucket, storage_key, target_kind, state, next_attempt_at)
			VALUES ('public', '${item.source.key}', 'EXACT', 'PENDING', now()), ('protected', 'protected/', 'PREFIX', 'PENDING', now())`);
		let release!: () => void; let locked!: () => void;
		const ready = new Promise<void>((resolve) => { locked = resolve; });
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const blocker = db.$transaction(async (tx) => {
			await tx.$queryRawUnsafe("SELECT id FROM orphan_objects WHERE bucket = 'protected' AND storage_key = 'protected/' FOR UPDATE");
			locked(); await gate;
		}, { timeout: 10_000 });
		await ready;
		const protecting = createCanonicalCorrectionRepository(db).protect(item, item.outputs[0]!);
		try {
			let acquired = false;
			for (let attempt = 0; attempt < 100 && !acquired; attempt++) {
				const locks = await db.$queryRawUnsafe<Array<{ held: boolean }>>(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted
					AND classid = ${(OBJECT_REFERENCE_CLAIM_LOCK_ID >> 32n).toString()} AND objid = ${(OBJECT_REFERENCE_CLAIM_LOCK_ID & 0xffffffffn).toString()}) AS held`);
				acquired = locks[0]?.held ?? false;
				if (!acquired) await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(acquired).toBe(true);
			const claiming = createOrphanRepository(db).claimPendingOrphans(100, new Date(), 'racing-reaper', 30_000);
			release(); await blocker; await protecting;
			const claimed = await claiming;
			expect(claimed.some((row) => row.storageKey === item.source.key || row.storageKey === 'protected/' || row.storageKey === item.outputs[0]!.objectKey)).toBe(false);
			const inventory = await collectObjectReferences(db, { publicBucket: 'public', protectedBucket: 'protected' }, { error() {} });
			const index = createObjectReferenceIndex(inventory);
			expect(index.referencesTarget({ bucket: 'public', key: item.source.key, targetKind: 'EXACT' })).toBe(true);
			expect(index.referencesTarget({ bucket: 'protected', key: 'protected/', targetKind: 'PREFIX' })).toBe(true);
		} finally { release(); await blocker; await protecting; }
	});
});
