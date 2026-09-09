import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPrismaClientForDatabase } from '../../lib/prisma-client.js';
import type { AssetUploadKind, PrismaClient } from '../../generated/prisma/client.js';
import { createProjectChangeRepository } from './repository.js';
import { deleteProjectInTransaction } from './transaction.js';
import { createProjectPublicationRepository } from '../project-publication/repository.js';
import { createProjectPublicationWorker } from '../project-publication/worker.js';
import type { ProjectPublicationStorage } from '../project-publication/ports.js';
import { createObjectReferenceResolver } from '../orphan/reference-resolver.js';

describe.runIf(process.env['RUN_POSTGRES_INTEGRATION'] === 'true')('review: staged asset transfer and publication deletion races', () => {
	let db: PrismaClient;
	let owner: { id: number; role: 'USER' };
	let operator: { id: number; role: 'OPERATOR' };
	let exhibitionId: number;
	let protectedBucket: string;
	let publicBucket: string;
	const bytes = Buffer.from('review fixture');
	const checksum = createHash('sha256').update(bytes).digest('hex');

	beforeAll(async () => {
		db = createPrismaClientForDatabase(process.env['DATABASE_URL']!);
		protectedBucket = (await db.storageBucket.findUniqueOrThrow({ where: { visibility: 'PROTECTED' } })).bucket;
		publicBucket = (await db.storageBucket.findUniqueOrThrow({ where: { visibility: 'PUBLIC' } })).bucket;
		const user = await db.user.create({ data: { googleSub: randomUUID(), email: `${randomUUID()}@example.test` } });
		const op = await db.user.create({ data: { googleSub: randomUUID(), email: `${randomUUID()}@example.test`, role: 'OPERATOR' } });
		owner = { id: user.id, role: 'USER' };
		operator = { id: op.id, role: 'OPERATOR' };
		exhibitionId = (await db.exhibition.create({ data: { year: 2096, title: randomUUID(), isModificationEnabled: false } })).id;
	});
	afterAll(async () => {
		if (!db) return;
		for (const project of await db.project.findMany({ where: { exhibitionId }, select: { id: true } })) {
			if (await db.project.findUnique({ where: { id: project.id } })) await db.$transaction(tx => deleteProjectInTransaction(tx, project.id));
		}
		await db.projectChangeRequest.deleteMany({ where: { actorId: owner.id } });
		await db.exhibition.delete({ where: { id: exhibitionId } });
		await db.user.deleteMany({ where: { id: { in: [owner.id, operator.id] } } });
		await db.$disconnect();
	});

	async function staged(kinds: AssetUploadKind[]) {
		const repository = createProjectChangeRepository(db);
		const source = await db.project.create({ data: { exhibitionId, creatorId: owner.id, slug: randomUUID(), title: 'Original', status: 'PUBLISHED' } });
		const request = await repository.create(owner, source.id, { kind: 'EDIT', reason: 'Review fixture' });
		const stage = await repository.update(owner, request.id, { manifest: kinds.map(kind => ({ kind, slot: ['VIDEO', 'IMAGE', 'DOCUMENT', 'ATTACHMENT'].includes(kind) ? `${kind.toLowerCase()}:0` : kind.toLowerCase(), clientToken: randomUUID() })) });
		const assets = [];
		for (const item of stage.items) {
			const image = item.kind === 'POSTER' || item.kind === 'IMAGE';
			const roles = image ? ['ORIGINAL', 'CARD_480', 'DISPLAY_960'] as const : item.kind === 'WEBGL' ? ['WEBGL_SOURCE'] as const : ['ORIGINAL'] as const;
			const asset = await db.asset.create({ data: {
				projectId: stage.stagingProjectId!, kind: item.kind, status: 'READY', originalName: `${item.kind}.bin`,
				representations: { create: roles.map(role => ({ role, state: 'READY', bucket: protectedBucket,
					objectKey: image ? `protected/publication-staging/projects/${stage.stagingProjectId}/images/${randomUUID()}/${role.toLowerCase()}.webp` : `review/private/${randomUUID()}`, mimeType: image ? 'image/webp' : 'application/octet-stream', sizeBytes: BigInt(bytes.length),
					checksumAlgorithm: 'SHA256', checksum, sourceIdentityAlgorithm: 'SHA256', sourceIdentity: checksum,
					...(image ? { publicationBucket: publicBucket, publicationObjectKey: `public/images/${randomUUID()}.webp` } : {}),
				})) },
			}, include: { representations: true } });
			const representation = asset.representations.find(rep => rep.role === roles[0])!;
			let deploymentId: string | undefined;
			if (item.kind === 'WEBGL') {
				const stagingPrefix = `review/webgl-private/${randomUUID()}/`;
				const publicPrefix = `review/webgl-public/${randomUUID()}/`;
				deploymentId = (await db.webglDeployment.create({ data: { projectId: stage.stagingProjectId!, sourceRepresentationId: representation.id, state: 'READY', publicBucket, publicPrefix, entryObjectKey: `${publicPrefix}index.html`, stagingBucket: protectedBucket, stagingPrefix, stagingEntryObjectKey: `${stagingPrefix}index.html`, stagingObjectManifest: { version: 1, objects: [{ objectKey: `${stagingPrefix}index.html`, sizeBytes: String(bytes.length), mimeType: 'text/html', contentEncoding: null, etag: null, checksumSha256: checksum }] } } })).id;
			}
			if (item.kind === 'VIDEO') await db.assetRepresentation.create({ data: { assetId: asset.id, role: 'PLAYBACK', state: 'READY', bucket: protectedBucket, objectKey: `review/playback/${randomUUID()}`, mimeType: 'video/mp4', sizeBytes: BigInt(bytes.length) } });
			await db.assetUploadSession.create({ data: { projectId: stage.stagingProjectId!, userId: owner.id, kind: item.kind, state: 'READY', originalName: asset.originalName, totalBytes: BigInt(bytes.length), partSizeBytes: bytes.length, totalParts: 1, bucket: protectedBucket, objectKey: representation.objectKey, sourceIdentityAlgorithm: 'SHA256', sourceIdentity: checksum, sourceIdentityBlockSizeBytes: bytes.length, sourceIdentityBlockManifest: [], expiresAt: new Date(Date.now() + 3600000), resultAssetId: asset.id, resultRepresentationId: representation.id, submissionItemId: item.id, ...(deploymentId ? { reservedWebglDeploymentId: deploymentId } : {}) } });
			await db.projectSubmissionItem.update({ where: { id: item.id }, data: { state: 'READY', boundGeneration: 1, resultAssetId: asset.id, resultRepresentationId: representation.id, ...(deploymentId ? { resultWebglDeploymentId: deploymentId } : {}), ...(item.kind === 'VIDEO' ? { playbackState: 'READY' } : {}) } });
			assets.push(asset);
		}
		return { repository, source, request, stage, assets };
	}

	it('commits POSTER, IMAGE, WEBGL, VIDEO, DOCUMENT and ATTACHMENT atomically; later stage cleanup preserves transferred assets', async () => {
		const fixture = await staged(['POSTER', 'IMAGE', 'WEBGL', 'VIDEO', 'DOCUMENT', 'ATTACHMENT']);
		await fixture.repository.transition(owner, fixture.request.id, 'submit');
		await fixture.repository.transition(operator, fixture.request.id, 'approve');
		const publication = createProjectPublicationRepository(db);
		const token = randomUUID();
		const job = await publication.claim({ token, leaseMs: 60000 });
		expect(job?.projectId).toBe(fixture.stage.stagingProjectId);
		const validated = await publication.validatePlan(job!, token);
		expect(validated.status).toBe('VALID');
		if (validated.status !== 'VALID') throw new Error('Invalid fixture');
		expect(validated.job.plan.objects).toHaveLength(7);
		await publication.complete(validated.job, token);
		await publication.queueCancelledCleanup(job!.id, validated.job.plan);
		for (const object of validated.job.plan.objects) expect(await db.orphanObject.findUnique({ where: { orphan_bucket_storage_key: { bucket: object.targetBucket, storageKey: object.targetObjectKey } } })).toBeNull();
		const updated = await db.project.findUniqueOrThrow({ where: { id: fixture.source.id }, include: { assets: { include: { representations: true } }, currentWebglDeployment: true } });
		expect(updated.assets).toHaveLength(6);
		expect(updated.posterAssetId).toBe(fixture.assets.find(asset => asset.kind === 'POSTER')?.id);
		expect(updated.currentWebglDeployment).toMatchObject({ projectId: updated.id, stagingBucket: null, state: 'READY' });
		expect(updated.assets.find(asset => asset.kind === 'VIDEO')?.videoSortOrder).toBe(0);
		for (const asset of updated.assets.filter(asset => ['IMAGE', 'POSTER'].includes(asset.kind))) expect(asset.representations.every(rep => rep.bucket === publicBucket && rep.publicationBucket === null)).toBe(true);
		await db.$transaction(tx => deleteProjectInTransaction(tx, fixture.stage.stagingProjectId!));
		await publication.queueCancelledCleanup(job!.id, validated.job.plan);
		expect(await db.asset.count({ where: { projectId: fixture.source.id } })).toBe(6);
		expect((await fixture.repository.detail(owner, fixture.request.id)).stagedAssets).toHaveLength(6);
		const references = createObjectReferenceResolver(db, { publicBucket, protectedBucket }, { error: vi.fn() });
		for (const object of validated.job.plan.objects) expect(await references.isReferenced({ bucket: object.targetBucket, key: object.targetObjectKey, targetKind: 'EXACT' })).toBe(true);
	});

	it('rechecks the year at the final initial-submission commit and permits commit once reopened', async () => {
		await db.exhibition.update({ where: { id: exhibitionId }, data: { isModificationEnabled: true } });
		const project = await db.project.create({ data: { exhibitionId, creatorId: owner.id, title: 'Initial submission', slug: randomUUID(), status: 'DRAFT', submission: { create: { actorId: owner.id, state: 'FINALIZING' } } }, include: { submission: true } });
		const submissionId = project.submission!.id;
		await db.projectPublicationJob.create({ data: { projectId: project.id, submissionId, plan: { version: 1, projectId: project.id, submissionId, objects: [], representations: [], webglDeployments: [] } } });
		const publication = createProjectPublicationRepository(db);
		const token = randomUUID();
		const job = await publication.claim({ token, leaseMs: 60000 });
		expect(job?.projectId).toBe(project.id);
		const validated = await publication.validatePlan(job!, token);
		if (validated.status !== 'VALID') throw new Error('Invalid initial fixture');
		await db.exhibition.update({ where: { id: exhibitionId }, data: { isModificationEnabled: false } });
		await expect(publication.complete(validated.job, token)).rejects.toMatchObject({ statusCode: 403 });
		expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('DRAFT');
		await db.exhibition.update({ where: { id: exhibitionId }, data: { isModificationEnabled: true } });
		await expect(publication.complete(validated.job, token)).resolves.toBe('COMPLETED');
		expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).version).toBe(project.version + 1);
		await db.exhibition.update({ where: { id: exhibitionId }, data: { isModificationEnabled: false } });
	});

	it('requeues immutable targets when a late PUT finishes after source deletion cascades the publication job', async () => {
		const fixture = await staged(['POSTER']);
		await fixture.repository.transition(owner, fixture.request.id, 'submit');
		await fixture.repository.transition(operator, fixture.request.id, 'approve');
		const repository = createProjectPublicationRepository(db);
		const objects = new Map<string, Buffer>();
		for (const asset of fixture.assets) for (const representation of asset.representations) objects.set(`${representation.bucket}\0${representation.objectKey}`, bytes);
		let lateKey = '';
		let deleted = false;
		const storage: ProjectPublicationStorage = {
			async head(bucket, key) { const value = objects.get(`${bucket}\0${key}`); return value ? { size: value.length, checksumSha256: checksum } : null; },
			async stream(bucket, key) { return { body: Readable.from(objects.get(`${bucket}\0${key}`)!), size: bytes.length }; },
			async upload(input) {
				if (!deleted) {
					deleted = true;
					await db.$transaction(tx => deleteProjectInTransaction(tx, fixture.source.id));
					// Simulate the deletion worker consuming the initial outbox before
					// the already-started object-store upload has completed.
					await db.orphanObject.deleteMany({ where: { bucket: input.bucket, storageKey: input.key } });
					lateKey = input.key;
				}
				objects.set(`${input.bucket}\0${input.key}`, bytes);
			},
			async delete(bucket, key) { objects.delete(`${bucket}\0${key}`); },
		};
		const worker = createProjectPublicationWorker({ repository, storage, ids: { next: randomUUID }, logger: { warn: vi.fn(), error: vi.fn() }, heartbeatMs: 60000 });
		await worker.runPass();
		expect(objects.has(`${publicBucket}\0${lateKey}`)).toBe(true);
		expect(await db.orphanObject.findUnique({ where: { orphan_bucket_storage_key: { bucket: publicBucket, storageKey: lateKey } } })).not.toBeNull();
		expect(await db.projectPublicationJob.findUnique({ where: { projectId: fixture.stage.stagingProjectId! } })).toBeNull();
	});
});
