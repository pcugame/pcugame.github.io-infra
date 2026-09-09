import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createAssetUploadRepository } from '../modules/asset-upload/repository.js';

import type { AssetUploadSessionRecord } from '../modules/asset-upload/ports.js';

const enabled = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';
describe.runIf(enabled)('project material upload PostgreSQL transactions', () => {
	const schema = `material_upload_${randomUUID().replaceAll('-', '')}`;
	let control: PrismaClient;
	let prisma: PrismaClient;
	let actorId: number;
	let exhibitionId: number;
	beforeAll(async () => {
		const url = new URL(process.env['DATABASE_URL']!);
		control = createPrismaClientForDatabase(url.toString());
		await control.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
		const root = new URL('../../prisma/migrations/', import.meta.url);
		for (const migration of (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map(({ name }) => name).sort()) {
			const connection = createPrismaClientForDatabase(url.toString());
			try {
				if (migration === '20260822000000_canonical_asset_contract') {
					await connection.$executeRawUnsafe(`SET search_path TO "${schema}";
						BEGIN;
						INSERT INTO storage_buckets (bucket, visibility) VALUES ('protected', 'PROTECTED');
						INSERT INTO users(id,google_sub,email,name,picture,role,created_at,updated_at) VALUES(900000,'material-before-contract','material-before@example.test','owner','','ADMIN',now(),now());
						INSERT INTO exhibitions(id,year,title,created_at,updated_at) VALUES(900000,2098,'Material phase1',now(),now());
						INSERT INTO projects(id,exhibition_id,creator_id,slug,title,status,created_at,updated_at) VALUES(900000,900000,900000,'material-before-contract','Material','PUBLISHED',now(),now());
						INSERT INTO assets(id,project_id,kind,status,original_name,created_at,updated_at) VALUES(900000,900000,'DOCUMENT','READY','manual.txt',now(),now());
						INSERT INTO asset_representations(id,asset_id,role,bucket,object_key,mime_type,size_bytes,state,created_at,updated_at) VALUES('material-before-contract',900000,'ORIGINAL','protected','protected/material-before-contract.txt','text/plain',10,'READY',now(),now());
						INSERT INTO migration_metrics(name,scope,value,last_observed_at,created_at,updated_at)
						SELECT name,'test',0,now()-interval '25 hours',now(),now() FROM (VALUES
						('asset_download_legacy_fallback'),('asset_download_legacy_route'),('public_image_legacy_bridge'),('public_image_legacy_fallback'),('public_webgl_legacy_bridge'),('public_webgl_legacy_fallback'),('export_legacy_fallback')) metrics(name);
						COMMIT;
					`);
				}
				await connection.$executeRawUnsafe(`SET search_path TO "${schema}";\n${await readFile(new URL(`${migration}/migration.sql`, root), 'utf8')}`);
			} finally { await connection.$disconnect(); }
		}
		url.searchParams.set('schema', schema);
		url.searchParams.set('options', `-c search_path=${schema}`);
		prisma = createPrismaClientForDatabase(url.toString());
		expect(await prisma.asset.findUnique({ where: { id: 900000 }, include: { representations: true } })).toMatchObject({ kind: 'DOCUMENT', status: 'READY', representations: [{ role: 'ORIGINAL', mimeType: 'text/plain' }] });
		actorId = (await prisma.user.create({ data: { googleSub: schema, email: `${schema}@example.test`, name: 'Video test', role: 'ADMIN' } })).id;
		exhibitionId = (await prisma.exhibition.create({ data: { year: 2099, title: schema } })).id;
	}, 60_000);
	afterAll(async () => {
		await prisma?.$disconnect();
		if (control) {
			await control.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
			await control.$disconnect();
		}
	});

	async function project() {
		return prisma.project.create({ data: { exhibitionId, creatorId: actorId, slug: randomUUID(), title: 'Video test', status: 'PUBLISHED' } });
	}
	async function allocate(projectId: number, item?: { id: string; clientToken: string }) {
		const id = randomUUID();
		return createAssetUploadRepository(prisma).createAllocating({
			id, projectId, exhibitionId: null, userId: actorId, kind: 'DOCUMENT', originalName: 'manual.txt', declaredMimeType: 'text/plain', totalBytes: 10n,
			partSizeBytes: 10, totalParts: 1, bucket: 'protected', objectKey: `protected/uploads/${id}/source`, generation: 1,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64), sourceIdentityBlockSizeBytes: 1_048_576,
			sourceIdentityBlockManifest: 'e30=', expiresAt: new Date(Date.now() + 60_000), submissionItemId: item?.id ?? null,
			...(item ? { submissionClientToken: item.clientToken } : {}),
		});
	}
	async function commit(sessionId: string) {
		const session = await prisma.assetUploadSession.update({ where: { id: sessionId }, data: { state: 'VERIFYING', validationLeaseToken: 'lease', validationLeaseUntil: new Date(Date.now() + 60_000) } });
		return createAssetUploadRepository(prisma).commitGameReady({ session: session as AssetUploadSessionRecord, token: 'lease', mimeType: 'text/plain', checksum: 'a'.repeat(64) });
	}


	it('serializes racing fifth allocations and refuses a sixth reservation or READY material', async () => {
		const p = await project();
		for (let index = 0; index < 4; index++) await commit((await allocate(p.id)).id);
		const results = await Promise.allSettled([allocate(p.id), allocate(p.id)]);
		expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
		expect(results.find((r) => r.status === 'rejected')?.reason).toMatchObject({ statusCode: 409 });
		await commit(results.find((r) => r.status === 'fulfilled')!.value.id);
		expect(await prisma.asset.count({ where: { projectId: p.id, kind: 'DOCUMENT', status: 'READY' } })).toBe(5);
		await expect(allocate(p.id)).rejects.toMatchObject({ statusCode: 409 });
	});
	it('rejects loss of original, public storage, and relocation to a different asset after contract', async () => {
		const p = await project(); const result = await commit((await allocate(p.id)).id);
		await expect(prisma.assetRepresentation.delete({ where: { id: result.representationId } })).rejects.toThrow();
		await prisma.storageBucket.create({ data: { bucket: 'public', visibility: 'PUBLIC' } });
		await expect(prisma.assetRepresentation.update({ where: { id: result.representationId }, data: { bucket: 'public' } })).rejects.toThrow();
		const pending = await prisma.asset.create({ data: { projectId: p.id, kind: 'ATTACHMENT', originalName: 'pending', status: 'PENDING' } });
		await expect(prisma.assetRepresentation.update({ where: { id: result.representationId }, data: { assetId: pending.id } })).rejects.toThrow();
	});
	it('releases reservations on cancellation and fences cancelled validation', async () => {
		const p = await project(); const allocated = await allocate(p.id);
		await prisma.assetUploadSession.update({ where: { id: allocated.id }, data: { state: 'CANCELLED' } });
		await expect(createAssetUploadRepository(prisma).commitGameReady({ session: allocated, token: 'old', mimeType: 'text/plain' })).rejects.toThrow('lease');
		expect(await prisma.asset.count({ where: { projectId: p.id } })).toBe(0);
		for (let index = 0; index < 5; index++) await allocate(p.id);
	});
});
