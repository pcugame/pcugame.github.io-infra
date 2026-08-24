import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { DeleteObjectsCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createS3Client } from '../lib/s3.js';
import { createDirectMultipartControlStorage, createObjectStorage, createProtectedDownloadPresigner } from '../lib/storage.js';
import { createCanonicalBackfillProgress, runCanonicalBackfill } from '../modules/migration/canonical-backfill.js';
import { createCanonicalBackfillRepository } from '../modules/migration/canonical-backfill.prisma.js';
import { createCanonicalObjectMaterializer } from '../infrastructure/canonical-object-migration.s3.js';
import { runContractPreflight } from '../modules/migration/contract-preflight.js';
import { createContractPreflightRepository } from '../modules/migration/contract-preflight.prisma.js';
import { createAssetsRepository } from '../modules/assets/repository.js';
import { createAssetsService } from '../modules/assets/service.js';
import { createAssetsController } from '../modules/assets/controller.js';
import { createAssetUploadRepository } from '../modules/asset-upload/repository.js';
import { createAssetUploadService } from '../modules/asset-upload/service.js';
import {
	SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
	SOURCE_IDENTITY_ALGORITHM,
	sourceIdentityRoot,
} from '../modules/admin/game-upload/source-identity.js';
import {
	LEGACY_MIGRATION_FIXTURE_NAMESPACE,
	legacyCanonicalMigrationExpected,
	legacyCanonicalMigrationFixture,
	legacyCanonicalMigrationObjectInventory,
} from './fixtures/legacy-canonical-migration.js';

const enabled = process.env['RUN_POSTGRES_INTEGRATION'] === 'true'
	&& process.env['RUN_GARAGE_INTEGRATION'] === 'true';
const migrationsUrl = new URL('../../prisma/migrations/', import.meta.url);
const contractMigration = '20260822000000_canonical_asset_contract';
const canonicalExpandMigration = '20260821000000_canonical_asset_expand';
const legacyBridgeMetricNames = [
	'asset_download_legacy_fallback', 'asset_download_legacy_route', 'public_image_legacy_bridge',
	'public_image_legacy_fallback', 'public_webgl_legacy_bridge', 'public_webgl_legacy_fallback', 'export_legacy_fallback',
] as const;
const buckets = {
	protectedBucket: process.env['S3_BUCKET_PROTECTED'] ?? 'pcu-protected',
	publicBucket: process.env['S3_BUCKET_PUBLIC'] ?? 'pcu-public',
};

function directSourceProof(bytes: Buffer) {
	const digests = [createHash('sha256').update(bytes).digest('hex')];
	return {
		sourceIdentityAlgorithm: SOURCE_IDENTITY_ALGORITHM,
		sourceIdentity: sourceIdentityRoot(bytes.length, SOURCE_IDENTITY_BLOCK_SIZE_BYTES, digests),
		sourceIdentityBlockSizeBytes: SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
		sourceIdentityBlockDigests: digests,
	};
}

async function exerciseCanonicalHttpAndDataPlane(input: {
	client: PrismaClient;
	storage: ReturnType<typeof createObjectStorage>;
	presigner: ReturnType<typeof createProtectedDownloadPresigner>;
	assetId: number;
	expectedBytes: bigint;
}): Promise<void> {
	const service = createAssetsService({
		presignTtlSec: 60,
		presign: (bucket, key, options) => input.presigner.presign(bucket, key, options),
		wakeDeletionWorker() {},
		loadProjectWithAccess: async () => undefined,
		downloadLimiter: { check: () => 'ok' as const },
		logger: { info() {}, error() {} },
		repository: createAssetsRepository(input.client),
	});
	const app = Fastify();
	await app.register(createAssetsController({ service }), { prefix: '/api' });
	await app.ready();
	try {
		const response = await app.inject({
			method: 'GET', url: `/api/assets/${input.assetId}/download?variant=original`,
		});
		expect(response.statusCode).toBe(302);
		expect(response.body).toBe('');
		const location = response.headers.location;
		expect(location).toBeTruthy();
		const direct = await fetch(location!, { headers: { Range: 'bytes=0-0' } });
		expect(direct.status).toBe(206);
		expect(direct.headers.get('content-range')).toBe(`bytes 0-0/${input.expectedBytes}`);
		expect((await direct.arrayBuffer()).byteLength).toBe(1);
	} finally {
		await app.close();
	}
}

