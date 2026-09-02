import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createS3Client } from '../lib/s3.js';
import { createObjectStorage } from '../lib/storage.js';
import { createProjectCrudRepository } from '../modules/admin/project/crud.repository.js';
import { createWebglProcessingRepository } from '../modules/asset-upload/webgl-processing-repository.js';
import { createOrphanRepository } from '../modules/orphan/repository.js';
import {
	createObjectReferenceResolver,
} from '../modules/orphan/reference-resolver.js';
import { parseReconcileOptions, reconcileObjects } from '../modules/orphan/reconcile.js';
import { createOrphanService } from '../modules/orphan/service.js';
import type { WebglPublishedObjectManifest } from '../modules/webgl/processing.js';

const enabled = process.env['RUN_POSTGRES_INTEGRATION'] === 'true'
	&& process.env['RUN_GARAGE_INTEGRATION'] === 'true';
const buckets = {
	publicBucket: process.env['S3_BUCKET_PUBLIC'] ?? 'pcu-public',
	protectedBucket: process.env['S3_BUCKET_PROTECTED'] ?? 'pcu-protected',
};

const logger = {
	log() {},
	info() {},
	error() {},
};

function checksum(bytes: Buffer): string {
	return createHash('sha256').update(bytes).digest('hex');
}

describe.runIf(enabled)('WebGL deletion lifecycle with PostgreSQL and Garage', () => {
	let prisma: PrismaClient;
	let actorId = 0;
	let exhibitionId = 0;
	const marker = `project-delete-${randomUUID()}`;
	const projectIds: number[] = [];
	const sessionIds: string[] = [];
	const s3 = createS3Client({
		S3_ENDPOINT: process.env['S3_ENDPOINT'] ?? 'http://127.0.0.1:3900',
		S3_REGION: process.env['S3_REGION'] ?? 'garage',
		S3_ACCESS_KEY_ID: process.env['S3_ACCESS_KEY_ID'] ?? 'GK000000000000000000000001',
		S3_SECRET_ACCESS_KEY: process.env['S3_SECRET_ACCESS_KEY']
			?? '0000000000000000000000000000000000000000000000000000000000000001',
		S3_FORCE_PATH_STYLE: true,
	});
	const storage = createObjectStorage(s3, { defaultPresignTtlSec: 60 });

	beforeAll(async () => {
		const databaseUrl = process.env['DATABASE_URL'];
		if (!databaseUrl) throw new Error('DATABASE_URL is required');
		prisma = createPrismaClientForDatabase(databaseUrl);
		await prisma.$connect();
		await prisma.storageBucket.upsert({
			where: { bucket: buckets.publicBucket },
			create: { bucket: buckets.publicBucket, visibility: 'PUBLIC' },
			update: { visibility: 'PUBLIC' },
		});
		await prisma.storageBucket.upsert({
			where: { bucket: buckets.protectedBucket },
			create: { bucket: buckets.protectedBucket, visibility: 'PROTECTED' },
			update: { visibility: 'PROTECTED' },
		});
		const actor = await prisma.user.create({
			data: {
				googleSub: marker,
				email: `${marker}@example.test`,
				name: 'Project deletion lifecycle actor',
				role: 'ADMIN',
			},
		});
		actorId = actor.id;
		const exhibition = await prisma.exhibition.create({
			data: {
				year: 40_000 + (actor.id % 10_000),
				title: marker,
			},
		});
		exhibitionId = exhibition.id;
	});

	afterAll(async () => {
		if (!prisma) return;
		await prisma.uploadIntent.deleteMany({
			where: { storageKey: { startsWith: marker } },
		}).catch(() => undefined);
		await prisma.orphanObject.deleteMany({
			where: { storageKey: { startsWith: marker } },
		}).catch(() => undefined);
		await prisma.multipartAbortTask.deleteMany({
			where: { storageKey: { startsWith: marker } },
		}).catch(() => undefined);
		await prisma.assetUploadSession.deleteMany({
			where: { id: { in: sessionIds } },
		}).catch(() => undefined);
		await prisma.project.deleteMany({
			where: { id: { in: projectIds } },
		}).catch(() => undefined);
		if (exhibitionId) await prisma.exhibition.deleteMany({
			where: { id: exhibitionId },
		}).catch(() => undefined);
		if (actorId) await prisma.user.deleteMany({ where: { id: actorId } }).catch(() => undefined);
		for (const bucket of [buckets.publicBucket, buckets.protectedBucket]) {
			const keys = await storage.listKeys(bucket, marker).catch(() => []);
			if (keys.length > 0) await storage.deleteKeys(bucket, keys).catch(() => undefined);
		}
		await prisma.$disconnect();
		s3.destroy();
	});

	async function createProject(label: string) {
		const project = await prisma.project.create({
			data: {
				exhibitionId,
				creatorId: actorId,
				slug: `${marker}-${label}`,
				title: label,
				status: 'PUBLISHED',
			},
		});
		projectIds.push(project.id);
		return project;
	}

	async function upload(bucket: string, key: string, bytes: Buffer, contentType: string) {
		await storage.upload(bucket, key, bytes, contentType, bytes.length);
	}

	async function readyWebglProject(label: string) {
		const project = await createProject(label);
		const deploymentId = randomUUID();
		const sourceKey = `${marker}/${label}/source.zip`;
		const prefix = `${marker}/${label}/site/`;
		const entryKey = `${prefix}index.html`;
		const buildKey = `${prefix}Build/game.wasm`;
		const sourceBytes = Buffer.from(`${label}:source`);
		const entryBytes = Buffer.from(`<html>${label}</html>`);
		const buildBytes = Buffer.from(`${label}:wasm`);
		await Promise.all([
			upload(buckets.protectedBucket, sourceKey, sourceBytes, 'application/zip'),
			upload(buckets.publicBucket, entryKey, entryBytes, 'text/html; charset=utf-8'),
			upload(buckets.publicBucket, buildKey, buildBytes, 'application/wasm'),
		]);
		const manifest: WebglPublishedObjectManifest = {
			version: 1,
			objects: [
				{
					objectKey: entryKey,
					sizeBytes: String(entryBytes.length),
					mimeType: 'text/html; charset=utf-8',
					contentEncoding: null,
					etag: null,
					checksumSha256: checksum(entryBytes),
				},
				{
					objectKey: buildKey,
					sizeBytes: String(buildBytes.length),
					mimeType: 'application/wasm',
					contentEncoding: null,
					etag: null,
					checksumSha256: checksum(buildBytes),
				},
			],
		};
		const result = await prisma.$transaction(async (tx) => {
			const asset = await tx.asset.create({
				data: {
					projectId: project.id,
					kind: 'WEBGL',
					status: 'READY',
					originalName: `${label}.zip`,
				},
			});
			const representation = await tx.assetRepresentation.create({
				data: {
					assetId: asset.id,
					role: 'WEBGL_SOURCE',
					bucket: buckets.protectedBucket,
					objectKey: sourceKey,
					mimeType: 'application/zip',
					sizeBytes: BigInt(sourceBytes.length),
					state: 'READY',
					sourceIdentityAlgorithm: 'SHA256',
					sourceIdentity: checksum(sourceBytes),
				},
			});
			const deployment = await tx.webglDeployment.create({
				data: {
					id: deploymentId,
					projectId: project.id,
					sourceRepresentationId: representation.id,
					publicBucket: buckets.publicBucket,
					publicPrefix: prefix,
					entryObjectKey: entryKey,
					objectManifest: manifest as unknown as Prisma.InputJsonValue,
					state: 'READY',
				},
			});
			await tx.project.update({
				where: { id: project.id },
				data: { currentWebglDeploymentId: deployment.id },
			});
			const session = await tx.assetUploadSession.create({
				data: {
					id: randomUUID(),
					projectId: project.id,
					userId: actorId,
					kind: 'WEBGL',
					state: 'READY',
					originalName: `${label}.zip`,
					declaredMimeType: 'application/zip',
					totalBytes: BigInt(sourceBytes.length),
					partSizeBytes: sourceBytes.length,
					totalParts: 1,
					bucket: buckets.protectedBucket,
					objectKey: sourceKey,
					generation: 1,
					sourceIdentityAlgorithm: 'SHA256',
					sourceIdentity: checksum(sourceBytes),
					sourceIdentityBlockSizeBytes: sourceBytes.length,
					sourceIdentityBlockManifest: '',
					resultAssetId: asset.id,
					resultRepresentationId: representation.id,
					reservedWebglDeploymentId: deployment.id,
					completionResult: {
						status: 'READY',
						assetId: asset.id,
						representationId: representation.id,
						deploymentId: deployment.id,
					},
					expiresAt: new Date(Date.now() + 60_000),
					completedAt: new Date(),
				},
			});
			return { asset, representation, deployment, session };
		});
		sessionIds.push(result.session.id);
		return {
			project,
			...result,
			manifest,
			sourceKey,
			entryKey,
			buildKey,
		};
	}

	async function readyGameAsset(projectId: number, label: string) {
		const objectKey = `${marker}/${label}/game.zip`;
		const bytes = Buffer.from(`${label}:game`);
		await upload(buckets.protectedBucket, objectKey, bytes, 'application/zip');
		const asset = await prisma.asset.create({
			data: {
				projectId,
				kind: 'GAME',
				status: 'READY',
				originalName: `${label}.zip`,
				representations: {
					create: {
						role: 'ORIGINAL',
						bucket: buckets.protectedBucket,
						objectKey,
						mimeType: 'application/zip',
						sizeBytes: BigInt(bytes.length),
						state: 'READY',
						sourceIdentityAlgorithm: 'SHA256',
						sourceIdentity: checksum(bytes),
					},
				},
			},
		});
		return { asset, objectKey };
	}

	async function verifyingWebglProject(label: string) {
		const project = await createProject(label);
		const sourceKey = `${marker}/${label}/source.zip`;
		const prefix = `${marker}/${label}/site/`;
		const entryKey = `${prefix}index.html`;
		const sourceBytes = Buffer.from(`${label}:source`);
		await upload(buckets.protectedBucket, sourceKey, sourceBytes, 'application/zip');
		const token = randomUUID();
		const deploymentId = randomUUID();
		const result = await prisma.$transaction(async (tx) => {
			const asset = await tx.asset.create({
				data: { projectId: project.id, kind: 'WEBGL', status: 'PROCESSING', originalName: `${label}.zip` },
			});
			const representation = await tx.assetRepresentation.create({
				data: {
					assetId: asset.id, role: 'WEBGL_SOURCE', bucket: buckets.protectedBucket,
					objectKey: sourceKey, mimeType: 'application/zip', sizeBytes: BigInt(sourceBytes.length),
					state: 'VERIFYING', sourceIdentityAlgorithm: 'SHA256', sourceIdentity: checksum(sourceBytes),
				},
			});
			const deployment = await tx.webglDeployment.create({
				data: {
					id: deploymentId, projectId: project.id, sourceRepresentationId: representation.id,
					publicBucket: buckets.publicBucket, publicPrefix: prefix, entryObjectKey: entryKey,
					state: 'PROCESSING',
				},
			});
			const session = await tx.assetUploadSession.create({
				data: {
					id: randomUUID(), projectId: project.id, userId: actorId, kind: 'WEBGL', state: 'VERIFYING',
					originalName: `${label}.zip`, declaredMimeType: 'application/zip',
					totalBytes: BigInt(sourceBytes.length), partSizeBytes: sourceBytes.length, totalParts: 1,
					bucket: buckets.protectedBucket, objectKey: sourceKey, generation: 1,
					sourceIdentityAlgorithm: 'SHA256', sourceIdentity: checksum(sourceBytes),
					sourceIdentityBlockSizeBytes: sourceBytes.length, sourceIdentityBlockManifest: '',
					validationLeaseToken: token, validationLeaseUntil: new Date(Date.now() + 60_000),
					resultAssetId: asset.id, resultRepresentationId: representation.id,
					reservedWebglDeploymentId: deployment.id,
					completionResult: { webglReservation: { expectedCurrentDeploymentId: null } },
					expiresAt: new Date(Date.now() + 60_000),
				},
			});
			return { asset, representation, deployment, session };
		});
		sessionIds.push(result.session.id);
		const entryBytes = Buffer.from(`<html>${label}</html>`);
		await upload(buckets.publicBucket, entryKey, entryBytes, 'text/html; charset=utf-8');
		const manifest: WebglPublishedObjectManifest = {
			version: 1,
			objects: [{
				objectKey: entryKey,
				sizeBytes: String(entryBytes.length),
				mimeType: 'text/html; charset=utf-8',
				contentEncoding: null,
				etag: null,
				checksumSha256: checksum(entryBytes),
			}],
		};
		return { project, ...result, token, sourceKey, prefix, entryKey, manifest };
	}

	function projectRepository() {
		return createProjectCrudRepository(prisma, buckets);
	}

	function orphanWorker() {
		return createOrphanService({
			clock: { now: () => new Date() },
			storage,
			repository: createOrphanRepository(prisma),
			references: createObjectReferenceResolver(prisma, buckets, logger),
			ids: { next: randomUUID },
			logger,
		});
	}

	it('deletes READY source/manifest bytes while preserving the project, unrelated assets, and session audit', async () => {
		const target = await readyWebglProject('ready-target');
		const targetGame = await readyGameAsset(target.project.id, 'ready-target-independent');
		const unrelated = await readyWebglProject('ready-unrelated');
		const blockedKey = target.buildKey;
		const intent = await prisma.uploadIntent.create({
			data: {
				id: randomUUID(),
				bucket: buckets.publicBucket,
				storageKey: blockedKey,
				purpose: 'crash-before-reference-commit',
				ownerOperationId: target.session.id,
				ownerActorId: actorId,
				ownerProjectId: target.project.id,
				state: 'PREPARED',
				notBefore: new Date(Date.now() + 60_000),
			},
		});

		await projectRepository().clearWebglDeployment(target.project.id, {
			...buckets,
			reason: 'integration-webgl-delete',
		});
		await expect(prisma.project.findUniqueOrThrow({ where: { id: target.project.id } }))
			.resolves.toMatchObject({ id: target.project.id, currentWebglDeploymentId: null });
		expect(await prisma.webglDeployment.findUnique({ where: { id: target.deployment.id } })).toBeNull();
		expect(await prisma.assetRepresentation.findUnique({ where: { id: target.representation.id } })).toBeNull();
		expect(await prisma.asset.findUnique({ where: { id: target.asset.id } })).toBeNull();
		await expect(prisma.asset.findUniqueOrThrow({ where: { id: targetGame.asset.id } }))
			.resolves.toMatchObject({ id: targetGame.asset.id, projectId: target.project.id, status: 'READY' });
		await expect(prisma.project.findUniqueOrThrow({ where: { id: unrelated.project.id } }))
			.resolves.toMatchObject({ id: unrelated.project.id });
		await expect(prisma.asset.findUniqueOrThrow({ where: { id: unrelated.asset.id } }))
			.resolves.toMatchObject({ id: unrelated.asset.id, status: 'READY' });
		await expect(prisma.assetUploadSession.findUniqueOrThrow({ where: { id: target.session.id } }))
			.resolves.toMatchObject({
				state: 'READY',
				projectId: target.project.id,
				exhibitionId: null,
				resultAssetId: null,
				resultRepresentationId: null,
				reservedWebglDeploymentId: null,
				userId: actorId,
				completionResult: {
					status: 'READY',
					assetId: target.asset.id,
					representationId: target.representation.id,
					deploymentId: target.deployment.id,
				},
			});

		await orphanWorker().runOrphanReaper();
		await expect(prisma.orphanObject.findUniqueOrThrow({
			where: { orphan_bucket_storage_key: { bucket: buckets.publicBucket, storageKey: blockedKey } },
		})).resolves.toMatchObject({ state: 'CANCELLED', cancelReason: 'live-reference-detected' });
		expect(await storage.head(buckets.protectedBucket, target.sourceKey)).toBeNull();
		expect(await storage.head(buckets.publicBucket, target.entryKey)).toBeNull();
		expect(await storage.head(buckets.publicBucket, blockedKey)).not.toBeNull();
		expect(await storage.head(buckets.protectedBucket, targetGame.objectKey)).not.toBeNull();
		expect(await storage.head(buckets.protectedBucket, unrelated.sourceKey)).not.toBeNull();
		expect(await storage.head(buckets.publicBucket, unrelated.entryKey)).not.toBeNull();

		await prisma.uploadIntent.update({ where: { id: intent.id }, data: { state: 'RESOLVED' } });
		// Garage reports LastModified at whole-second precision. By reconciliation
		// time this wall-clock instant is later, while remaining immediately claimable.
		const startedAt = new Date();
		await expect(reconcileObjects({
			prisma,
			storage,
			...buckets,
			options: parseReconcileOptions([
				'--apply',
				'--older-than-minutes=0',
				`--exact-target=${buckets.publicBucket}:${blockedKey}`,
			], startedAt),
			logger,
		})).resolves.toEqual({ scanned: 1, eligible: 1, enqueued: 1, skippedUnknownAge: 0 });
		await orphanWorker().runOrphanReaper();

		expect(await storage.head(buckets.publicBucket, blockedKey)).toBeNull();
		const outbox = await prisma.orphanObject.findMany({
			where: {
				OR: [
					{ bucket: buckets.protectedBucket, storageKey: target.sourceKey },
					{ bucket: buckets.publicBucket, storageKey: { in: [target.entryKey, target.buildKey] } },
				],
			},
		});
		expect(outbox).toHaveLength(3);
		expect(outbox.every(({ state, resolvedAt }) => state === 'RESOLVED' && resolvedAt !== null)).toBe(true);
	});

	it('fences a validation commit after WebGL deletion wins first', async () => {
		const target = await verifyingWebglProject('delete-first');
		await projectRepository().clearWebglDeployment(target.project.id, {
			...buckets,
			reason: 'integration-delete-first',
		});

		await expect(createWebglProcessingRepository(prisma).commitReady({
			sessionId: target.session.id,
			generation: 1,
			claimToken: target.token,
			deploymentId: target.deployment.id,
			expectedCurrentDeploymentId: null,
			assetId: target.asset.id,
			representationId: target.representation.id,
			representationUpdatedAt: target.representation.updatedAt,
			objectManifest: target.manifest,
		})).rejects.toThrow(/validation lease was lost|not found/i);
		await expect(prisma.assetUploadSession.findUniqueOrThrow({ where: { id: target.session.id } }))
			.resolves.toMatchObject({
				state: 'CANCELLED',
				projectId: target.project.id,
				resultAssetId: null,
				resultRepresentationId: null,
				reservedWebglDeploymentId: null,
				validationLeaseToken: null,
				validationLeaseUntil: null,
			});
		await expect(prisma.project.findUniqueOrThrow({ where: { id: target.project.id } }))
			.resolves.toMatchObject({ id: target.project.id, currentWebglDeploymentId: null });
		expect(await prisma.webglDeployment.findUnique({ where: { id: target.deployment.id } })).toBeNull();
		expect(await prisma.asset.findUnique({ where: { id: target.asset.id } })).toBeNull();
	});

	it('captures the committed generation when validation wins before deletion', async () => {
		const target = await verifyingWebglProject('commit-first');
		await expect(createWebglProcessingRepository(prisma).commitReady({
			sessionId: target.session.id,
			generation: 1,
			claimToken: target.token,
			deploymentId: target.deployment.id,
			expectedCurrentDeploymentId: null,
			assetId: target.asset.id,
			representationId: target.representation.id,
			representationUpdatedAt: target.representation.updatedAt,
			objectManifest: target.manifest,
		})).resolves.toBe('COMMITTED');

		await projectRepository().clearWebglDeployment(target.project.id, {
			...buckets,
			reason: 'integration-commit-first',
		});
		await expect(prisma.assetUploadSession.findUniqueOrThrow({ where: { id: target.session.id } }))
			.resolves.toMatchObject({
				state: 'READY',
				projectId: target.project.id,
				resultAssetId: null,
				resultRepresentationId: null,
				reservedWebglDeploymentId: null,
			});
		await expect(prisma.project.findUniqueOrThrow({ where: { id: target.project.id } }))
			.resolves.toMatchObject({ id: target.project.id, currentWebglDeploymentId: null });
		expect(await prisma.webglDeployment.findUnique({ where: { id: target.deployment.id } })).toBeNull();
		expect(await prisma.asset.findUnique({ where: { id: target.asset.id } })).toBeNull();
		await expect(prisma.orphanObject.findUniqueOrThrow({
			where: {
				orphan_bucket_storage_key: {
					bucket: buckets.protectedBucket,
					storageKey: target.sourceKey,
				},
			},
		})).resolves.toMatchObject({ state: 'PENDING', targetKind: 'EXACT' });
		await expect(prisma.orphanObject.findUniqueOrThrow({
			where: {
				orphan_bucket_storage_key: {
					bucket: buckets.publicBucket,
					storageKey: target.entryKey,
				},
			},
		})).resolves.toMatchObject({ state: 'PENDING', targetKind: 'EXACT' });
		await orphanWorker().runOrphanReaper();
		expect(await storage.head(buckets.protectedBucket, target.sourceKey)).toBeNull();
		expect(await storage.head(buckets.publicBucket, target.entryKey)).toBeNull();
		await expect(prisma.assetUploadSession.findUniqueOrThrow({ where: { id: target.session.id } }))
			.resolves.toMatchObject({ state: 'READY', projectId: target.project.id });
	});
});
