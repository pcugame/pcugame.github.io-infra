import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ObjectStorage } from '../application/ports.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createS3Client } from '../lib/s3.js';
import { createObjectStorage } from '../lib/storage.js';
import { createProjectCrudRepository } from '../modules/admin/project/crud.repository.js';
import { createExhibitionRepository } from '../modules/admin/year/repository.js';
import { createAssetsRepository } from '../modules/assets/repository.js';
import { createAssetsService } from '../modules/assets/service.js';
import { queueDurableDeletions } from '../modules/orphan/outbox.js';
import { createOrphanRepository } from '../modules/orphan/repository.js';
import { createObjectReferenceResolver } from '../modules/orphan/reference-resolver.js';
import { createOrphanService } from '../modules/orphan/service.js';
import { createWebglDeploymentKeys } from '../modules/webgl/paths.js';

const runIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true'
	&& process.env['RUN_STORAGE_INTEGRATION'] === 'true';

type RenditionProfile = 'CARD_480' | 'DISPLAY_960';

describe.runIf(runIntegration)(
	'responsive image lifecycle with Garage and PostgreSQL',
	() => {
		const testId = randomUUID();
		const keyPrefix = `integration/responsive-image-lifecycle/${testId}`;
		const key = (name: string) => `${keyPrefix}/${name}`;
		const publicBucket = process.env['S3_BUCKET_PUBLIC'] ?? 'pcu-public';
		const protectedBucket = process.env['S3_BUCKET_PROTECTED'] ?? 'pcu-protected';
		const s3 = createS3Client({
			S3_ENDPOINT: process.env['S3_ENDPOINT'] ?? 'http://127.0.0.1:3900',
			S3_REGION: process.env['S3_REGION'] ?? 'garage',
			S3_ACCESS_KEY_ID: process.env['S3_ACCESS_KEY_ID'] ?? '',
			S3_SECRET_ACCESS_KEY: process.env['S3_SECRET_ACCESS_KEY'] ?? '',
			S3_FORCE_PATH_STYLE: true,
		});
		const storage = createObjectStorage(s3, { defaultPresignTtlSec: 60 });
		const storedObjects = new Map<string, Set<string>>([
			[publicBucket, new Set()],
			[protectedBucket, new Set()],
		]);
		const createdProjectIds: number[] = [];
		const createdExhibitionIds: number[] = [];
		const ownedOutboxKeys = new Set<string>();
		let fixtureSequence = 0;
		let prisma!: PrismaClient;
		let userId = 0;

		async function upload(
			bucket: string,
			storageKey: string,
			contentType = 'application/octet-stream',
		): Promise<void> {
			const body = Buffer.from(storageKey);
			await storage.upload(bucket, storageKey, body, contentType, body.length);
			storedObjects.get(bucket)?.add(storageKey);
		}

		async function expectObject(
			bucket: string,
			storageKey: string,
			exists: boolean,
		): Promise<void> {
			const object = await storage.head(bucket, storageKey);
			if (exists) expect(object).not.toBeNull();
			else expect(object).toBeNull();
		}

		async function createExhibition(label: string, posterStorageKey?: string) {
			fixtureSequence += 1;
			const exhibition = await prisma.exhibition.create({
				data: {
					year: 2800 + fixtureSequence,
					title: `Responsive image lifecycle ${label} ${testId}`,
					...(posterStorageKey ? {
						posterStorageKey,
						posterOriginalName: 'poster.webp',
						posterMimeType: 'image/webp',
						posterSizeBytes: 1n,
						posterWidth: 1600,
						posterHeight: 900,
					} : {}),
				},
			});
			createdExhibitionIds.push(exhibition.id);
			return exhibition;
		}

		async function createProject(exhibitionId: number, label: string) {
			fixtureSequence += 1;
			const project = await prisma.project.create({
				data: {
					exhibitionId,
					creatorId: userId,
					slug: `responsive-${label}-${testId}-${fixtureSequence}`,
					title: `Responsive lifecycle ${label}`,
					status: 'PUBLISHED',
				},
			});
			createdProjectIds.push(project.id);
			return project;
		}

		function renditionData(input: {
			profile: RenditionProfile;
			storageKey: string;
			sourceStorageKey: string;
			assetId?: number;
			exhibitionId?: number;
		}) {
			return {
				profile: input.profile,
				storageKey: input.storageKey,
				sourceStorageKey: input.sourceStorageKey,
				width: input.profile === 'CARD_480' ? 480 : 960,
				height: input.profile === 'CARD_480' ? 270 : 540,
				mimeType: 'image/webp',
				sizeBytes: 1n,
				...(input.assetId !== undefined ? { assetId: input.assetId } : {}),
				...(input.exhibitionId !== undefined ? { exhibitionId: input.exhibitionId } : {}),
			};
		}

		function savedRendition(
			profile: RenditionProfile,
			storageKey: string,
			sourceStorageKey: string,
		) {
			return {
				profile,
				storageKey,
				sourceStorageKey,
				width: profile === 'CARD_480' ? 480 : 960,
				height: profile === 'CARD_480' ? 270 : 540,
				mimeType: 'image/webp',
				sizeBytes: 1,
			};
		}

		async function expectQueued(targets: Array<{
			bucket: string;
			storageKey: string;
			targetKind?: 'EXACT' | 'PREFIX';
		}>): Promise<void> {
			for (const target of targets) ownedOutboxKeys.add(target.storageKey);
			const rows = await prisma.orphanObject.findMany({
				where: {
					OR: targets.map(({ bucket, storageKey }) => ({ bucket, storageKey })),
				},
			});
			const byTarget = new Map(rows.map((row) => [`${row.bucket}\0${row.storageKey}`, row]));
			for (const target of targets) {
				expect(byTarget.get(`${target.bucket}\0${target.storageKey}`)).toMatchObject({
					state: 'PENDING',
					targetKind: target.targetKind ?? 'EXACT',
				});
			}
		}

		async function reapOwnedTargets(logger = {
			info: vi.fn(),
			error: vi.fn(),
		}): Promise<void> {
			const references = createObjectReferenceResolver(
				prisma,
				{ publicBucket, protectedBucket },
				logger,
			);
			const reaper = createOrphanService({
				clock: { now: () => new Date(Date.now() + 5_000) },
				storage,
				repository: createOrphanRepository(prisma),
				references,
				ids: { next: () => randomUUID() },
				logger,
			});

			for (let attempt = 0; attempt < 5; attempt += 1) {
				await prisma.orphanObject.updateMany({
					where: {
						storageKey: { in: [...ownedOutboxKeys] },
						state: 'PENDING',
					},
					data: { nextAttemptAt: new Date(0) },
				});
				await reaper.runOrphanReaper();
				const unfinished = await prisma.orphanObject.count({
					where: {
						storageKey: { in: [...ownedOutboxKeys] },
						state: { in: ['PENDING', 'DELETE_CLAIMED'] },
					},
				});
				if (unfinished === 0) return;
			}
			throw new Error('Responsive image orphan targets did not converge');
		}

		beforeAll(async () => {
			const databaseUrl = process.env['DATABASE_URL'];
			if (!databaseUrl) throw new Error('DATABASE_URL is required');
			prisma = createPrismaClientForDatabase(databaseUrl);
			await prisma.$connect();
			const user = await prisma.user.create({
				data: {
					googleSub: `responsive-image-lifecycle-${testId}`,
					email: `responsive-image-lifecycle-${testId}@example.test`,
					name: 'Responsive image lifecycle integration',
					role: 'ADMIN',
				},
			});
			userId = user.id;
		});

		afterAll(async () => {
			if (prisma) {
				await prisma.orphanObject.deleteMany({
					where: {
						OR: [
							{ storageKey: { startsWith: keyPrefix } },
							{ storageKey: { in: [...ownedOutboxKeys] } },
						],
					},
				}).catch(() => undefined);
				await prisma.uploadIntent.deleteMany({
					where: { storageKey: { startsWith: keyPrefix } },
				}).catch(() => undefined);
				if (createdProjectIds.length > 0) {
					await prisma.project.deleteMany({
						where: { id: { in: createdProjectIds } },
					}).catch(() => undefined);
				}
				if (createdExhibitionIds.length > 0) {
					await prisma.exhibition.deleteMany({
						where: { id: { in: createdExhibitionIds } },
					}).catch(() => undefined);
				}
				if (userId) {
					await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
				}
				await prisma.$disconnect();
			}
			for (const [bucket, keys] of storedObjects) {
				for (const storageKey of keys) {
					await storage.delete(bucket, storageKey).catch(() => undefined);
				}
			}
			s3.destroy();
		});

		it('deletes one current asset bundle through the existing service, outbox, and reaper', async () => {
			const exhibition = await createExhibition('single-asset');
			const project = await createProject(exhibition.id, 'single-asset');
			const original = key('single/original.webp');
			const card = key('single/card-480.webp');
			const display = key('single/display-960.webp');
			const asset = await prisma.asset.create({
				data: {
					projectId: project.id,
					kind: 'IMAGE',
					storageKey: original,
					originalName: 'original.webp',
					mimeType: 'image/webp',
					sizeBytes: 1n,
					width: 1600,
					height: 900,
					isPublic: true,
					imageRenditions: {
						create: [
							renditionData({ profile: 'CARD_480', storageKey: card, sourceStorageKey: original }),
							renditionData({ profile: 'DISPLAY_960', storageKey: display, sourceStorageKey: original }),
						],
					},
				},
			});
			await Promise.all([
				upload(publicBucket, original, 'image/webp'),
				upload(publicBucket, card, 'image/webp'),
				upload(publicBucket, display, 'image/webp'),
			]);

			const service = createAssetsService({
				protectedBucket,
				presign: async () => 'https://unused.example.test',
				bucketForKind: (kind) => kind === 'GAME' || kind === 'VIDEO'
					? protectedBucket
					: publicBucket,
				wakeDeletionWorker: vi.fn(),
				loadProjectWithAccess: async () => ({}),
				downloadLimiter: { check: () => 'ok' },
				logger: { info: vi.fn(), error: vi.fn() },
				repository: createAssetsRepository(prisma),
			});
			await expect(service.deleteAsset(asset.id, { id: userId, role: 'ADMIN' }))
				.resolves.toEqual({ projectId: project.id });

			await expect(prisma.asset.findUniqueOrThrow({ where: { id: asset.id } }))
				.resolves.toMatchObject({ status: 'DELETED', storageKey: original });
			await expect(prisma.imageRendition.count({ where: { assetId: asset.id } }))
				.resolves.toBe(0);
			await expectQueued([original, card, display].map((storageKey) => ({
				bucket: publicBucket,
				storageKey,
			})));

			await reapOwnedTargets();
			for (const storageKey of [original, card, display]) {
				await expectObject(publicBucket, storageKey, false);
			}
		});

		it('replaces an asset generation without retaining or deleting the wrong rendition bundle', async () => {
			const exhibition = await createExhibition('asset-replace');
			const project = await createProject(exhibition.id, 'asset-replace');
			const oldOriginal = key('asset-replace/old-original.webp');
			const oldCard = key('asset-replace/old-card-480.webp');
			const oldDisplay = key('asset-replace/old-display-960.webp');
			const newOriginal = key('asset-replace/new-original.webp');
			const newCard = key('asset-replace/new-card-480.webp');
			const newDisplay = key('asset-replace/new-display-960.webp');
			const oldAsset = await prisma.asset.create({
				data: {
					projectId: project.id,
					kind: 'IMAGE',
					storageKey: oldOriginal,
					originalName: 'old.webp',
					mimeType: 'image/webp',
					sizeBytes: 1n,
					width: 1600,
					height: 900,
					isPublic: true,
					imageRenditions: {
						create: [
							renditionData({ profile: 'CARD_480', storageKey: oldCard, sourceStorageKey: oldOriginal }),
							renditionData({ profile: 'DISPLAY_960', storageKey: oldDisplay, sourceStorageKey: oldOriginal }),
						],
					},
				},
			});
			await Promise.all([
				...([oldOriginal, oldCard, oldDisplay, newOriginal, newCard, newDisplay]
					.map((storageKey) => upload(publicBucket, storageKey, 'image/webp'))),
			]);

			const repository = createProjectCrudRepository(prisma);
			const replaced = await repository.replaceOrCreateReplaceableAsset(
				project.id,
				'IMAGE',
				{
					storageKey: newOriginal,
					originalName: 'new.webp',
					mimeType: 'image/webp',
					sizeBytes: 1n,
					width: 1600,
					height: 900,
					isPublic: true,
					renditions: [
						savedRendition('CARD_480', newCard, newOriginal),
						savedRendition('DISPLAY_960', newDisplay, newOriginal),
					],
				},
				{
					bucket: publicBucket,
					reason: 'responsive-image-integration-asset-replace',
					playbackReason: 'responsive-image-integration-asset-replace-playback',
				},
			);
			expect(replaced).toMatchObject({
				oldStorageKey: oldOriginal,
				oldPlaybackStorageKey: null,
			});
			await expect(prisma.asset.findUniqueOrThrow({ where: { id: oldAsset.id } }))
				.resolves.toMatchObject({ status: 'DELETED' });
			await expect(prisma.imageRendition.findMany({
				where: { assetId: replaced.assetId },
				orderBy: { profile: 'asc' },
			})).resolves.toEqual(expect.arrayContaining([
				expect.objectContaining({ storageKey: newCard, sourceStorageKey: newOriginal }),
				expect.objectContaining({ storageKey: newDisplay, sourceStorageKey: newOriginal }),
			]));
			await expectQueued([oldOriginal, oldCard, oldDisplay]
				.map((storageKey) => ({ bucket: publicBucket, storageKey })));

			await reapOwnedTargets();
			for (const storageKey of [oldOriginal, oldCard, oldDisplay]) {
				await expectObject(publicBucket, storageKey, false);
			}
			for (const storageKey of [newOriginal, newCard, newDisplay]) {
				await expectObject(publicBucket, storageKey, true);
			}
		});

		it('deletes a project graph with image renditions and protected legacy targets', async () => {
			const exhibition = await createExhibition('project-delete');
			const project = await createProject(exhibition.id, 'project-delete');
			const deployment = createWebglDeploymentKeys(project.id, randomUUID());
			await prisma.project.update({
				where: { id: project.id },
				data: { webglEntryKey: deployment.entryKey },
			});

			const original = key('project/original.webp');
			const card = key('project/card-480.webp');
			const display = key('project/display-960.webp');
			const game = key('project/game.zip');
			const video = key('project/video.mp4');
			const playback = key('project/video-playback.mp4');
			const image = await prisma.asset.create({
				data: {
					projectId: project.id,
					kind: 'IMAGE',
					storageKey: original,
					originalName: 'original.webp',
					mimeType: 'image/webp',
					sizeBytes: 1n,
					isPublic: true,
				},
			});
			await prisma.imageRendition.createMany({ data: [
				renditionData({ profile: 'CARD_480', storageKey: card, sourceStorageKey: original, assetId: image.id }),
				renditionData({ profile: 'DISPLAY_960', storageKey: display, sourceStorageKey: original, assetId: image.id }),
			] });
			await prisma.asset.createMany({ data: [
				{
					projectId: project.id, kind: 'GAME', storageKey: game,
					originalName: 'game.zip', mimeType: 'application/zip', sizeBytes: 1n, isPublic: false,
				},
				{
					projectId: project.id, kind: 'VIDEO', storageKey: video,
					playbackStorageKey: playback, originalName: 'video.mp4', mimeType: 'video/mp4',
					playbackMimeType: 'video/mp4', sizeBytes: 1n, playbackSizeBytes: 1n, isPublic: false,
				},
			] });

			await Promise.all([
				upload(publicBucket, original, 'image/webp'),
				upload(publicBucket, card, 'image/webp'),
				upload(publicBucket, display, 'image/webp'),
				upload(protectedBucket, game, 'application/zip'),
				upload(protectedBucket, video, 'video/mp4'),
				upload(protectedBucket, playback, 'video/mp4'),
				upload(protectedBucket, deployment.sourceKey, 'application/zip'),
				upload(publicBucket, deployment.entryKey, 'text/html'),
				upload(publicBucket, `${deployment.sitePrefix}build.js`, 'text/javascript'),
			]);

			const repository = createProjectCrudRepository(prisma);
			await expect(repository.deleteProjectReturningAssets(project.id, {
				publicBucket,
				protectedBucket,
				reason: 'responsive-image-integration-project-delete',
			})).resolves.toMatchObject({ webglEntryKey: deployment.entryKey });
			await expect(prisma.project.count({ where: { id: project.id } })).resolves.toBe(0);
			await expect(prisma.imageRendition.count({ where: { assetId: image.id } })).resolves.toBe(0);

			await expectQueued([
				...([original, card, display].map((storageKey) => ({ bucket: publicBucket, storageKey }))),
				...([game, video, playback, deployment.sourceKey]
					.map((storageKey) => ({ bucket: protectedBucket, storageKey }))),
				{ bucket: publicBucket, storageKey: deployment.sitePrefix, targetKind: 'PREFIX' },
			]);
			await reapOwnedTargets();
			for (const storageKey of [original, card, display, deployment.entryKey, `${deployment.sitePrefix}build.js`]) {
				await expectObject(publicBucket, storageKey, false);
			}
			for (const storageKey of [game, video, playback, deployment.sourceKey]) {
				await expectObject(protectedBucket, storageKey, false);
			}
		});

		it('bulk-deletes every responsive bundle in the selected project set', async () => {
			const exhibition = await createExhibition('project-bulk-delete');
			const projects = await Promise.all([
				createProject(exhibition.id, 'bulk-a'),
				createProject(exhibition.id, 'bulk-b'),
			]);
			const bundles: Array<{ projectId: number; assetId: number; keys: string[] }> = [];
			for (const [index, project] of projects.entries()) {
				const original = key(`bulk/${index}/original.webp`);
				const card = key(`bulk/${index}/card-480.webp`);
				const display = key(`bulk/${index}/display-960.webp`);
				const asset = await prisma.asset.create({
					data: {
						projectId: project.id,
						kind: 'POSTER',
						storageKey: original,
						originalName: 'poster.webp',
						mimeType: 'image/webp',
						sizeBytes: 1n,
						isPublic: true,
					},
				});
				await prisma.imageRendition.createMany({ data: [
					renditionData({ profile: 'CARD_480', storageKey: card, sourceStorageKey: original, assetId: asset.id }),
					renditionData({ profile: 'DISPLAY_960', storageKey: display, sourceStorageKey: original, assetId: asset.id }),
				] });
				const keys = [original, card, display];
				await Promise.all(keys.map((storageKey) => upload(publicBucket, storageKey, 'image/webp')));
				bundles.push({ projectId: project.id, assetId: asset.id, keys });
			}

			const repository = createProjectCrudRepository(prisma);
			await expect(repository.bulkDeleteProjectsReturningAssets(
				projects.map(({ id }) => id),
				{
					publicBucket,
					protectedBucket,
					reason: 'responsive-image-integration-project-bulk-delete',
				},
			)).resolves.toMatchObject({ result: { count: 2 } });
			await expect(prisma.project.count({
				where: { id: { in: projects.map(({ id }) => id) } },
			})).resolves.toBe(0);
			await expect(prisma.imageRendition.count({
				where: { assetId: { in: bundles.map(({ assetId }) => assetId) } },
			})).resolves.toBe(0);
			const allKeys = bundles.flatMap((bundle) => bundle.keys);
			await expectQueued(allKeys.map((storageKey) => ({ bucket: publicBucket, storageKey })));

			await reapOwnedTargets();
			for (const storageKey of allKeys) await expectObject(publicBucket, storageKey, false);
		});

		it('replaces and then independently clears an exhibition poster bundle', async () => {
			const oldPoster = key('poster-mutation/old-original.webp');
			const oldCard = key('poster-mutation/old-card-480.webp');
			const oldDisplay = key('poster-mutation/old-display-960.webp');
			const newPoster = key('poster-mutation/new-original.webp');
			const newCard = key('poster-mutation/new-card-480.webp');
			const newDisplay = key('poster-mutation/new-display-960.webp');
			const exhibition = await createExhibition('poster-mutation', oldPoster);
			await prisma.imageRendition.createMany({ data: [
				renditionData({ profile: 'CARD_480', storageKey: oldCard, sourceStorageKey: oldPoster, exhibitionId: exhibition.id }),
				renditionData({ profile: 'DISPLAY_960', storageKey: oldDisplay, sourceStorageKey: oldPoster, exhibitionId: exhibition.id }),
			] });
			await Promise.all([oldPoster, oldCard, oldDisplay, newPoster, newCard, newDisplay]
				.map((storageKey) => upload(publicBucket, storageKey, 'image/webp')));
			const repository = createExhibitionRepository(prisma);

			await expect(repository.replaceExhibitionPoster(
				exhibition.id,
				{
					storageKey: newPoster,
					originalName: 'new-poster.webp',
					mimeType: 'image/webp',
					sizeBytes: 1n,
					width: 1600,
					height: 900,
					renditions: [
						savedRendition('CARD_480', newCard, newPoster),
						savedRendition('DISPLAY_960', newDisplay, newPoster),
					],
				},
				{ bucket: publicBucket, reason: 'responsive-image-integration-poster-replace' },
			)).resolves.toMatchObject({ oldStorageKey: oldPoster });
			await expect(prisma.exhibition.findUniqueOrThrow({ where: { id: exhibition.id } }))
				.resolves.toMatchObject({ posterStorageKey: newPoster, posterWidth: 1600, posterHeight: 900 });
			await expect(prisma.imageRendition.findMany({
				where: { exhibitionId: exhibition.id },
			})).resolves.toEqual(expect.arrayContaining([
				expect.objectContaining({ storageKey: newCard, sourceStorageKey: newPoster }),
				expect.objectContaining({ storageKey: newDisplay, sourceStorageKey: newPoster }),
			]));
			await expectQueued([oldPoster, oldCard, oldDisplay]
				.map((storageKey) => ({ bucket: publicBucket, storageKey })));
			await reapOwnedTargets();
			for (const storageKey of [oldPoster, oldCard, oldDisplay]) {
				await expectObject(publicBucket, storageKey, false);
			}
			for (const storageKey of [newPoster, newCard, newDisplay]) {
				await expectObject(publicBucket, storageKey, true);
			}

			await expect(repository.clearExhibitionPoster(
				exhibition.id,
				{ bucket: publicBucket, reason: 'responsive-image-integration-poster-clear' },
			)).resolves.toMatchObject({ oldStorageKey: newPoster });
			await expect(prisma.exhibition.findUniqueOrThrow({ where: { id: exhibition.id } }))
				.resolves.toMatchObject({ posterStorageKey: null, posterWidth: null, posterHeight: null });
			await expect(prisma.imageRendition.count({ where: { exhibitionId: exhibition.id } }))
				.resolves.toBe(0);
			await expectQueued([newPoster, newCard, newDisplay]
				.map((storageKey) => ({ bucket: publicBucket, storageKey })));
			await reapOwnedTargets();
			for (const storageKey of [newPoster, newCard, newDisplay]) {
				await expectObject(publicBucket, storageKey, false);
			}
		});

		it('cascades an exhibition poster bundle and child project image bundle', async () => {
			const poster = key('exhibition/poster.webp');
			const posterCard = key('exhibition/poster-card-480.webp');
			const posterDisplay = key('exhibition/poster-display-960.webp');
			const exhibition = await createExhibition('cascade', poster);
			await prisma.imageRendition.createMany({ data: [
				renditionData({ profile: 'CARD_480', storageKey: posterCard, sourceStorageKey: poster, exhibitionId: exhibition.id }),
				renditionData({ profile: 'DISPLAY_960', storageKey: posterDisplay, sourceStorageKey: poster, exhibitionId: exhibition.id }),
			] });
			const project = await createProject(exhibition.id, 'exhibition-child');
			const original = key('exhibition/child-original.webp');
			const card = key('exhibition/child-card-480.webp');
			const display = key('exhibition/child-display-960.webp');
			const asset = await prisma.asset.create({
				data: {
					projectId: project.id, kind: 'IMAGE', storageKey: original,
					originalName: 'child.webp', mimeType: 'image/webp', sizeBytes: 1n, isPublic: true,
				},
			});
			await prisma.imageRendition.createMany({ data: [
				renditionData({ profile: 'CARD_480', storageKey: card, sourceStorageKey: original, assetId: asset.id }),
				renditionData({ profile: 'DISPLAY_960', storageKey: display, sourceStorageKey: original, assetId: asset.id }),
			] });
			const allKeys = [poster, posterCard, posterDisplay, original, card, display];
			await Promise.all(allKeys.map((storageKey) => upload(publicBucket, storageKey, 'image/webp')));

			const repository = createExhibitionRepository(prisma);
			await expect(repository.deleteExhibition(exhibition.id, {
				publicBucket,
				protectedBucket,
				reason: 'responsive-image-integration-exhibition-delete',
			})).resolves.toMatchObject({ posterStorageKey: poster, cleanupQueued: true });
			await expect(prisma.exhibition.count({ where: { id: exhibition.id } })).resolves.toBe(0);
			await expect(prisma.project.count({ where: { id: project.id } })).resolves.toBe(0);
			await expect(prisma.imageRendition.count({
				where: { OR: [{ assetId: asset.id }, { exhibitionId: exhibition.id }] },
			})).resolves.toBe(0);
			await expectQueued(allKeys.map((storageKey) => ({ bucket: publicBucket, storageKey })));

			await reapOwnedTargets();
			for (const storageKey of allKeys) await expectObject(publicBucket, storageKey, false);
		});

		it('protects one mismatched rendition exactly without failing the public bucket closed', async () => {
			const exhibition = await createExhibition('stale-reference');
			const project = await createProject(exhibition.id, 'stale-reference');
			const original = key('stale/original.webp');
			const current = key('stale/current-display-960.webp');
			const stale = key('stale/mismatched-card-480.webp');
			const unrelated = key('stale/unrelated-orphan.webp');
			const asset = await prisma.asset.create({
				data: {
					projectId: project.id, kind: 'IMAGE', storageKey: original,
					originalName: 'original.webp', mimeType: 'image/webp', sizeBytes: 1n, isPublic: true,
				},
			});
			const [currentRow, staleRow] = await Promise.all([
				prisma.imageRendition.create({ data: renditionData({
					profile: 'DISPLAY_960', storageKey: current, sourceStorageKey: original, assetId: asset.id,
				}) }),
				prisma.imageRendition.create({ data: renditionData({
					profile: 'CARD_480', storageKey: stale, sourceStorageKey: key('stale/older-source.webp'), assetId: asset.id,
				}) }),
			]);
			await Promise.all([original, current, stale, unrelated]
				.map((storageKey) => upload(publicBucket, storageKey, 'image/webp')));

			const logger = { info: vi.fn(), error: vi.fn() };
			const resolver = createObjectReferenceResolver(
				prisma,
				{ publicBucket, protectedBucket },
				logger,
			);
			const inventory = await resolver.collect();
			expect(inventory.unsafeBuckets.has(publicBucket)).toBe(false);
			expect(inventory.references).toEqual(expect.arrayContaining([
				expect.objectContaining({ key: current, source: `image-rendition:${currentRow.id}:current` }),
				expect.objectContaining({ key: stale, source: `image-rendition:${staleRow.id}:mismatched` }),
			]));
			expect(logger.error).toHaveBeenCalledWith(
				expect.objectContaining({ renditionId: staleRow.id, storageKey: stale }),
				expect.stringMatching(/mismatched image rendition pointer/i),
			);

			await prisma.$transaction((tx) => queueDurableDeletions(tx, [
				{ bucket: publicBucket, storageKey: current, reason: 'integration-current-reference-probe' },
				{ bucket: publicBucket, storageKey: stale, reason: 'integration-stale-reference-probe' },
				{ bucket: publicBucket, storageKey: unrelated, reason: 'integration-unrelated-orphan' },
			]));
			await expectQueued([current, stale, unrelated]
				.map((storageKey) => ({ bucket: publicBucket, storageKey })));
			await reapOwnedTargets(logger);

			await expectObject(publicBucket, current, true);
			await expectObject(publicBucket, stale, true);
			await expectObject(publicBucket, unrelated, false);
			await expect(prisma.orphanObject.findUniqueOrThrow({
				where: { orphan_bucket_storage_key: { bucket: publicBucket, storageKey: current } },
			})).resolves.toMatchObject({ state: 'CANCELLED', cancelReason: 'live-reference-detected' });
			await expect(prisma.orphanObject.findUniqueOrThrow({
				where: { orphan_bucket_storage_key: { bucket: publicBucket, storageKey: stale } },
			})).resolves.toMatchObject({ state: 'CANCELLED', cancelReason: 'live-reference-detected' });
			await expect(prisma.orphanObject.findUniqueOrThrow({
				where: { orphan_bucket_storage_key: { bucket: publicBucket, storageKey: unrelated } },
			})).resolves.toMatchObject({ state: 'RESOLVED' });
		});
	},
);