async function exerciseFiveKindDirectControls(input: {
	client: PrismaClient;
	s3: ReturnType<typeof createS3Client>;
}): Promise<void> {
	const repository = createAssetUploadRepository(input.client);
	const storage = createDirectMultipartControlStorage(input.s3);
	const actor = { id: 41_011, role: 'ADMIN' } as const;
	const service = createAssetUploadService({
		repository,
		storage,
		partSigner: { presignUploadPart: async () => 'https://unused.example.test/upload-part' },
		clock: { now: () => new Date() },
		ids: { next: () => randomUUID() },
		config: {
			bucket: buckets.protectedBucket,
			sessionTtlMs: 60_000,
			partSizeBytes: 5 * 1024 * 1024,
			partUrlTtlSeconds: 60,
			partUrlRefreshMax: 5,
			maxBytesFor: () => 10 * 1024 * 1024,
		},
		authorizeProjectWrite: async () => ({ exhibitionId: 41_001, status: 'PUBLISHED' }),
		authorizeExhibitionWrite: async () => undefined,
	});
	const bytes = Buffer.from('canonical direct control fixture');
	const proof = directSourceProof(bytes);
	const requests = [
		{ kind: 'GAME', create: () => service.createGameSession(actor, 41_021, { originalName: 'game.zip', totalBytes: bytes.length, ...proof }) },
		{ kind: 'WEBGL', create: () => service.createWebglSession(actor, 41_021, { originalName: 'webgl.zip', totalBytes: bytes.length, ...proof }) },
		{ kind: 'VIDEO', create: () => service.createVideoSession(actor, 41_021, { originalName: 'video.mov', declaredMimeType: 'video/quicktime', totalBytes: bytes.length, ...proof }) },
		{ kind: 'IMAGE', create: () => service.createImageSession(actor, 41_021, { originalName: 'image.png', declaredMimeType: 'image/png', totalBytes: bytes.length, ...proof }) },
		{ kind: 'POSTER', create: () => service.createProjectPosterSession(actor, 41_021, { originalName: 'poster.pdf', declaredMimeType: 'application/pdf', totalBytes: bytes.length, ...proof }) },
	] as const;
	const sessionIds: string[] = [];
	for (const request of requests) {
		const created = await request.create();
		sessionIds.push(created.sessionId);
		const session = await repository.findById(created.sessionId);
		expect(session).toMatchObject({ kind: request.kind, state: 'UPLOADING', generation: 1 });
		expect(session?.objectKey).toMatch(/^protected\/uploads\/[^/]+\/1\/source\.(zip|bin)$/);
		await service.cancel(actor, created.sessionId);
		await storage.abortMultipart(session!.bucket, session!.objectKey, session!.uploadId!);
	}
	const rows = await input.client.$queryRaw<Array<{ kind: string; state: string }>>(Prisma.sql`
		SELECT "kind"::text AS "kind", "state"::text AS "state"
		FROM "asset_upload_sessions" WHERE "id" IN (${Prisma.join(sessionIds)})
		ORDER BY "kind"::text
	`);
	expect(rows).toEqual([
		{ kind: 'GAME', state: 'CANCELLED' },
		{ kind: 'IMAGE', state: 'CANCELLED' },
		{ kind: 'POSTER', state: 'CANCELLED' },
		{ kind: 'VIDEO', state: 'CANCELLED' },
		{ kind: 'WEBGL', state: 'CANCELLED' },
	]);
}

async function exerciseRenditionObjectBeforeDbCrash(input: {
	client: PrismaClient;
	s3: ReturnType<typeof createS3Client>;
	storage: ReturnType<typeof createObjectStorage>;
	schema: string;
}): Promise<void> {
	const assetId = 42_999;
	const sourceKey = `${LEGACY_MIGRATION_FIXTURE_NAMESPACE}/${input.schema}/crash-repair-source.png`;
	const canonicalPrefix = `public/images/${assetId}/`;
	const source = await sharp({
		create: { width: 1_200, height: 800, channels: 3, background: '#123456' },
	}).png().toBuffer();
	await input.s3.send(new PutObjectCommand({
		Bucket: buckets.publicBucket, Key: sourceKey, Body: source,
		ContentLength: source.byteLength, ContentType: 'image/png',
	}));
	try {
		await input.client.$executeRaw(Prisma.sql`
			INSERT INTO "assets" (
				"id", "project_id", "kind", "status", "storage_key", "original_name", "mime_type",
				"size_bytes", "is_public", "width", "height", "card_480_height", "display_960_height", "updated_at"
			) VALUES (
				${assetId}, 41022, 'IMAGE'::"AssetKind", 'READY'::"AssetStatus", ${sourceKey},
				'crash-repair-source.png', 'image/png', ${BigInt(source.byteLength)}, true,
				1200, 800, NULL, NULL, CURRENT_TIMESTAMP
			)
		`);
		const verifier = {
			async head(bucket: string, key: string) {
				const value = await input.storage.head(bucket, key);
				return value ? {
					size: BigInt(value.size), mimeType: value.contentType,
					...(value.etag ? { etag: value.etag } : {}),
					...(value.checksumSha256 ? { checksumSha256: value.checksumSha256 } : {}),
				} : null;
			},
			async listPrefix(bucket: string, prefix: string, afterKey: string | undefined, limit: number) {
				const page = await input.storage.listKeyPage(bucket, prefix, {
					...(afterKey ? { startAfter: afterKey } : {}), maxKeys: limit,
				});
				return { keys: page.keys, isTruncated: page.isTruncated };
			},
		};
		const repository = createCanonicalBackfillRepository(input.client);
		let injectFailure = true;
		const first = await runCanonicalBackfill({
			repository: {
				...repository,
				applyAsset(plan) {
					if (plan.row.id === assetId && injectFailure) {
						injectFailure = false;
						throw new Error('injected object-before-DB crash');
					}
					return repository.applyAsset(plan);
				},
			},
			verifier,
			materializer: createCanonicalObjectMaterializer(input.s3, {
				tempRoot: `/tmp/${LEGACY_MIGRATION_FIXTURE_NAMESPACE}-${input.schema}`,
			}),
			...buckets,
			progress: createCanonicalBackfillProgress('apply'),
			options: { apply: true, batchSize: 100 },
		});
		expect(first.failures).toEqual([
			expect.objectContaining({ ref: { kind: 'asset', id: assetId }, code: 'CANONICAL_CONFLICT' }),
		]);
		const pending = await input.client.$queryRaw<Array<{ storageKey: string; state: string }>>(Prisma.sql`
			SELECT "storage_key" AS "storageKey", "state"::text AS "state"
			FROM "orphan_objects" WHERE "bucket" = ${buckets.publicBucket}
				AND "storage_key" LIKE ${`${canonicalPrefix}%`} ORDER BY "storage_key"
		`);
		expect(pending).toHaveLength(3);
		expect(pending.every((target) => target.state === 'PENDING')).toBe(true);

		const rerun = await runCanonicalBackfill({
			repository, verifier,
			materializer: createCanonicalObjectMaterializer(input.s3, {
				tempRoot: `/tmp/${LEGACY_MIGRATION_FIXTURE_NAMESPACE}-${input.schema}`,
			}),
			...buckets, progress: first.progress,
			options: { apply: true, batchSize: 100 },
		});
		expect(rerun.failures).toHaveLength(0);
		expect(rerun.stats).toMatchObject({ imageRepairs: 0, objectsReused: 3 });
		const cancelled = await input.client.$queryRaw<Array<{ storageKey: string; state: string }>>(Prisma.sql`
			SELECT "storage_key" AS "storageKey", "state"::text AS "state"
			FROM "orphan_objects" WHERE "bucket" = ${buckets.publicBucket}
				AND "storage_key" LIKE ${`${canonicalPrefix}%`} ORDER BY "storage_key"
		`);
		expect(cancelled).toHaveLength(3);
		expect(cancelled.every((target) => target.state === 'CANCELLED')).toBe(true);
	} finally {
		await input.client.$executeRaw(Prisma.sql`DELETE FROM "assets" WHERE "id" = ${assetId}`).catch(() => undefined);
		await input.client.$executeRaw(Prisma.sql`
			DELETE FROM "orphan_objects" WHERE "bucket" = ${buckets.publicBucket}
				AND "storage_key" LIKE ${`${canonicalPrefix}%`}
		`).catch(() => undefined);
		await input.client.$executeRaw(Prisma.sql`
			DELETE FROM "canonical_object_relocations" WHERE "work_kind" = 'asset' AND "work_ref" = ${String(assetId)}
		`).catch(() => undefined);
		const canonicalKeys = await input.storage.listKeys(buckets.publicBucket, canonicalPrefix).catch(() => []);
		await input.s3.send(new DeleteObjectsCommand({
			Bucket: buckets.publicBucket,
			Delete: { Objects: [sourceKey, ...canonicalKeys].map((Key) => ({ Key })) },
		})).catch(() => undefined);
	}
}

