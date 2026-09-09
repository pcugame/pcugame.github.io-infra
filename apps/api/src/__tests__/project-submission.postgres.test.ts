import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';
import { createProjectCrudRepository } from '../modules/admin/project/crud.repository.js';
import { createAssetUploadRepository } from '../modules/asset-upload/repository.js';
import { createWebglProcessingRepository } from '../modules/asset-upload/webgl-processing-repository.js';
import { createPrismaImageWorkerRepository } from '../modules/image/prisma.repository.js';
import { createProjectPublicationRepository } from '../modules/project-publication/repository.js';
import { createProjectPublicationWorker } from '../modules/project-publication/worker.js';
import { createPublicRepository } from '../modules/public/repository.js';
import { createCanonicalWebglPublicKeys } from '../modules/webgl/paths.js';

const runPostgresIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';

describe.runIf(runPostgresIntegration)('project submission publication aggregate', () => {
	const testId = randomUUID();
	const protectedBucket = 'protected';
	const publicBucket = 'public';
	const stagedObjects = new Map<string, Buffer>();
	let prisma: PrismaClient;
	let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>;
	let actorId: number;
	let exhibitionId: number;
	const projectIds: number[] = [];

	beforeAll(async () => {
		const databaseUrl = process.env['DATABASE_URL'];
		if (!databaseUrl) throw new Error('DATABASE_URL is required');
		database = await createIsolatedMigratedDatabase(databaseUrl);
		prisma = database.createClient();
		await prisma.$connect();
		await prisma.storageBucket.upsert({
			where: { bucket: protectedBucket }, update: {},
			create: { bucket: protectedBucket, visibility: 'PROTECTED' },
		});
		await prisma.storageBucket.upsert({
			where: { bucket: publicBucket }, update: {},
			create: { bucket: publicBucket, visibility: 'PUBLIC' },
		});
		const actor = await prisma.user.create({
			data: {
				googleSub: `project-submission-${testId}`,
				email: `${testId}@example.test`,
				name: 'Submission actor',
				role: 'ADMIN',
			},
		});
		actorId = actor.id;
		const exhibition = await prisma.exhibition.create({
			data: { year: 2098, title: testId, isUploadEnabled: true },
		});
		exhibitionId = exhibition.id;
	}, 60_000);

	afterAll(async () => { await database?.close(); });

	function manifestItem(kind: 'GAME' | 'IMAGE' | 'VIDEO' | 'WEBGL', slot: string, token: string) {
		return { kind, slot, clientToken: token, required: true as const };
	}

	async function createDraft(manifest: Array<ReturnType<typeof manifestItem>>) {
		const repository = createProjectCrudRepository(prisma, { publicBucket, protectedBucket });
		const created = await repository.createProjectWithAssets({
			exhibitionId,
			slug: `${testId}-${projectIds.length}`,
			title: 'Draft publication aggregate',
			status: 'DRAFT',
			creatorId: actorId,
			members: [{ name: 'Submission actor', studentId: '20980001', userId: actorId }],
			manifest,
		});
		projectIds.push(created.id);
		return { repository, created };
	}

	async function bindReadyAsset(input: {
		projectId: number;
		itemId: string;
		clientToken: string;
		kind: 'GAME' | 'IMAGE';
	}) {
		const uploads = createAssetUploadRepository(prisma);
		const sessionId = randomUUID();
		const session = await uploads.createAllocating({
			id: sessionId,
			projectId: input.projectId,
			exhibitionId: null,
			userId: actorId,
			kind: input.kind,
			originalName: input.kind === 'GAME' ? 'game.zip' : 'image.png',
			declaredMimeType: input.kind === 'GAME' ? 'application/zip' : 'image/png',
			totalBytes: 10n,
			partSizeBytes: 10,
			totalParts: 1,
			bucket: protectedBucket,
			objectKey: `protected/uploads/${sessionId}/source`,
			generation: 1,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
			sourceIdentity: 'a'.repeat(64),
			sourceIdentityBlockSizeBytes: 1_048_576,
			sourceIdentityBlockManifest: 'e30=',
			expiresAt: new Date(Date.now() + 60_000),
			submissionItemId: input.itemId,
			submissionClientToken: input.clientToken,
		});
		await uploads.setAllocated(session.id, session.generation, `garage-${session.id}`);
		const roles: Array<'ORIGINAL' | 'CARD_480' | 'DISPLAY_960'> = input.kind === 'IMAGE'
			? ['ORIGINAL', 'CARD_480', 'DISPLAY_960']
			: ['ORIGINAL'];
		const representations = roles.map((role) => {
			const bytes = Buffer.from(`${input.kind}-${role}-${session.id}`);
			const suffix = role.toLowerCase();
			const objectKey = input.kind === 'GAME'
				? session.objectKey
				: `protected/publication-staging/projects/${input.projectId}/images/${session.id}/${suffix}.webp`;
			stagedObjects.set(`${protectedBucket}\0${objectKey}`, bytes);
			return {
				role,
				bucket: protectedBucket,
				objectKey,
				mimeType: input.kind === 'GAME' ? 'application/zip' : 'image/webp',
				sizeBytes: BigInt(bytes.length),
				checksumAlgorithm: 'SHA256',
				checksum: createHash('sha256').update(bytes).digest('hex'),
				sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
				sourceIdentity: session.sourceIdentity,
				state: 'READY' as const,
				...(input.kind === 'IMAGE' ? {
					publicationBucket: publicBucket,
					publicationObjectKey: `public/images/${session.id}/${suffix}/1.webp`,
				} : {}),
			};
		});
		const asset = await prisma.asset.create({
			data: {
				projectId: input.projectId,
				kind: input.kind,
				status: 'READY',
				originalName: session.originalName,
				representations: { create: representations },
			},
			include: { representations: true },
		});
		const original = asset.representations.find(({ role }) => role === 'ORIGINAL')!;
		await prisma.assetUploadSession.update({
			where: { id: session.id },
			data: { state: 'READY', uploadId: null, resultAssetId: asset.id, resultRepresentationId: original.id },
		});
		return session;
	}

	it('keeps one-of-many and rejected submissions non-public', async () => {
		const gameToken = 'g'.repeat(32);
		const imageToken = 'i'.repeat(32);
		const { repository, created } = await createDraft([
			manifestItem('GAME', 'game', gameToken),
			manifestItem('IMAGE', 'image:0', imageToken),
		]);
		const game = created.submission.items.find(({ kind }) => kind === 'GAME')!;
		await bindReadyAsset({ projectId: created.id, itemId: game.id, clientToken: gameToken, kind: 'GAME' });
		const image = created.submission.items.find(({ kind }) => kind === 'IMAGE')!;
		const uploads = createAssetUploadRepository(prisma);
		const rejectedSession = await uploads.createAllocating({
			id: randomUUID(), projectId: created.id, exhibitionId: null, userId: actorId,
			kind: 'IMAGE', originalName: 'broken.png', declaredMimeType: 'image/png',
			totalBytes: 10n, partSizeBytes: 10, totalParts: 1, bucket: protectedBucket,
			objectKey: `protected/uploads/${randomUUID()}/broken.png`, generation: 1,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'f'.repeat(64),
			sourceIdentityBlockSizeBytes: 1_048_576, sourceIdentityBlockManifest: 'e30=',
			expiresAt: new Date(Date.now() + 60_000), submissionItemId: image.id,
			submissionClientToken: imageToken,
		});
		await uploads.setAllocated(rejectedSession.id, rejectedSession.generation, `garage-${rejectedSession.id}`);
		await prisma.assetUploadSession.update({
			where: { id: rejectedSession.id },
			data: { state: 'REJECTED', uploadId: null, validationError: 'image decode failed' },
		});
		await expect(prisma.projectSubmissionItem.findUniqueOrThrow({ where: { id: image.id } }))
			.resolves.toMatchObject({ state: 'FAILED', failureReason: 'image decode failed' });
		await expect(repository.finalizeSubmission(created.id, { id: actorId, role: 'ADMIN' }))
			.rejects.toMatchObject({ statusCode: 409 });
		await expect(createPublicRepository(prisma).findPublishedProjectById(created.id)).resolves.toBeNull();
	});

	it('finalizes through one durable job and atomically publishes verified immutable copies', async () => {
		const gameToken = 'h'.repeat(32);
		const imageToken = 'j'.repeat(32);
		const { repository, created } = await createDraft([
			manifestItem('GAME', 'game', gameToken),
			manifestItem('IMAGE', 'image:0', imageToken),
		]);
		const game = created.submission.items.find(({ kind }) => kind === 'GAME')!;
		const image = created.submission.items.find(({ kind }) => kind === 'IMAGE')!;
		await bindReadyAsset({ projectId: created.id, itemId: game.id, clientToken: gameToken, kind: 'GAME' });
		await bindReadyAsset({ projectId: created.id, itemId: image.id, clientToken: imageToken, kind: 'IMAGE' });

		const [first, second] = await Promise.all([
			repository.finalizeSubmission(created.id, { id: actorId, role: 'ADMIN' }),
			repository.finalizeSubmission(created.id, { id: actorId, role: 'ADMIN' }),
		]);
		expect(first.state).toBe('FINALIZING');
		expect(second.state).toBe('FINALIZING');
		await expect(createPublicRepository(prisma).findPublishedProjectById(created.id)).resolves.toBeNull();
		await expect(prisma.projectPublicationJob.count({ where: { projectId: created.id } })).resolves.toBe(1);

		const publishedObjects = new Map<string, Buffer>();
		let uploadCount = 0;
		const publicationWorker = createProjectPublicationWorker({
			repository: createProjectPublicationRepository(prisma),
			storage: {
				async head(bucket, key) {
					const value = stagedObjects.get(`${bucket}\0${key}`) ?? publishedObjects.get(`${bucket}\0${key}`);
					return value ? { size: value.length, checksumSha256: createHash('sha256').update(value).digest('hex') } : null;
				},
				async stream(bucket, key) {
					const value = stagedObjects.get(`${bucket}\0${key}`);
					if (!value) throw new Error('staged object missing');
					return { body: Readable.from(value), size: value.length };
				},
				async upload(input) {
					const chunks: Buffer[] = [];
					for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
					const value = Buffer.concat(chunks);
					expect(createHash('sha256').update(value).digest('hex')).toBe(input.checksumSha256);
					publishedObjects.set(`${input.bucket}\0${input.key}`, value);
					uploadCount++;
				},
				async delete(bucket, key) { publishedObjects.delete(`${bucket}\0${key}`); },
			},
			ids: { next: randomUUID },
			logger: { error: () => undefined, warn: () => undefined },
			heartbeatMs: 60_000,
		});
		await expect(publicationWorker.runPass()).resolves.toMatchObject({ completed: 1 });
		expect(uploadCount).toBe(3);
		await expect(publicationWorker.runPass()).resolves.toMatchObject({ claimed: 0 });
		await expect(createPublicRepository(prisma).findPublishedProjectById(created.id))
			.resolves.toMatchObject({ id: created.id, status: 'PUBLISHED' });
		await expect(prisma.projectSubmission.findUniqueOrThrow({ where: { projectId: created.id } }))
			.resolves.toMatchObject({ state: 'PUBLISHED' });
		await expect(prisma.projectPublicationJob.findUniqueOrThrow({ where: { projectId: created.id } }))
			.resolves.toMatchObject({ state: 'COMPLETED' });
		const publicRepresentations = await prisma.assetRepresentation.findMany({
			where: { asset: { projectId: created.id, kind: 'IMAGE' } },
		});
		expect(publicRepresentations).toHaveLength(3);
		expect(publicRepresentations.every((representation) => representation.bucket === publicBucket
			&& representation.publicationBucket === null && representation.publicationObjectKey === null)).toBe(true);
	});

	it('fails a tampered persisted copy plan before any storage call and queues its canonical target cleanup', async () => {
		const token = 'p'.repeat(32);
		const { repository, created } = await createDraft([manifestItem('IMAGE', 'image:0', token)]);
		const item = created.submission.items[0]!;
		await bindReadyAsset({ projectId: created.id, itemId: item.id, clientToken: token, kind: 'IMAGE' });
		await repository.finalizeSubmission(created.id, { id: actorId, role: 'ADMIN' });
		const storedJob = await prisma.projectPublicationJob.findUniqueOrThrow({ where: { projectId: created.id } });
		const plan = structuredClone(storedJob.plan) as {
			objects: Array<{ targetObjectKey: string }>;
			representations: Array<{ targetObjectKey: string }>;
		};
		const canonicalTarget = plan.objects[0]!.targetObjectKey;
		const tamperedTarget = `public/images/tampered/${randomUUID()}.webp`;
		plan.objects[0]!.targetObjectKey = tamperedTarget;
		plan.representations[0]!.targetObjectKey = tamperedTarget;
		await prisma.projectPublicationJob.update({ where: { id: storedJob.id }, data: { plan } });

		let storageCalls = 0;
		let publicTargetExists = false;
		const worker = createProjectPublicationWorker({
			repository: createProjectPublicationRepository(prisma),
			storage: {
				async head() { storageCalls++; return null; },
				async stream() { storageCalls++; throw new Error('copy must not start'); },
				async upload() { storageCalls++; publicTargetExists = true; },
				async delete() { storageCalls++; },
			},
			ids: { next: randomUUID }, logger: { error: () => undefined, warn: () => undefined },
			heartbeatMs: 60_000,
		});
		await expect(worker.runPass()).resolves.toMatchObject({ failed: 1 });
		expect(storageCalls).toBe(0);
		expect(publicTargetExists).toBe(false);
		await expect(prisma.projectPublicationJob.findUniqueOrThrow({ where: { id: storedJob.id } }))
			.resolves.toMatchObject({ state: 'FAILED', claimToken: null, claimUntil: null });
		await expect(prisma.orphanObject.count({ where: { bucket: publicBucket, storageKey: canonicalTarget } }))
			.resolves.toBe(1);
		await expect(prisma.orphanObject.count({ where: { bucket: publicBucket, storageKey: tamperedTarget } }))
			.resolves.toBe(0);
		await repository.cancelSubmission(created.id, { id: actorId, role: 'ADMIN' });
	});

	it('recovers a malformed persisted plan through DB-derived cleanup and idempotent cancellation', async () => {
		const token = 'o'.repeat(32);
		const { repository, created } = await createDraft([manifestItem('IMAGE', 'image:0', token)]);
		const item = created.submission.items[0]!;
		await bindReadyAsset({ projectId: created.id, itemId: item.id, clientToken: token, kind: 'IMAGE' });
		await repository.finalizeSubmission(created.id, { id: actorId, role: 'ADMIN' });
		const storedJob = await prisma.projectPublicationJob.findUniqueOrThrow({ where: { projectId: created.id } });
		const canonicalTargets = (storedJob.plan as { objects: Array<{ targetBucket: string; targetObjectKey: string }> }).objects
			.map(({ targetBucket, targetObjectKey }) => ({ bucket: targetBucket, storageKey: targetObjectKey }));
		expect(canonicalTargets).toHaveLength(3);
		await prisma.projectPublicationJob.update({ where: { id: storedJob.id }, data: { plan: {} } });

		let storageCalls = 0;
		const worker = createProjectPublicationWorker({
			repository: createProjectPublicationRepository(prisma),
			storage: {
				async head() { storageCalls++; return null; },
				async stream() { storageCalls++; throw new Error('copy must not start'); },
				async upload() { storageCalls++; },
				async delete() { storageCalls++; },
			},
			ids: { next: randomUUID }, logger: { error: () => undefined, warn: () => undefined },
			heartbeatMs: 60_000,
		});
		await expect(worker.runPass()).resolves.toMatchObject({ failed: 1 });
		expect(storageCalls).toBe(0);
		await expect(prisma.projectPublicationJob.findUniqueOrThrow({ where: { id: storedJob.id } }))
			.resolves.toMatchObject({ state: 'FAILED', lastError: expect.stringContaining('OPERATOR_REQUIRED') });
		await expect(prisma.orphanObject.count({ where: { OR: canonicalTargets } })).resolves.toBe(3);

		await expect(repository.cancelSubmission(created.id, { id: actorId, role: 'ADMIN' }))
			.resolves.toMatchObject({ state: 'CANCELLED', project: { status: 'DRAFT' } });
		await expect(repository.cancelSubmission(created.id, { id: actorId, role: 'ADMIN' }))
			.resolves.toMatchObject({ state: 'CANCELLED', project: { status: 'DRAFT' } });
		await expect(prisma.projectPublicationJob.findUniqueOrThrow({ where: { id: storedJob.id } }))
			.resolves.toMatchObject({ state: 'CANCELLED' });
		await expect(prisma.orphanObject.count({ where: { OR: canonicalTargets } })).resolves.toBe(3);
	});

	it('accepts a valid VIDEO original with terminal FAILED playback for publication', async () => {
		const token = 'v'.repeat(32);
		const { repository, created } = await createDraft([manifestItem('VIDEO', 'video:0', token)]);
		const item = created.submission.items[0]!;
		const uploads = createAssetUploadRepository(prisma);
		const session = await uploads.createAllocating({
			id: randomUUID(), projectId: created.id, exhibitionId: null, userId: actorId,
			kind: 'VIDEO', originalName: 'source.mov', declaredMimeType: 'video/quicktime',
			totalBytes: 10n, partSizeBytes: 10, totalParts: 1, bucket: protectedBucket,
			objectKey: `protected/uploads/${randomUUID()}/source.mov`, generation: 1,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'c'.repeat(64),
			sourceIdentityBlockSizeBytes: 1_048_576, sourceIdentityBlockManifest: 'e30=',
			expiresAt: new Date(Date.now() + 60_000), submissionItemId: item.id,
			submissionClientToken: token,
		});
		await uploads.setAllocated(session.id, 1, `garage-${session.id}`);
		const asset = await prisma.asset.create({
			data: {
				projectId: created.id, kind: 'VIDEO', status: 'READY', originalName: 'source.mov',
					representations: { create: [{
						role: 'ORIGINAL', bucket: protectedBucket, objectKey: session.objectKey,
						mimeType: 'video/quicktime', sizeBytes: 10n, state: 'READY',
						sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
						sourceIdentity: session.sourceIdentity,
				}, {
					role: 'PLAYBACK', bucket: protectedBucket,
					objectKey: `protected/assets/video/${session.id}/playback/1.mp4`,
					mimeType: 'video/mp4', sizeBytes: 0n, state: 'FAILED', error: 'PLAYBACK_FAILED: codec unsupported',
				}] },
			}, include: { representations: true },
		});
		const original = asset.representations.find(({ role }) => role === 'ORIGINAL')!;
		await prisma.assetUploadSession.update({
			where: { id: session.id },
			data: { state: 'READY', uploadId: null, resultAssetId: asset.id, resultRepresentationId: original.id },
		});
		await expect(prisma.projectSubmissionItem.findUniqueOrThrow({ where: { id: item.id } }))
			.resolves.toMatchObject({ state: 'READY', playbackState: 'FAILED', playbackError: 'PLAYBACK_FAILED: codec unsupported' });
		await expect(repository.finalizeSubmission(created.id, { id: actorId, role: 'ADMIN' }))
			.resolves.toMatchObject({ state: 'FINALIZING' });
		const worker = createProjectPublicationWorker({
			repository: createProjectPublicationRepository(prisma),
			storage: {
				head: async () => null,
				stream: async () => { throw new Error('no copies expected'); },
				upload: async () => { throw new Error('no copies expected'); },
				delete: async () => undefined,
			},
			ids: { next: randomUUID }, logger: { error: () => undefined, warn: () => undefined },
			heartbeatMs: 60_000,
		});
		await expect(worker.runPass()).resolves.toMatchObject({ completed: 1 });
		await expect(prisma.project.findUniqueOrThrow({ where: { id: created.id } }))
			.resolves.toMatchObject({ status: 'PUBLISHED' });
	});

	it('keeps DRAFT IMAGE and WebGL outputs in protected publication staging with no public pointer', async () => {
		const imageToken = 'm'.repeat(32);
		const webglToken = 'w'.repeat(32);
		const { repository, created } = await createDraft([
			manifestItem('IMAGE', 'image:0', imageToken),
			manifestItem('WEBGL', 'webgl', webglToken),
		]);
		const uploads = createAssetUploadRepository(prisma);
		const imageItem = created.submission.items.find(({ kind }) => kind === 'IMAGE')!;
		const imageSession = await uploads.createAllocating({
			id: randomUUID(), projectId: created.id, exhibitionId: null, userId: actorId,
			kind: 'IMAGE', originalName: 'draft.png', declaredMimeType: 'image/png',
			totalBytes: 10n, partSizeBytes: 10, totalParts: 1, bucket: protectedBucket,
			objectKey: `protected/uploads/${randomUUID()}/draft.png`, generation: 1,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'd'.repeat(64),
			sourceIdentityBlockSizeBytes: 1_048_576, sourceIdentityBlockManifest: 'e30=',
			expiresAt: new Date(Date.now() + 60_000), submissionItemId: imageItem.id,
			submissionClientToken: imageToken,
		});
		await uploads.setAllocated(imageSession.id, 1, `garage-${imageSession.id}`);
		await prisma.assetUploadSession.update({
			where: { id: imageSession.id }, data: { state: 'VERIFYING', uploadId: null },
		});
		const imageRepository = createPrismaImageWorkerRepository(prisma, { publicBucket, protectedBucket });
		const [claimedImage] = await imageRepository.claimVerifying(['IMAGE'], 1, 'image-claim', 60_000);
		expect(claimedImage?.id).toBe(imageSession.id);
		const imagePlan = await imageRepository.prepareOutputPlan({
			session: claimedImage!, token: 'image-claim', notBefore: new Date(Date.now() + 60_000),
			outputs: [
				{ role: 'ORIGINAL', extension: 'webp', mimeType: 'image/webp', width: 960, height: 540 },
				{ role: 'CARD_480', extension: 'webp', mimeType: 'image/webp', width: 480, height: 270 },
				{ role: 'DISPLAY_960', extension: 'webp', mimeType: 'image/webp', width: 960, height: 540 },
			],
		});
		expect(imagePlan.outputs).toHaveLength(3);
		for (const output of imagePlan.outputs) {
			expect(output.bucket).toBe(protectedBucket);
			expect(output.objectKey).toContain(`/images/${imageItem.id}/`);
			expect(output.publicationBucket).toBe(publicBucket);
			expect(output.publicationObjectKey).toMatch(/^public\/images\//);
		}
		const retriedImagePlan = await imageRepository.prepareOutputPlan({
			session: claimedImage!, token: 'image-claim', notBefore: new Date(Date.now() + 60_000),
			outputs: [
				{ role: 'ORIGINAL', extension: 'webp', mimeType: 'image/webp', width: 960, height: 540 },
				{ role: 'CARD_480', extension: 'webp', mimeType: 'image/webp', width: 480, height: 270 },
				{ role: 'DISPLAY_960', extension: 'webp', mimeType: 'image/webp', width: 960, height: 540 },
			],
		});
		expect(retriedImagePlan.outputs.map(({ objectKey }) => objectKey))
			.toEqual(imagePlan.outputs.map(({ objectKey }) => objectKey));

		const webglItem = created.submission.items.find(({ kind }) => kind === 'WEBGL')!;
		const webglSession = await uploads.createAllocating({
			id: randomUUID(), projectId: created.id, exhibitionId: null, userId: actorId,
			kind: 'WEBGL', originalName: 'webgl.zip', declaredMimeType: 'application/zip',
			totalBytes: 10n, partSizeBytes: 10, totalParts: 1, bucket: protectedBucket,
			objectKey: `protected/uploads/${randomUUID()}/webgl.zip`, generation: 1,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'e'.repeat(64),
			sourceIdentityBlockSizeBytes: 1_048_576, sourceIdentityBlockManifest: 'e30=',
			expiresAt: new Date(Date.now() + 60_000), submissionItemId: webglItem.id,
			submissionClientToken: webglToken,
		});
		await uploads.setAllocated(webglSession.id, 1, `garage-${webglSession.id}`);
		const webglAsset = await prisma.asset.create({
			data: {
				projectId: created.id, kind: 'WEBGL', status: 'PROCESSING', originalName: 'webgl.zip',
				representations: { create: {
					role: 'WEBGL_SOURCE', bucket: protectedBucket, objectKey: webglSession.objectKey,
					mimeType: 'application/zip', sizeBytes: 10n, state: 'VERIFYING',
					sourceIdentityAlgorithm: webglSession.sourceIdentityAlgorithm,
					sourceIdentity: webglSession.sourceIdentity,
				} },
			}, include: { representations: true },
		});
		const source = webglAsset.representations[0]!;
		await prisma.assetUploadSession.update({
			where: { id: webglSession.id },
			data: { state: 'VERIFYING', uploadId: null, resultAssetId: webglAsset.id, resultRepresentationId: source.id },
		});
		const webglRepository = createWebglProcessingRepository(prisma);
		const [claimedWebgl] = await webglRepository.claimVerifyingWebglSessions({
			kind: 'WEBGL', limit: 1, claimToken: 'webgl-claim', leaseUntil: new Date(Date.now() + 60_000),
		});
		expect(claimedWebgl?.id).toBe(webglSession.id);
		const deploymentId = randomUUID();
		const publicKeys = createCanonicalWebglPublicKeys(created.id, deploymentId);
		const reservation = await webglRepository.reserveDeployment({
			sessionId: webglSession.id, generation: 1, claimToken: 'webgl-claim',
			candidateDeploymentId: deploymentId, publicBucket, protectedBucket,
			publicPrefix: publicKeys.publicPrefix, entryObjectKey: publicKeys.entryObjectKey,
			sourceRepresentationId: source.id,
		});
		expect(reservation).toMatchObject({
			publicationStaged: true, outputBucket: protectedBucket,
			publicBucket, publicPrefix: publicKeys.publicPrefix,
		});
		expect(reservation.outputPrefix).toMatch(/^protected\/publication-staging\/projects\//);
		await expect(prisma.project.findUniqueOrThrow({ where: { id: created.id } }))
			.resolves.toMatchObject({ status: 'DRAFT', currentWebglDeploymentId: null });
		await expect(createPublicRepository(prisma).findPublishedProjectById(created.id)).resolves.toBeNull();
		await repository.cancelSubmission(created.id, { id: actorId, role: 'ADMIN' });
	});

	it('persists the generation-fenced Garage ETag on a direct WebGL source representation', async () => {
		const token = 'q'.repeat(32);
		const { repository, created } = await createDraft([manifestItem('WEBGL', 'webgl', token)]);
		const item = created.submission.items[0]!;
		const uploads = createAssetUploadRepository(prisma);
		const session = await uploads.createAllocating({
			id: randomUUID(), projectId: created.id, exhibitionId: null, userId: actorId,
			kind: 'WEBGL', originalName: 'source.zip', declaredMimeType: 'application/zip',
			totalBytes: 10n, partSizeBytes: 10, totalParts: 1, bucket: protectedBucket,
			objectKey: `protected/uploads/${randomUUID()}/source.zip`, generation: 1,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: '9'.repeat(64),
			sourceIdentityBlockSizeBytes: 1_048_576, sourceIdentityBlockManifest: 'e30=',
			expiresAt: new Date(Date.now() + 60_000), submissionItemId: item.id, submissionClientToken: token,
		});
		await uploads.setAllocated(session.id, 1, `garage-${session.id}`);
		const claimToken = randomUUID();
		await expect(uploads.claimCompletion({
			sessionId: session.id, actorId, generation: 1, token: claimToken, leaseMs: 60_000,
		})).resolves.toBe('claimed');

		await expect(uploads.markVerifying({
			sessionId: session.id, generation: 1, token: claimToken, completedSize: 10,
			result: { status: 'VERIFYING', sessionId: session.id, generation: 2, sizeBytes: 10, etag: '"wrong-generation"' },
		})).rejects.toThrow(/generation or object identity fence/);
		await expect(prisma.assetUploadSession.findUniqueOrThrow({ where: { id: session.id } }))
			.resolves.toMatchObject({ state: 'COMPLETING', resultAssetId: null, resultRepresentationId: null });

		const etag = '"garage-multipart-etag-2"';
		await expect(uploads.markVerifying({
			sessionId: session.id, generation: 1, token: claimToken, completedSize: 10,
			result: { status: 'VERIFYING', sessionId: session.id, generation: 1, sizeBytes: 10, etag },
		})).resolves.toBe(true);
		const completed = await prisma.assetUploadSession.findUniqueOrThrow({ where: { id: session.id } });
		expect(completed).toMatchObject({ state: 'VERIFYING', generation: 1 });
		const source = await prisma.assetRepresentation.findUniqueOrThrow({
			where: { id: completed.resultRepresentationId! },
		});
		expect(source).toMatchObject({
			role: 'WEBGL_SOURCE', bucket: protectedBucket, objectKey: session.objectKey,
			etag, sourceIdentityAlgorithm: session.sourceIdentityAlgorithm, sourceIdentity: session.sourceIdentity,
			state: 'VERIFYING',
		});
		await repository.cancelSubmission(created.id, { id: actorId, role: 'ADMIN' });
	});

	it('commits the WebGL deployment pointer only after staged bytes are copied and verified', async () => {
		const token = 'z'.repeat(32);
		const { repository, created } = await createDraft([manifestItem('WEBGL', 'webgl', token)]);
		const item = created.submission.items[0]!;
		const uploads = createAssetUploadRepository(prisma);
		const session = await uploads.createAllocating({
			id: randomUUID(), projectId: created.id, exhibitionId: null, userId: actorId,
			kind: 'WEBGL', originalName: 'webgl.zip', declaredMimeType: 'application/zip',
			totalBytes: 10n, partSizeBytes: 10, totalParts: 1, bucket: protectedBucket,
			objectKey: `protected/uploads/${randomUUID()}/webgl.zip`, generation: 1,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'f'.repeat(64),
			sourceIdentityBlockSizeBytes: 1_048_576, sourceIdentityBlockManifest: 'e30=',
			expiresAt: new Date(Date.now() + 60_000), submissionItemId: item.id, submissionClientToken: token,
		});
		await uploads.setAllocated(session.id, 1, `garage-${session.id}`);
		const asset = await prisma.asset.create({
			data: {
				projectId: created.id, kind: 'WEBGL', status: 'PROCESSING', originalName: 'webgl.zip',
				representations: { create: {
					role: 'WEBGL_SOURCE', bucket: protectedBucket, objectKey: session.objectKey,
					mimeType: 'application/zip', sizeBytes: 10n, state: 'VERIFYING',
					sourceIdentityAlgorithm: session.sourceIdentityAlgorithm, sourceIdentity: session.sourceIdentity,
				} },
			}, include: { representations: true },
		});
		const source = asset.representations[0]!;
		await prisma.assetUploadSession.update({
			where: { id: session.id },
			data: { state: 'VERIFYING', uploadId: null, resultAssetId: asset.id, resultRepresentationId: source.id },
		});
		const persistence = createWebglProcessingRepository(prisma);
		await persistence.claimVerifyingWebglSessions({
			kind: 'WEBGL', limit: 1, claimToken: 'webgl-publication-claim', leaseUntil: new Date(Date.now() + 60_000),
		});
		const deploymentId = randomUUID();
		const keys = createCanonicalWebglPublicKeys(created.id, deploymentId);
		const reservation = await persistence.reserveDeployment({
			sessionId: session.id, generation: 1, claimToken: 'webgl-publication-claim',
			candidateDeploymentId: deploymentId, publicBucket, protectedBucket,
			publicPrefix: keys.publicPrefix, entryObjectKey: keys.entryObjectKey,
			sourceRepresentationId: source.id,
		});
		const bytes = Buffer.from('<html>ready</html>');
		const checksum = createHash('sha256').update(bytes).digest('hex');
		stagedObjects.set(`${protectedBucket}\0${reservation.outputEntryObjectKey}`, bytes);
		await expect(persistence.commitReady({
			sessionId: session.id, generation: 1, claimToken: 'webgl-publication-claim',
			deploymentId, expectedCurrentDeploymentId: null,
			assetId: asset.id, representationId: source.id, representationUpdatedAt: source.updatedAt,
			objectManifest: { version: 1, objects: [{
				objectKey: reservation.outputEntryObjectKey, sizeBytes: String(bytes.length),
				mimeType: 'text/html; charset=utf-8', contentEncoding: null,
				etag: '"staged-index"', checksumSha256: checksum,
			}] },
		})).resolves.toBe('COMMITTED');
		await expect(prisma.project.findUniqueOrThrow({ where: { id: created.id } }))
			.resolves.toMatchObject({ status: 'DRAFT', currentWebglDeploymentId: null });
		await expect(repository.finalizeSubmission(created.id, { id: actorId, role: 'ADMIN' }))
			.resolves.toMatchObject({ state: 'FINALIZING' });

		const publicObjects = new Map<string, Buffer>();
		const worker = createProjectPublicationWorker({
			repository: createProjectPublicationRepository(prisma),
			storage: {
				async head(bucket, key) {
					const value = stagedObjects.get(`${bucket}\0${key}`) ?? publicObjects.get(`${bucket}\0${key}`);
					return value ? { size: value.length, checksumSha256: createHash('sha256').update(value).digest('hex') } : null;
				},
				async stream(bucket, key) {
					const value = stagedObjects.get(`${bucket}\0${key}`);
					if (!value) throw new Error('staged WebGL object missing');
					return { body: Readable.from(value), size: value.length };
				},
				async upload(input) {
					const chunks: Buffer[] = [];
					for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
					publicObjects.set(`${input.bucket}\0${input.key}`, Buffer.concat(chunks));
				},
				async delete(bucket, key) { publicObjects.delete(`${bucket}\0${key}`); },
			},
			ids: { next: randomUUID }, logger: { error: () => undefined, warn: () => undefined },
			heartbeatMs: 60_000,
		});
		await expect(worker.runPass()).resolves.toMatchObject({ completed: 1 });
		await expect(prisma.project.findUniqueOrThrow({ where: { id: created.id } }))
			.resolves.toMatchObject({ status: 'PUBLISHED', currentWebglDeploymentId: deploymentId });
		await expect(prisma.webglDeployment.findUniqueOrThrow({ where: { id: deploymentId } }))
			.resolves.toMatchObject({
				state: 'READY', stagingBucket: null, stagingPrefix: null,
				entryObjectKey: keys.entryObjectKey,
			});
		expect(publicObjects.get(`${publicBucket}\0${keys.entryObjectKey}`)?.equals(bytes)).toBe(true);
		await prisma.project.update({ where: { id: created.id }, data: { status: 'ARCHIVED' } });
		await expect(prisma.project.findUniqueOrThrow({ where: { id: created.id } }))
			.resolves.toMatchObject({ status: 'ARCHIVED', currentWebglDeploymentId: deploymentId });
		await expect(createPublicRepository(prisma).findPublishedProjectById(created.id))
			.resolves.toMatchObject({ id: created.id, status: 'ARCHIVED' });
	});

	it('requeues immutable publication targets when cancellation wins after a worker copy', async () => {
		const token = 'c'.repeat(32);
		const { repository, created } = await createDraft([manifestItem('IMAGE', 'image:0', token)]);
		const item = created.submission.items[0]!;
		await bindReadyAsset({ projectId: created.id, itemId: item.id, clientToken: token, kind: 'IMAGE' });
		await repository.finalizeSubmission(created.id, { id: actorId, role: 'ADMIN' });
		const publicationRepository = createProjectPublicationRepository(prisma);
		const claimToken = randomUUID();
		const claimed = await publicationRepository.claim({ token: claimToken, leaseMs: 60_000 });
		expect(claimed?.projectId).toBe(created.id);
		const validated = await publicationRepository.validatePlan(claimed!, claimToken);
		if (validated.status !== 'VALID') throw new Error(`publication plan did not validate: ${validated.status === 'FAILED' ? validated.error : validated.status}`);
		expect(validated.status).toBe('VALID');
		const targets = validated.job.plan.objects.map(({ targetBucket, targetObjectKey }) => ({
			bucket: targetBucket, storageKey: targetObjectKey,
		}));
		await repository.cancelSubmission(created.id, { id: actorId, role: 'ADMIN' });
		await prisma.orphanObject.deleteMany({ where: { OR: targets } });
		await expect(publicationRepository.complete(validated.job, claimToken)).resolves.toBe('CANCELLED');
		await expect(prisma.orphanObject.count({ where: { OR: targets } })).resolves.toBe(targets.length);
	});

	it('rejects cross-project job identity and image source-fence tampering at completion', async () => {
		const token = 't'.repeat(32);
		const { repository, created } = await createDraft([manifestItem('IMAGE', 'image:0', token)]);
		const other = await createDraft([]);
		const item = created.submission.items[0]!;
		await bindReadyAsset({ projectId: created.id, itemId: item.id, clientToken: token, kind: 'IMAGE' });
		await expect(prisma.projectPublicationJob.create({
			data: {
				projectId: other.created.id, submissionId: created.submission.id,
				plan: { version: 1, projectId: other.created.id, submissionId: created.submission.id, objects: [], representations: [], webglDeployments: [] },
			},
		})).rejects.toThrow();

		await repository.finalizeSubmission(created.id, { id: actorId, role: 'ADMIN' });
		const publicationRepository = createProjectPublicationRepository(prisma);
		const claimToken = randomUUID();
		const claimed = await publicationRepository.claim({ token: claimToken, leaseMs: 60_000 });
		expect(claimed?.projectId).toBe(created.id);
		const validated = await publicationRepository.validatePlan(claimed!, claimToken);
		if (validated.status !== 'VALID') throw new Error(`publication plan did not validate: ${validated.status === 'FAILED' ? validated.error : validated.status}`);
		expect(validated.status).toBe('VALID');
		await expect(publicationRepository.complete({
			...validated.job,
			projectId: other.created.id,
			plan: { ...validated.job.plan, projectId: other.created.id },
		}, claimToken)).rejects.toThrow(/job, submission, project, or plan identity changed/);

		const representationId = validated.job.plan.representations[0]!.id;
		await prisma.assetRepresentation.update({
			where: { id: representationId }, data: { sourceIdentity: 'tampered-source-identity' },
		});
		await expect(publicationRepository.complete(validated.job, claimToken))
			.rejects.toThrow(/image role, source, or generation fence changed/);
		await repository.cancelSubmission(created.id, { id: actorId, role: 'ADMIN' });
		await other.repository.cancelSubmission(other.created.id, { id: actorId, role: 'ADMIN' });
	});

	it('rejects token spoofing and cancellation durably queues protected staging bytes', async () => {
		const token = 'k'.repeat(32);
		const { repository, created } = await createDraft([manifestItem('GAME', 'game', token)]);
		const item = created.submission.items[0]!;
		const uploads = createAssetUploadRepository(prisma);
		const input = {
			id: randomUUID(), projectId: created.id, exhibitionId: null, userId: actorId,
			kind: 'GAME' as const, originalName: 'game.zip', declaredMimeType: 'application/zip',
			totalBytes: 10n, partSizeBytes: 10, totalParts: 1, bucket: protectedBucket,
			objectKey: `protected/uploads/${randomUUID()}/source.zip`, generation: 1,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'b'.repeat(64),
			sourceIdentityBlockSizeBytes: 1_048_576, sourceIdentityBlockManifest: 'e30=',
			expiresAt: new Date(Date.now() + 60_000), submissionItemId: item.id,
		};
		await expect(uploads.createAllocating({ ...input, submissionClientToken: 'x'.repeat(32) }))
			.rejects.toThrow('PROJECT_SUBMISSION_ITEM_MISMATCH');
		const session = await uploads.createAllocating({ ...input, id: randomUUID(), submissionClientToken: token });
		await uploads.setAllocated(session.id, 1, `garage-${session.id}`);
		await expect(repository.cancelSubmission(created.id, { id: actorId, role: 'ADMIN' }))
			.resolves.toMatchObject({ state: 'CANCELLED', project: { status: 'DRAFT' } });
		await expect(prisma.orphanObject.count({ where: { bucket: protectedBucket, storageKey: session.objectKey } })).resolves.toBe(1);
		await expect(prisma.multipartAbortTask.count({ where: { bucket: protectedBucket, uploadSessionId: session.id } })).resolves.toBe(1);
	});

	it('rejects required=false at the database boundary', async () => {
		const { created } = await createDraft([]);
		await expect(prisma.projectSubmissionItem.create({
			data: {
				projectSubmission: { connect: { id: created.submission.id } },
				kind: 'GAME', slot: 'game', clientToken: 'r'.repeat(32), required: false,
			},
		})).rejects.toThrow();
	});

	it('serializes repeated finalize-versus-cancel races without publishing partial state', async () => {
		for (let attempt = 0; attempt < 5; attempt++) {
			const token = `${attempt}`.repeat(32);
			const { repository, created } = await createDraft([manifestItem('GAME', 'game', token)]);
			const item = created.submission.items[0]!;
			await bindReadyAsset({ projectId: created.id, itemId: item.id, clientToken: token, kind: 'GAME' });
			const outcomes = await Promise.allSettled([
				repository.finalizeSubmission(created.id, { id: actorId, role: 'ADMIN' }),
				repository.cancelSubmission(created.id, { id: actorId, role: 'ADMIN' }),
			]);
			expect(outcomes.some(({ status }) => status === 'fulfilled')).toBe(true);
			await expect(prisma.projectSubmission.findUniqueOrThrow({ where: { projectId: created.id } }))
				.resolves.toMatchObject({ state: 'CANCELLED', projectId: created.id });
			await expect(prisma.project.findUniqueOrThrow({ where: { id: created.id } }))
				.resolves.toMatchObject({ status: 'DRAFT', currentWebglDeploymentId: null });
			const job = await prisma.projectPublicationJob.findUnique({ where: { projectId: created.id } });
			expect(job === null || job.state === 'CANCELLED').toBe(true);
			await expect(createPublicRepository(prisma).findPublishedProjectById(created.id)).resolves.toBeNull();
		}
	});
});
