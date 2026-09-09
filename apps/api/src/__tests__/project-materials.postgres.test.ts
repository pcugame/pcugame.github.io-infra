import { createProjectCrudRepository } from '../modules/admin/project/crud.repository.js';
import { createExhibitionRepository } from '../modules/admin/year/repository.js';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createPublicRepository } from '../modules/public/repository.js';
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
		for (const migration of (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name < '20260822000000_canonical_asset_contract').map(({ name }) => name).sort()) {
			const connection = createPrismaClientForDatabase(url.toString());
			try {
				await connection.$executeRawUnsafe(`SET search_path TO "${schema}";\n${await readFile(new URL(`${migration}/migration.sql`, root), 'utf8')}`);
			} finally { await connection.$disconnect(); }
		}
		url.searchParams.set('schema', schema);
		url.searchParams.set('options', `-c search_path=${schema}`);
		prisma = createPrismaClientForDatabase(url.toString());
		await prisma.storageBucket.createMany({ data: [
			{ bucket: 'protected', visibility: 'PROTECTED' }, { bucket: 'public', visibility: 'PUBLIC' },
		] });
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
	async function allocate(projectId: number) {
		const id = randomUUID();
		return createAssetUploadRepository(prisma).createAllocating({
			id, projectId, exhibitionId: null, userId: actorId, kind: 'DOCUMENT', originalName: 'manual.txt', declaredMimeType: 'text/plain', totalBytes: 10n,
			partSizeBytes: 10, totalParts: 1, bucket: 'protected', objectKey: `protected/uploads/${id}/source`, generation: 1,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64), sourceIdentityBlockSizeBytes: 1_048_576,
			sourceIdentityBlockManifest: 'e30=', expiresAt: new Date(Date.now() + 60_000),
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
	it('rejects loss of original, public storage, and relocation to a different asset under Phase 1 additive constraints', async () => {
		const p = await project(); const result = await commit((await allocate(p.id)).id);
		await expect(prisma.assetRepresentation.delete({ where: { id: result.representationId } })).rejects.toThrow();
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

	it('preserves only hash-verified committed public originals after video correction', async () => {
		const p = await project(); const result = await commit((await allocate(p.id)).id);
		await prisma.asset.update({ where: { id: result.assetId }, data: { kind: 'VIDEO' } });
		const original = await prisma.assetRepresentation.update({
			where: { id: result.representationId }, data: { mimeType: 'video/mp4' },
		});
		const ledger = await prisma.canonicalObjectRelocation.create({ data: {
			id: randomUUID(), workKind: 'asset', workRef: String(result.assetId), role: 'ORIGINAL',
			sourceBucket: 'public', sourceObjectKey: 'legacy/video-as-image.mp4', destinationBucket: original.bucket, destinationObjectKey: original.objectKey,
			sizeBytes: original.sizeBytes, mimeType: 'video/mp4', checksumSha256: 'a'.repeat(64), state: 'COMMITTED', materializedAt: new Date(), committedAt: new Date(),
		} });
		const repository = createPublicRepository(prisma);
		await expect(repository.resolvePublicImageBridge('legacy/video-as-image.mp4')).resolves.toMatchObject({ bucket: 'public', objectKey: 'legacy/video-as-image.mp4' });
		await expect(repository.resolvePublicImageBridge('legacy/other.mp4')).resolves.toBeNull();
		await prisma.canonicalObjectRelocation.update({ where: { id: ledger.id }, data: { checksumSha256: 'b'.repeat(64) } });
		await expect(repository.resolvePublicImageBridge('legacy/video-as-image.mp4')).resolves.toBeNull();
	});

	it.each(['single', 'bulk'] as const)('queues active material source and multipart cleanup before %s project deletion', async (mode) => {
		const p = await project(); const uploading = await allocate(p.id); const verifying = await allocate(p.id);
		await prisma.assetUploadSession.update({ where: { id: uploading.id }, data: { state: 'UPLOADING', uploadId: 'material-multipart' } });
		await prisma.assetUploadSession.update({ where: { id: verifying.id }, data: { state: 'VERIFYING' } });
		const repository = createProjectCrudRepository(prisma, { publicBucket: 'public', protectedBucket: 'protected' });
		const outbox = { publicBucket: 'public', protectedBucket: 'protected', reason: 'test-material-delete' };
		if (mode === 'single') await repository.deleteProjectReturningAssets(p.id, outbox);
		else await repository.bulkDeleteProjectsReturningAssets([p.id], outbox);
		expect(await prisma.assetUploadSession.count({ where: { projectId: p.id } })).toBe(0);
		expect(await prisma.multipartAbortTask.findFirst({ where: { storageKey: uploading.objectKey } })).toMatchObject({ bucket: 'protected', uploadId: 'material-multipart' });
		expect(await prisma.orphanObject.findMany({ where: { storageKey: { in: [uploading.objectKey, verifying.objectKey] } } })).toHaveLength(2);
	});
	it('deletes an exhibition with active and terminal material sessions while preserving cleanup work', async () => {
		const exhibition = await prisma.exhibition.create({ data: { year: 2097, title: 'Material owner deletion' } });
		const p = await prisma.project.create({ data: { exhibitionId: exhibition.id, creatorId: actorId, slug: randomUUID(), title: 'Material owner', status: 'PUBLISHED' } });
		const uploading = await allocate(p.id); const terminal = await allocate(p.id);
		await prisma.assetUploadSession.update({ where: { id: uploading.id }, data: { state: 'UPLOADING', uploadId: 'exhibition-material' } });
		await prisma.assetUploadSession.update({ where: { id: terminal.id }, data: { state: 'CANCELLED' } });
		await createExhibitionRepository(prisma).deleteExhibition(exhibition.id, { publicBucket: 'public', protectedBucket: 'protected', reason: 'test-exhibition-delete' });
		expect(await prisma.exhibition.findUnique({ where: { id: exhibition.id } })).toBeNull();
		expect(await prisma.multipartAbortTask.findFirst({ where: { storageKey: uploading.objectKey } })).toMatchObject({ bucket: 'protected', uploadId: 'exhibition-material' });
		expect(await prisma.orphanObject.findFirst({ where: { storageKey: uploading.objectKey } })).toMatchObject({ bucket: 'protected' });
	});
});