function quoted(identifier: string): string { return `"${identifier.replaceAll('"', '""')}"`; }

async function applyMigration(databaseUrl: string, schema: string, directory: string): Promise<void> {
	const sql = await readFile(new URL(`${directory}/migration.sql`, migrationsUrl), 'utf8');
	const connection = createPrismaClientForDatabase(databaseUrl);
	try {
		await connection.$connect();
		await connection.$executeRawUnsafe(`SET search_path TO ${quoted(schema)};\n${sql}`);
	} finally { await connection.$disconnect(); }
}

async function seedLegacy(client: PrismaClient): Promise<void> {
	const fixture = legacyCanonicalMigrationFixture;
	for (const user of fixture.users) {
		await client.$executeRaw(Prisma.sql`
			INSERT INTO "users" ("id", "google_sub", "email", "student_id", "name", "picture", "role", "updated_at")
			VALUES (${user.id}, ${user.googleSub}, ${user.email}, ${user.studentId}, ${user.name}, '', ${user.role}::"UserRole", CURRENT_TIMESTAMP)
		`);
	}
	for (const exhibition of fixture.exhibitions) {
		await client.$executeRaw(Prisma.sql`
			INSERT INTO "exhibitions" (
				"id", "year", "title", "is_upload_enabled", "sort_order", "poster_storage_key",
				"poster_original_name", "poster_mime_type", "poster_size_bytes", "poster_width", "poster_height",
				"poster_card_480_height", "poster_display_960_height", "updated_at"
			) VALUES (
				${exhibition.id}, ${exhibition.year}, ${exhibition.title}, ${exhibition.isUploadEnabled}, ${exhibition.sortOrder},
				${exhibition.posterStorageKey}, ${exhibition.posterOriginalName}, ${exhibition.posterMimeType},
				${exhibition.posterSizeBytes}, ${exhibition.posterWidth}, ${exhibition.posterHeight},
				${exhibition.posterCard480Height}, ${exhibition.posterDisplay960Height}, CURRENT_TIMESTAMP
			)
		`);
	}
	for (const project of fixture.projects) {
		await client.$executeRaw(Prisma.sql`
			INSERT INTO "projects" (
				"id", "exhibition_id", "slug", "title", "status", "creator_id", "poster_asset_id",
				"webgl_entry_key", "updated_at"
			) VALUES (
				${project.id}, ${project.exhibitionId}, ${project.slug}, ${project.title}, ${project.status}::"ProjectStatus",
				${project.creatorId}, NULL, '', CURRENT_TIMESTAMP
			)
		`);
	}
	for (const asset of fixture.assets) {
		await client.$executeRaw(Prisma.sql`
			INSERT INTO "assets" (
				"id", "project_id", "kind", "status", "storage_key", "playback_storage_key",
				"original_name", "mime_type", "playback_mime_type", "size_bytes", "playback_size_bytes",
				"playback_status", "is_public", "width", "height", "card_480_height", "display_960_height", "updated_at"
			) VALUES (
				${asset.id}, ${asset.projectId}, ${asset.kind}::"AssetKind", ${asset.status}::"AssetStatus",
				${asset.storageKey}, ${asset.playbackStorageKey}, ${asset.originalName}, ${asset.mimeType},
				${asset.playbackMimeType}, ${asset.sizeBytes}, ${asset.playbackSizeBytes},
				${asset.playbackStatus}::"AssetPlaybackStatus", ${asset.isPublic}, ${asset.width}, ${asset.height},
				${asset.card480Height}, ${asset.display960Height}, CURRENT_TIMESTAMP
			)
		`);
	}
	for (const session of fixture.gameUploadSessions) {
		await client.$executeRaw(Prisma.sql`
			INSERT INTO "game_upload_sessions" (
				"id", "project_id", "user_id", "upload_kind", "original_name", "total_bytes", "chunk_size_bytes",
				"total_chunks", "uploaded_chunks", "status", "staging_path", "storage_key", "s3_upload_id", "s3_key",
				"s3_part_etags", "multipart_generation", "completion_result", "expires_at", "updated_at"
			) VALUES (
				${session.id}, ${session.projectId}, ${session.userId}, ${session.uploadKind}::"UploadKind",
				${session.originalName}, ${session.totalBytes}, ${session.chunkSizeBytes}, ${session.totalChunks},
				${session.uploadedChunks}, ${session.status}, ${session.stagingPath}, ${session.storageKey},
				${session.s3UploadId}, ${session.s3Key}, ${JSON.stringify(session.s3PartEtags)}::jsonb,
				${session.multipartGeneration}, ${JSON.stringify(session.completionResult)}::jsonb,
				${session.expiresAt}, CURRENT_TIMESTAMP
			)
		`);
	}
	for (const project of fixture.projects) {
		await client.$executeRaw(Prisma.sql`
			UPDATE "projects" SET "poster_asset_id" = ${project.posterAssetId}, "webgl_entry_key" = ${project.webglEntryKey}
			WHERE "id" = ${project.id}
		`);
	}
}

describe.runIf(enabled)('master fixture expand -> backfill -> preflight -> contract', () => {
	let control: PrismaClient;
	let migrationClient: PrismaClient;
	let schema = '';
	let databaseUrl = '';
	const s3 = createS3Client({
		S3_ENDPOINT: process.env['S3_ENDPOINT'] ?? 'http://127.0.0.1:3900',
		S3_REGION: 'garage',
		S3_ACCESS_KEY_ID: 'GK000000000000000000000001',
		S3_SECRET_ACCESS_KEY: '0000000000000000000000000000000000000000000000000000000000000001',
		S3_FORCE_PATH_STYLE: true,
	});
	const uploaded: Array<{ bucket: string; key: string }> = [];
	const presigner = createProtectedDownloadPresigner(s3, { defaultPresignTtlSec: 60 });

	beforeAll(async () => {
		databaseUrl = process.env['DATABASE_URL'] ?? '';
		if (!databaseUrl) throw new Error('DATABASE_URL is required');
		control = createPrismaClientForDatabase(databaseUrl);
		await control.$connect();
		schema = `canonical_chain_${randomUUID().replaceAll('-', '')}`;
		await control.$executeRawUnsafe(`CREATE SCHEMA ${quoted(schema)}`);
		const directories = (await readdir(migrationsUrl, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory() && entry.name !== contractMigration)
			.map((entry) => entry.name).sort();
		const masterDirectories = directories.filter((directory) => directory < canonicalExpandMigration);
		const expandDirectories = directories.filter((directory) => directory >= canonicalExpandMigration);
		for (const directory of masterDirectories) await applyMigration(databaseUrl, schema, directory);
		const url = new URL(databaseUrl);
		url.searchParams.set('schema', schema);
		// Raw migration SQL is deliberately model-free; force PostgreSQL's own
		// search_path because Prisma adapter schema mapping only qualifies ORM SQL.
		url.searchParams.set('options', `-c search_path=${schema}`);
		migrationClient = createPrismaClientForDatabase(url.toString());
		await migrationClient.$connect();
		await seedLegacy(migrationClient);
		for (const directory of expandDirectories) await applyMigration(databaseUrl, schema, directory);
		await migrationClient.storageBucket.upsert({
			where: { bucket: buckets.protectedBucket },
			update: { visibility: 'PROTECTED' },
			create: { bucket: buckets.protectedBucket, visibility: 'PROTECTED' },
		});
		await migrationClient.storageBucket.upsert({
			where: { bucket: buckets.publicBucket },
			update: { visibility: 'PUBLIC' },
			create: { bucket: buckets.publicBucket, visibility: 'PUBLIC' },
		});
		// This test deliberately audits the complete inventory. Remove objects
		// left by the shared integration smoke suite instead of filtering them out.
		const cleanStorage = createObjectStorage(s3, { defaultPresignTtlSec: 60 });
		for (const bucket of [buckets.protectedBucket, buckets.publicBucket]) {
			const keys = await cleanStorage.listKeys(bucket, '');
			for (let offset = 0; offset < keys.length; offset += 1_000) {
				await s3.send(new DeleteObjectsCommand({
					Bucket: bucket,
					Delete: { Objects: keys.slice(offset, offset + 1_000).map((Key) => ({ Key })) },
				}));
			}
		}
		let marker = 1;
		for (const object of legacyCanonicalMigrationObjectInventory) {
			const bucket = object.bucket === 'protected' ? buckets.protectedBucket : buckets.publicBucket;
			let body = Buffer.alloc(Number(object.size), marker++ % 251);
			if (object.key === legacyCanonicalMigrationFixture.assets.find((asset) => asset.id === 42_004)!.storageKey) {
				const validWebp = await sharp({
					create: { width: 1_200, height: 800, channels: 3, background: '#345678' },
				}).webp().toBuffer();
				if (validWebp.byteLength > Number(object.size)) throw new Error('fixture WebP exceeds declared legacy size');
				body = Buffer.concat([validWebp, Buffer.alloc(Number(object.size) - validWebp.byteLength)]);
			}
			await s3.send(new PutObjectCommand({
				Bucket: bucket, Key: object.key, Body: body,
				ContentLength: Number(object.size), ContentType: object.mimeType,
			}));
			uploaded.push({ bucket, key: object.key });
		}
	});

	afterAll(async () => {
		if (uploaded.length > 0) {
			for (const bucket of [buckets.protectedBucket, buckets.publicBucket]) {
				const keys = uploaded.filter((object) => object.bucket === bucket).map((object) => ({ Key: object.key }));
				if (keys.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } })).catch(() => undefined);
			}
		}
		if (migrationClient) await migrationClient.$disconnect().catch(() => undefined);
		if (control && schema) await control.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quoted(schema)} CASCADE`).catch(() => undefined);
		if (control) await control.$disconnect().catch(() => undefined);
		s3.destroy();
	});

	it('never overwrites a concurrently installed canonical physical generation during backfill', async () => {
		const repository = createCanonicalBackfillRepository(migrationClient);
		const row = await repository.getAsset(42_001);
		expect(row).not.toBeNull();
		await migrationClient.$executeRaw(Prisma.sql`
			INSERT INTO "asset_representations" (
				"id", "asset_id", "role", "bucket", "object_key", "mime_type", "size_bytes", "state", "updated_at"
			) VALUES (
				${randomUUID()}, 42001, 'ORIGINAL'::"AssetRepresentationRole", ${buckets.protectedBucket},
				'protected/assets/42001/original/concurrent-generation.zip', 'application/zip', 99,
				'READY'::"AssetRepresentationState", CURRENT_TIMESTAMP
			)
		`);
		try {
			await expect(repository.applyAsset({
				row: row!, imageRepair: null,
				representations: [{
					role: 'ORIGINAL', bucket: buckets.protectedBucket,
					objectKey: row!.storageKey!, mimeType: row!.mimeType, sizeBytes: row!.sizeBytes,
					checksumAlgorithm: null, checksum: null, etag: 'legacy-etag',
					sourceIdentityAlgorithm: 'S3_ETAG_SIZE',
					sourceIdentity: `legacy-etag:${row!.sizeBytes}`,
					width: null, height: null,
				}],
			})).rejects.toThrow('canonical representation conflicts');
			const persisted = await migrationClient.assetRepresentation.findFirstOrThrow({
				where: { assetId: 42_001, role: 'ORIGINAL' }, select: { objectKey: true },
			});
			expect(persisted.objectKey).toBe('protected/assets/42001/original/concurrent-generation.zip');
		} finally {
			await migrationClient.$executeRaw(Prisma.sql`
				DELETE FROM "asset_representations" WHERE "asset_id" = 42001 AND "role" = 'ORIGINAL'::"AssetRepresentationRole"
			`);
		}
	});

	it('converges with exact counts, preserves failed-playback original, and contracts legacy catalog', async () => {
		const storage = createObjectStorage(s3, { defaultPresignTtlSec: 60 });
		const verifier = {
			async head(bucket: string, key: string) {
				const value = await storage.head(bucket, key);
				return value ? { size: BigInt(value.size), mimeType: value.contentType, ...(value.etag ? { etag: value.etag } : {}) } : null;
			},
			async listPrefix(bucket: string, prefix: string, afterKey: string | undefined, limit: number) {
				const page = await storage.listKeyPage(bucket, prefix, { ...(afterKey ? { startAfter: afterKey } : {}), maxKeys: limit });
				return { keys: page.keys, isTruncated: page.isTruncated };
			},
		};
		const repository = createCanonicalBackfillRepository(migrationClient);
		let injectWebglCommitFailure = true;
		const first = await runCanonicalBackfill({
			repository: {
				...repository,
				applyWebgl(plan) {
					if (plan.row.id === 41_022 && injectWebglCommitFailure) {
						injectWebglCommitFailure = false;
						throw new Error('injected copy-before-DB crash');
					}
					return repository.applyWebgl(plan);
				},
			}, verifier,
			materializer: createCanonicalObjectMaterializer(s3, { tempRoot: `/tmp/${LEGACY_MIGRATION_FIXTURE_NAMESPACE}-${schema}` }),
			...buckets, progress: createCanonicalBackfillProgress('apply'), options: { apply: true, batchSize: 2 },
		});
		const copiedKey = legacyCanonicalMigrationExpected.webglDeployment.sourceCanonicalKey;
		uploaded.push({ bucket: buckets.protectedBucket, key: copiedKey });
		const relocatedKeys = await migrationClient.$queryRaw<Array<{ bucket: string; objectKey: string }>>(Prisma.sql`
			SELECT "destination_bucket" AS "bucket", "destination_object_key" AS "objectKey"
			FROM "canonical_object_relocations" ORDER BY "destination_object_key"
		`);
		uploaded.push(...relocatedKeys.map((object) => ({ bucket: object.bucket, key: object.objectKey })));
		const generatedKeys = await migrationClient.$queryRaw<Array<{ bucket: string; objectKey: string }>>(Prisma.sql`
			SELECT r."bucket", r."object_key" AS "objectKey"
			FROM "asset_representations" r
			WHERE r."source_identity_algorithm" = 'MIGRATION_GENERATED_SHA256'
		`);
		uploaded.push(...generatedKeys.map((object) => ({ bucket: object.bucket, key: object.objectKey })));
		expect(first.failures).toEqual([
			expect.objectContaining({ ref: { kind: 'webgl', id: 41_022 }, code: 'CANONICAL_CONFLICT' }),
			expect.objectContaining({ ref: { kind: 'webgl', id: 41_023 }, code: 'MALFORMED_LEGACY_ROW' }),
		]);
		expect(first.stats).toMatchObject({
			assetsCreated: 1, representations: 14, deployments: 0,
			objectCopies: 8, imageRepairs: 2,
		});
		expect(await migrationClient.$queryRaw<Array<{ state: string }>>(Prisma.sql`
			SELECT "state"::text AS "state" FROM "orphan_objects"
			WHERE "bucket" = ${buckets.protectedBucket} AND "storage_key" = ${copiedKey}
		`)).toEqual([{ state: 'PENDING' }]);

		const resumedCopy = await runCanonicalBackfill({
			repository, verifier,
			materializer: createCanonicalObjectMaterializer(s3, { tempRoot: `/tmp/${LEGACY_MIGRATION_FIXTURE_NAMESPACE}-${schema}` }),
			...buckets, progress: first.progress, options: { apply: true, batchSize: 2 },
		});
		expect(resumedCopy.failures).toEqual([
			expect.objectContaining({ ref: { kind: 'webgl', id: 41_023 }, code: 'MALFORMED_LEGACY_ROW' }),
		]);
		expect(resumedCopy.stats).toMatchObject({
			assetsCreated: 1, representations: 1, deployments: 1, objectsReused: 1,
		});
		expect(await migrationClient.$queryRaw<Array<{ state: string }>>(Prisma.sql`
			SELECT "state"::text AS "state" FROM "orphan_objects"
			WHERE "bucket" = ${buckets.protectedBucket} AND "storage_key" = ${copiedKey}
		`)).toEqual([{ state: 'CANCELLED' }]);

		await migrationClient.$executeRaw(Prisma.sql`UPDATE "projects" SET "webgl_entry_key" = '' WHERE "id" = 41023`);
		const reconciled = await runCanonicalBackfill({
			repository, verifier,
			materializer: createCanonicalObjectMaterializer(s3, { tempRoot: `/tmp/${LEGACY_MIGRATION_FIXTURE_NAMESPACE}-${schema}` }),
			...buckets, progress: resumedCopy.progress, options: { apply: true, batchSize: 2 },
		});
		expect(reconciled.failures).toHaveLength(0);
		await exerciseRenditionObjectBeforeDbCrash({
			client: migrationClient,
			s3,
			storage,
			schema,
		});
		const idempotentRerun = await runCanonicalBackfill({
			repository, verifier,
			materializer: createCanonicalObjectMaterializer(s3, {
				tempRoot: `/tmp/${LEGACY_MIGRATION_FIXTURE_NAMESPACE}-${schema}`,
			}),
			...buckets,
			progress: createCanonicalBackfillProgress('apply'),
			options: { apply: true, batchSize: 2 },
		});
		expect(idempotentRerun.failures).toHaveLength(0);
		expect(idempotentRerun.stats).toMatchObject({ imageRepairs: 0, objectsReused: 0 });

		// Phase 1 application cutover: the canonical assetId route resolves the
		// backfilled row, returns only a redirect, and Garage serves the byte range.
		await exerciseCanonicalHttpAndDataPlane({
			client: migrationClient,
			storage,
			presigner,
			assetId: 42_001,
			expectedBytes: 4_194_304n,
		});

			const [phase1ProjectDefault] = await migrationClient.$queryRaw<Array<{ defaultExpression: string | null }>>(Prisma.sql`
				SELECT column_default AS "defaultExpression"
				FROM information_schema.columns
				WHERE table_schema = current_schema() AND table_name = 'projects' AND column_name = 'status'
			`);
			expect(phase1ProjectDefault?.defaultExpression).toContain('PUBLISHED');

			for (const name of legacyBridgeMetricNames) {
				await migrationClient.$executeRaw(Prisma.sql`
					INSERT INTO "migration_metrics" ("name", "scope", "value", "last_observed_at", "updated_at")
					VALUES
						(${name}, '', 9, CURRENT_TIMESTAMP - INTERVAL '25 hours', CURRENT_TIMESTAMP),
						(${name}, 'legacy-scope', 7, CURRENT_TIMESTAMP - INTERVAL '25 hours', CURRENT_TIMESTAMP)
				`);
			}
			const resetAt = new Date('2026-08-24T01:02:03.456Z');
			const preflightRepository = createContractPreflightRepository(migrationClient);
			await preflightRepository.resetLegacyBridgeObservations(resetAt);
			const resetMetrics = await migrationClient.$queryRaw<Array<{
				name: string; scope: string; value: bigint; lastObservedAt: Date;
			}>>(Prisma.sql`
				SELECT "name", "scope", "value", "last_observed_at" AS "lastObservedAt"
				FROM "migration_metrics"
				WHERE "name" IN (${Prisma.join([...legacyBridgeMetricNames])})
				ORDER BY "name", "scope"
			`);
			expect(resetMetrics).toHaveLength(legacyBridgeMetricNames.length * 2);
			expect(resetMetrics.every((metric) => metric.value === 0n && metric.lastObservedAt.getTime() === resetAt.getTime())).toBe(true);
			for (const name of legacyBridgeMetricNames) {
				expect(resetMetrics.some((metric) => metric.name === name && metric.scope === '')).toBe(true);
			}
			await migrationClient.$executeRaw(Prisma.sql`
				UPDATE "migration_metrics" SET "last_observed_at" = CURRENT_TIMESTAMP - INTERVAL '25 hours'
				WHERE "name" IN (${Prisma.join([...legacyBridgeMetricNames])})
			`);
		const objects = [
			...(await storage.listKeys(buckets.protectedBucket, '')).map((key) => ({ bucket: buckets.protectedBucket, key })),
			...(await storage.listKeys(buckets.publicBucket, '')).map((key) => ({ bucket: buckets.publicBucket, key })),
		];
		const multipartProbeKey = `protected/uploads/${schema}/active-probe.zip`;
		const multipartProbeId = await storage.createMultipart(buckets.protectedBucket, multipartProbeKey);
		const activeMultipart = (await storage.listMultipartUploads(buckets.protectedBucket, multipartProbeKey))
			.map((upload) => ({ bucket: buckets.protectedBucket, key: upload.key, uploadId: upload.uploadId }));
		const multipartBlocked = await runContractPreflight({
			repository: createContractPreflightRepository(migrationClient),
			inventory: { identity: `garage-active-multipart:${schema}`, capturedAt: new Date().toISOString(), objects, multipartUploads: activeMultipart },
			head: async (bucket, key, signal) => {
				const metadata = await storage.head(bucket, key, { signal });
				return metadata ? {
					sizeBytes: BigInt(metadata.size), mimeType: metadata.contentType,
					etag: metadata.etag ?? null, checksumSha256: metadata.checksumSha256 ?? null,
				} : null;
			},
			options: { protectedBucket: buckets.protectedBucket, publicBucket: buckets.publicBucket },
		});
		expect(multipartBlocked.blockers.activeGarageMultipartUploads.count).toBe(1);
		await storage.abortMultipart(buckets.protectedBucket, multipartProbeKey, multipartProbeId);
		expect(await storage.listMultipartUploads(buckets.protectedBucket, multipartProbeKey)).toHaveLength(0);
		const report = await runContractPreflight({
			repository: createContractPreflightRepository(migrationClient),
			inventory: { identity: `garage-fixture:${schema}`, capturedAt: new Date().toISOString(), objects, multipartUploads: [] },
			head: async (bucket, key, signal) => {
				const metadata = await storage.head(bucket, key, { signal });
				return metadata ? {
					sizeBytes: BigInt(metadata.size), mimeType: metadata.contentType,
					etag: metadata.etag ?? null, checksumSha256: metadata.checksumSha256 ?? null,
				} : null;
			},
			options: { protectedBucket: buckets.protectedBucket, publicBucket: buckets.publicBucket },
		});
		expect(report.clean, JSON.stringify(report.blockers, null, 2)).toBe(true);
		const [countDefinitions] = await migrationClient.$queryRaw<Array<{
			legacyRowsTotal: bigint; legacyRowsTerminal: bigint; backfilledCanonicalRows: bigint;
		}>>(Prisma.sql`
			SELECT
				((SELECT count(*) FROM "assets" WHERE "storage_key" IS NOT NULL OR "playback_storage_key" IS NOT NULL)
				+ (SELECT count(*) FROM "exhibitions" WHERE "poster_storage_key" IS NOT NULL)
				+ (SELECT count(*) FROM "projects" WHERE "webgl_entry_key" <> '')) AS "legacyRowsTotal",
				(SELECT count(*) FROM "assets" WHERE "status"::text IN ('DELETED', 'FAILED')
					AND ("storage_key" IS NOT NULL OR "playback_storage_key" IS NOT NULL)) AS "legacyRowsTerminal",
				((SELECT count(DISTINCT a."id") FROM "assets" a
					JOIN "asset_representations" r ON r."asset_id" = a."id")
				+ (SELECT count(*) FROM "webgl_deployments")) AS "backfilledCanonicalRows"
		`);
		expect(countDefinitions).toEqual({
			legacyRowsTotal: 10n,
			legacyRowsTerminal: 2n,
			backfilledCanonicalRows: 9n,
		});
			expect(report.counts).toEqual({
			legacyRowsTotal: 10,
			legacyRowsTerminal: 2,
			backfilledCanonicalRows: 9,
			verifiedCanonicalObjects: 18,
			verifiedRelocationSources: 7,
			physicalCopies: 8,
			generatedRenditions: 2,
			unresolvedRows: 0,
			orphanObjects: 0,
			duplicateOwnership: 0,
			legacyFallbackReads: 0,
		});

		const [failedPlayback] = await migrationClient.$queryRaw<Array<{ originalCount: bigint; playbackCount: bigint }>>(Prisma.sql`
			SELECT count(*) FILTER (WHERE "role"::text = 'ORIGINAL') AS "originalCount",
				count(*) FILTER (WHERE "role"::text = 'PLAYBACK') AS "playbackCount"
			FROM "asset_representations" WHERE "asset_id" = 42008
		`);
		expect(failedPlayback).toEqual({ originalCount: 1n, playbackCount: 0n });
		const owners = await migrationClient.$queryRaw<Array<{ kind: string; objectKey: string }>>(Prisma.sql`
			SELECT a."kind"::text AS "kind", r."object_key" AS "objectKey"
			FROM "assets" a JOIN "asset_representations" r ON r."asset_id" = a."id"
			WHERE a."project_id" = 41022 AND r."role"::text IN ('ORIGINAL', 'WEBGL_SOURCE') ORDER BY a."kind"::text
		`);
		expect(owners).toEqual([
			{ kind: 'GAME', objectKey: 'webgl/41022/3f3df944-a7e3-430d-a9c1-915caa2e1d5b/source.zip' },
			{ kind: 'WEBGL', objectKey: copiedKey },
		]);

			const contract = await readFile(new URL(`${contractMigration}/migration.sql`, migrationsUrl), 'utf8');
			await migrationClient.$executeRawUnsafe(contract);
			const [phase2ProjectDefault] = await migrationClient.$queryRaw<Array<{ defaultExpression: string | null }>>(Prisma.sql`
				SELECT column_default AS "defaultExpression"
				FROM information_schema.columns
				WHERE table_schema = current_schema() AND table_name = 'projects' AND column_name = 'status'
			`);
			expect(phase2ProjectDefault?.defaultExpression).toContain('DRAFT');
		const relocationCleanup = await migrationClient.$queryRaw<Array<{ id: number; bucket: string; storageKey: string }>>(Prisma.sql`
			SELECT "id", "bucket", "storage_key" AS "storageKey"
			FROM "orphan_objects"
			WHERE "reason" = 'canonical-contract-relocation-source' AND "state"::text = 'PENDING'
			ORDER BY "id"
		`);
		expect(relocationCleanup).toHaveLength(7);
		for (const bucket of new Set(relocationCleanup.map((cleanup) => cleanup.bucket))) {
			const keys = relocationCleanup.filter((cleanup) => cleanup.bucket === bucket).map((cleanup) => ({ Key: cleanup.storageKey }));
			await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
		}
		await migrationClient.$executeRaw(Prisma.sql`
			UPDATE "orphan_objects" SET "state" = 'RESOLVED'::"OrphanState", "resolved_at" = CURRENT_TIMESTAMP
			WHERE "id" IN (${Prisma.join(relocationCleanup.map((cleanup) => cleanup.id))})
		`);
		expect(await Promise.all(relocationCleanup.map((cleanup) => storage.head(cleanup.bucket, cleanup.storageKey)))).toEqual(
			relocationCleanup.map(() => null),
		);
		expect(await migrationClient.orphanObject.count({
			where: { id: { in: relocationCleanup.map((cleanup) => cleanup.id) }, state: 'RESOLVED' },
		})).toBe(7);
		const [catalog] = await migrationClient.$queryRaw<Array<{ assets: bigint; representations: bigint; deployments: bigint; legacyTables: bigint; legacyColumns: bigint }>>(Prisma.sql`
			SELECT (SELECT count(*) FROM "assets") AS "assets",
				(SELECT count(*) FROM "asset_representations") AS "representations",
				(SELECT count(*) FROM "webgl_deployments") AS "deployments",
				(SELECT count(*) FROM information_schema.tables WHERE table_schema = current_schema()
					AND table_name IN ('game_upload_sessions', 'game_upload_parts', 'game_upload_part_claims', 'game_upload_active_sessions', 'migration_metrics')) AS "legacyTables",
				(SELECT count(*) FROM information_schema.columns WHERE table_schema = current_schema()
					AND table_name = 'assets' AND column_name IN ('storage_key', 'playback_storage_key', 'playback_status')) AS "legacyColumns"
		`);
		expect(catalog).toEqual({ assets: 10n, representations: 15n, deployments: 1n, legacyTables: 0n, legacyColumns: 0n });

		// Final Phase 2 runtime uses the same canonical resolver with the legacy
		// catalog physically absent, then allocates every supported direct-upload
		// kind through PostgreSQL + Garage control operations only.
		await exerciseCanonicalHttpAndDataPlane({
			client: migrationClient,
			storage,
			presigner,
			assetId: 42_001,
			expectedBytes: 4_194_304n,
		});
		await exerciseFiveKindDirectControls({ client: migrationClient, s3 });
	});

	it('materializes missing responsive bytes under bounded decoding and reuses checksum-identical outputs', async () => {
		const sourceKey = `${LEGACY_MIGRATION_FIXTURE_NAMESPACE}/${schema}/repair-source.png`;
		const source = await sharp({ create: { width: 1_200, height: 800, channels: 3, background: '#345678' } }).png().toBuffer();
		await s3.send(new PutObjectCommand({
			Bucket: buckets.publicBucket, Key: sourceKey, Body: source,
			ContentLength: source.byteLength, ContentType: 'image/png',
		}));
		const targets = [
			{ role: 'CARD_480' as const, width: 480 as const, objectKey: `${sourceKey}/__pcu_image_rendition__/v1/card-480.webp` },
			{ role: 'DISPLAY_960' as const, width: 960 as const, objectKey: `${sourceKey}/__pcu_image_rendition__/v1/display-960.webp` },
		];
		uploaded.push({ bucket: buckets.publicBucket, key: sourceKey }, ...targets.map((target) => ({ bucket: buckets.publicBucket, key: target.objectKey })));
		const materializer = createCanonicalObjectMaterializer(s3, { tempRoot: `/tmp/${LEGACY_MIGRATION_FIXTURE_NAMESPACE}-${schema}` });
		const repair = {
			sourceBucket: buckets.publicBucket, sourceKey, sourceMimeType: 'image/png',
			sourceSizeBytes: BigInt(source.byteLength), missing: targets,
		};
		const first = await materializer.ensureImageRenditions(repair);
		expect(first).toMatchObject({ created: 2, reused: 0 });
		expect(first.representations.map((representation) => [representation.role, representation.width, representation.height])).toEqual([
			['CARD_480', 480, 320], ['DISPLAY_960', 960, 640],
		]);
		const rerun = await materializer.ensureImageRenditions(repair);
		expect(rerun).toMatchObject({ created: 0, reused: 2 });
		expect(rerun.representations.map((representation) => representation.checksum)).toEqual(
			first.representations.map((representation) => representation.checksum),
		);
	});
});
