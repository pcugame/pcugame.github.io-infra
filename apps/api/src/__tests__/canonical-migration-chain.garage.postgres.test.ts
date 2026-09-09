import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import {
	DeleteObjectsCommand,
	GetObjectCommand,
	ListMultipartUploadsCommand,
	PutObjectCommand,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { createCanonicalObjectMaterializer } from '../infrastructure/canonical-object-migration.s3.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createS3Client } from '../lib/s3.js';
import { createObjectStorage } from '../lib/storage.js';
import { createCanonicalBackfillRepository } from '../modules/migration/canonical-backfill.prisma.js';
import {
	createCanonicalBackfillProgress,
	parseCanonicalBackfillProgress,
	runCanonicalBackfill,
} from '../modules/migration/canonical-backfill.js';
import { createContractPreflightRepository } from '../modules/migration/contract-preflight.prisma.js';
import { LEGACY_BRIDGE_METRIC_NAMES, runContractPreflight } from '../modules/migration/contract-preflight.js';
import {
	LEGACY_MIGRATION_FIXTURE_NAMESPACE,
	legacyCanonicalMigrationExpected,
	legacyCanonicalMigrationFixture,
	legacyCanonicalMigrationObjectInventory,
} from './fixtures/legacy-canonical-migration.js';

const enabled = process.env['RUN_POSTGRES_INTEGRATION'] === 'true'
	&& process.env['RUN_GARAGE_INTEGRATION'] === 'true';
const migrationsUrl = new URL('../../prisma/migrations/', import.meta.url);
const canonicalExpandMigration = '20260821000000_canonical_asset_expand';
const phase1MigrationCeiling = '20260821800000_project_video_order_expand';
const contractMigration = '20260822000000_canonical_asset_contract';
const buckets = {
	protectedBucket: process.env['S3_BUCKET_PROTECTED'] ?? 'pcu-protected',
	publicBucket: process.env['S3_BUCKET_PUBLIC'] ?? 'pcu-public',
};

function createRunFixture(runId: string) {
	const numericSeed = Number.parseInt(runId.slice(0, 7), 16);
	const baseId = 900_000_000 + numericSeed;
	const ids = {
		creator: baseId + 1,
		exhibition: baseId + 2,
		publishedProject: baseId + 10,
		archivedProject: baseId + 11,
		malformedProject: baseId + 12,
		game: baseId + 20,
		video: baseId + 21,
		poster: baseId + 22,
		image: baseId + 23,
		legacyWebglGame: baseId + 24,
		deleted: baseId + 25,
		failed: baseId + 26,
		playbackFailed: baseId + 27,
	};
	const idMap = new Map<number, number>([
		[legacyCanonicalMigrationFixture.users[0]!.id, ids.creator],
		[legacyCanonicalMigrationFixture.exhibitions[0]!.id, ids.exhibition],
		[legacyCanonicalMigrationFixture.projects[0]!.id, ids.publishedProject],
		[legacyCanonicalMigrationFixture.projects[1]!.id, ids.archivedProject],
		[legacyCanonicalMigrationFixture.projects[2]!.id, ids.malformedProject],
		...legacyCanonicalMigrationFixture.assets.map((asset, index) => [asset.id, ids.game + index] as const),
	]);
	const publicPrefix = `webgl/${ids.archivedProject}/${runId}/site/`;
	const legacyWebglSourceKey = legacyCanonicalMigrationFixture.assets.find((asset) => (
		asset.id === legacyCanonicalMigrationExpected.webglDeployment.sourceLegacyGameAssetId
	))!.storageKey;
	const rewriteKey = (key: string): string => key === legacyWebglSourceKey
		? `webgl/${ids.archivedProject}/${runId}/source.zip`
		: key.startsWith(legacyCanonicalMigrationExpected.webglDeployment.publicPrefix)
			? `${publicPrefix}${key.slice(legacyCanonicalMigrationExpected.webglDeployment.publicPrefix.length)}`
			: `migration-runs/${runId}/${key}`;
	const fixture = {
		users: legacyCanonicalMigrationFixture.users.map((user) => ({
			...user,
			id: ids.creator,
			googleSub: `${user.googleSub}:${runId}`,
			email: `${runId}@migration.example.test`,
			studentId: `MIG-${runId}`,
		})),
		exhibitions: legacyCanonicalMigrationFixture.exhibitions.map((exhibition) => ({
			...exhibition,
			id: ids.exhibition,
			posterStorageKey: rewriteKey(exhibition.posterStorageKey),
		})),
		projects: legacyCanonicalMigrationFixture.projects.map((project) => ({
			...project,
			id: idMap.get(project.id)!,
			exhibitionId: ids.exhibition,
			creatorId: ids.creator,
			posterAssetId: project.posterAssetId === null ? null : idMap.get(project.posterAssetId)!,
			webglEntryKey: project.webglEntryKey ? rewriteKey(project.webglEntryKey) : '',
		})),
		assets: legacyCanonicalMigrationFixture.assets.map((asset) => ({
			...asset,
			id: idMap.get(asset.id)!,
			projectId: idMap.get(asset.projectId)!,
			storageKey: rewriteKey(asset.storageKey),
			playbackStorageKey: asset.playbackStorageKey ? rewriteKey(asset.playbackStorageKey) : null,
		})),
		gameUploadSessions: legacyCanonicalMigrationFixture.gameUploadSessions.map((session) => ({
			...session,
			id: randomUUID(),
			projectId: ids.archivedProject,
			userId: ids.creator,
			storageKey: rewriteKey(session.storageKey),
			s3Key: rewriteKey(session.s3Key),
			completionResult: {
				...session.completionResult,
				storageKey: rewriteKey(session.completionResult.storageKey),
			},
		})),
	} as const;
	return {
		runId,
		ids,
		fixture,
		inventory: legacyCanonicalMigrationObjectInventory.map((object) => ({ ...object, key: rewriteKey(object.key) })),
		expected: {
			webglSourceKey: `protected/assets/webgl/${ids.archivedProject}/${runId}/source.zip`,
			publicPrefix,
		},
	};
}

type RunFixture = ReturnType<typeof createRunFixture>;

function createIntegrationS3() {
	return createS3Client({
		S3_ENDPOINT: process.env['S3_ENDPOINT'] ?? 'http://127.0.0.1:3900',
		S3_REGION: 'garage',
		S3_ACCESS_KEY_ID: 'GK000000000000000000000001',
		S3_SECRET_ACCESS_KEY: '0000000000000000000000000000000000000000000000000000000000000001',
		S3_FORCE_PATH_STYLE: true,
	});
}

function quoted(identifier: string): string { return `"${identifier.replaceAll('"', '""')}"`; }

async function applyMigration(databaseUrl: string, schema: string, directory: string): Promise<void> {
	const sql = await readFile(new URL(`${directory}/migration.sql`, migrationsUrl), 'utf8');
	const connection = createPrismaClientForDatabase(databaseUrl);
	try {
		await connection.$connect();
		await connection.$executeRawUnsafe(`SET search_path TO ${quoted(schema)};\n${sql}`);
	} finally {
		await connection.$disconnect();
	}
}

async function seedLegacy(client: PrismaClient, fixture: RunFixture['fixture']): Promise<void> {
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
				${exhibition.id}, ${exhibition.year}, ${exhibition.title}, ${exhibition.isModificationEnabled}, ${exhibition.sortOrder},
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

function sortedObjects(objects: Iterable<string>): Array<{ bucket: string; key: string }> {
	return [...objects].map((identity) => {
		const separator = identity.indexOf('\0');
		return { bucket: identity.slice(0, separator), key: identity.slice(separator + 1) };
	}).sort((left, right) => `${left.bucket}/${left.key}`.localeCompare(`${right.bucket}/${right.key}`));
}

async function cleanupTrackedObjects(
	s3: ReturnType<typeof createIntegrationS3>,
	tracked: ReadonlySet<string>,
): Promise<void> {
	const objects = sortedObjects(tracked);
	for (const bucket of [buckets.protectedBucket, buckets.publicBucket]) {
		const keys = objects.filter((object) => object.bucket === bucket).map(({ key }) => ({ Key: key }));
		if (keys.length > 0) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
	}
}

async function objectDigest(
	s3: ReturnType<typeof createIntegrationS3>,
	bucket: string,
	key: string,
): Promise<{ bytes: number; sha256: string }> {
	const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
	if (!response.Body) throw new Error(`Garage returned no body for ${bucket}/${key}`);
	const hash = createHash('sha256');
	let bytes = 0;
	for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
		bytes += chunk.byteLength;
		hash.update(chunk);
	}
	return { bytes, sha256: hash.digest('hex') };
}

async function listMultipartUploads(
	s3: ReturnType<typeof createIntegrationS3>,
	ownsKey: (bucket: string, key: string) => boolean,
) {
	const uploads: Array<{ bucket: string; key: string; uploadId: string }> = [];
	for (const bucket of [buckets.protectedBucket, buckets.publicBucket]) {
		let keyMarker: string | undefined;
		let uploadIdMarker: string | undefined;
		do {
			const page = await s3.send(new ListMultipartUploadsCommand({
				Bucket: bucket,
				...(keyMarker ? { KeyMarker: keyMarker } : {}),
				...(uploadIdMarker ? { UploadIdMarker: uploadIdMarker } : {}),
			}));
			for (const upload of page.Uploads ?? []) {
				if (upload.Key && upload.UploadId && ownsKey(bucket, upload.Key)) {
					uploads.push({ bucket, key: upload.Key, uploadId: upload.UploadId });
				}
			}
			keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
			uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
		} while (keyMarker || uploadIdMarker);
	}
	return uploads;
}

function verifier(storage: ReturnType<typeof createObjectStorage>) {
	return {
		async head(bucket: string, key: string) {
			const value = await storage.head(bucket, key);
			return value ? {
				size: BigInt(value.size),
				mimeType: value.contentType,
				...(value.etag ? { etag: value.etag } : {}),
				...(value.checksumSha256 ? { checksumSha256: value.checksumSha256 } : {}),
			} : null;
		},
		async listPrefix(bucket: string, prefix: string, afterKey: string | undefined, limit: number) {
			const page = await storage.listKeyPage(bucket, prefix, {
				...(afterKey ? { startAfter: afterKey } : {}),
				maxKeys: limit,
			});
			return { keys: page.keys, isTruncated: page.isTruncated };
		},
	};
}

describe.runIf(enabled)('Phase 1 canonical migration chain on PostgreSQL and Garage', () => {
	let control: PrismaClient | undefined;
	let migrationClient: PrismaClient | undefined;
	let s3 = createIntegrationS3();
	let storage = createObjectStorage(s3, { defaultPresignTtlSec: 60 });
	let schema = '';
	let databaseUrl = '';
	let schemaDatabaseUrl = '';
	let runFixture: RunFixture | undefined;
	const trackedObjects = new Set<string>();
	const track = (bucket: string, key: string) => trackedObjects.add(`${bucket}\0${key}`);

	async function trackMaterializedObjects(): Promise<void> {
		if (!migrationClient) return;
		const objects = await migrationClient.$queryRaw<Array<{ bucket: string; key: string }>>(Prisma.sql`
			SELECT "destination_bucket" AS "bucket", "destination_object_key" AS "key"
			FROM "canonical_object_relocations"
			UNION
			SELECT "bucket", "storage_key" AS "key" FROM "orphan_objects"
			UNION
			SELECT "bucket", "object_key" AS "key" FROM "asset_representations"
		`);
		for (const object of objects) track(object.bucket, object.key);
	}

	async function restartProcess(): Promise<void> {
		await migrationClient?.$disconnect();
		s3.destroy();
		migrationClient = createPrismaClientForDatabase(schemaDatabaseUrl);
		await migrationClient.$connect();
		s3 = createIntegrationS3();
		storage = createObjectStorage(s3, { defaultPresignTtlSec: 60 });
	}

	beforeAll(async () => {
		const runId = randomUUID();
		runFixture = createRunFixture(runId);
		databaseUrl = process.env['DATABASE_URL'] ?? '';
		if (!databaseUrl) throw new Error('DATABASE_URL is required');
		control = createPrismaClientForDatabase(databaseUrl);
		await control.$connect();
		schema = `canonical_chain_${randomUUID().replaceAll('-', '')}`;
		await control.$executeRawUnsafe(`CREATE SCHEMA ${quoted(schema)}`);

		const allDirectories = (await readdir(migrationsUrl, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		const directories = allDirectories.filter((directory) => directory <= phase1MigrationCeiling);
		expect(directories.at(-1)).toBe(phase1MigrationCeiling);
		const baselineDirectories = directories.filter((directory) => directory < canonicalExpandMigration);
		const expandDirectories = directories.filter((directory) => directory >= canonicalExpandMigration);
		for (const directory of baselineDirectories) await applyMigration(databaseUrl, schema, directory);

		const url = new URL(databaseUrl);
		url.searchParams.set('schema', schema);
		url.searchParams.set('options', `-c search_path=${schema}`);
		schemaDatabaseUrl = url.toString();
		migrationClient = createPrismaClientForDatabase(schemaDatabaseUrl);
		await migrationClient.$connect();
		await seedLegacy(migrationClient, runFixture.fixture);
		for (const directory of expandDirectories) await applyMigration(databaseUrl, schema, directory);
		await migrationClient.storageBucket.createMany({
			data: [
				{ bucket: buckets.protectedBucket, visibility: 'PROTECTED' },
				{ bucket: buckets.publicBucket, visibility: 'PUBLIC' },
			],
			skipDuplicates: true,
		});

		let marker = 1;
		for (const object of runFixture.inventory) {
			const bucket = object.bucket === 'protected' ? buckets.protectedBucket : buckets.publicBucket;
			let body = Buffer.alloc(Number(object.size), marker++ % 251);
			if (object.key === runFixture.fixture.assets.find((asset) => asset.id === runFixture!.ids.image)!.storageKey) {
				const validWebp = await sharp({
					create: { width: 1_200, height: 800, channels: 3, background: '#345678' },
				}).webp().toBuffer();
				if (validWebp.byteLength > Number(object.size)) throw new Error('fixture WebP exceeds declared legacy size');
				body = Buffer.concat([validWebp, Buffer.alloc(Number(object.size) - validWebp.byteLength)]);
			}
			const digest = createHash('sha256').update(body).digest();
			await s3.send(new PutObjectCommand({
				Bucket: bucket,
				Key: object.key,
				Body: body,
				ContentLength: body.byteLength,
				ContentType: object.mimeType,
				ChecksumSHA256: digest.toString('base64'),
			}));
			track(bucket, object.key);
		}
	}, 120_000);

	afterAll(async () => {
		await trackMaterializedObjects().catch(() => undefined);
		await cleanupTrackedObjects(s3, trackedObjects).catch(() => undefined);
		if (schema) {
			await rm(`/tmp/${LEGACY_MIGRATION_FIXTURE_NAMESPACE}-${schema}`, {
				recursive: true,
				force: true,
			}).catch(() => undefined);
		}
		await migrationClient?.$disconnect().catch(() => undefined);
		if (control && schema) {
			await control.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quoted(schema)} CASCADE`).catch(() => undefined);
		}
		await control?.$disconnect().catch(() => undefined);
		s3.destroy();
	});

	it('expands, materializes, crash-resumes, passes preflight, and accepts the Phase 2 contract', async () => {
		if (!migrationClient || !runFixture) throw new Error('migration client was not initialized');
		const currentRun = runFixture;
		let injectRelocationCommitFailure = true;
		const repository = createCanonicalBackfillRepository(migrationClient);
		const first = await runCanonicalBackfill({
			repository: {
				...repository,
				async markObjectRelocationMaterialized(relocation) {
					await repository.markObjectRelocationMaterialized(relocation);
					if (relocation.workKind === 'exhibition'
						&& relocation.workRef === String(runFixture!.ids.exhibition)
						&& relocation.role === 'DISPLAY_960'
						&& injectRelocationCommitFailure) {
						injectRelocationCommitFailure = false;
						throw new Error('injected relocation materialized-before-representation crash');
					}
				},
			},
			verifier: verifier(storage),
			materializer: createCanonicalObjectMaterializer(s3, {
				tempRoot: `/tmp/${LEGACY_MIGRATION_FIXTURE_NAMESPACE}-${schema}`,
			}),
			...buckets,
			progress: createCanonicalBackfillProgress('apply'),
			options: { apply: true, batchSize: 2 },
		});
		expect(first.failures).toEqual([
			expect.objectContaining({ ref: { kind: 'exhibition', id: runFixture.ids.exhibition }, code: 'COPY_FAILED' }),
			expect.objectContaining({ ref: { kind: 'webgl', id: runFixture.ids.malformedProject }, code: 'MALFORMED_LEGACY_ROW' }),
		]);
		const [crashedRelocation] = await migrationClient.$queryRaw<Array<{
			id: string;
			destinationBucket: string;
			destinationObjectKey: string;
			sizeBytes: bigint;
			checksumSha256: string;
			state: string;
		}>>(Prisma.sql`
			SELECT "id", "destination_bucket" AS "destinationBucket",
				"destination_object_key" AS "destinationObjectKey", "size_bytes" AS "sizeBytes",
				"checksum_sha256" AS "checksumSha256", "state"::text AS "state"
			FROM "canonical_object_relocations"
			WHERE "work_kind" = 'exhibition' AND "work_ref" = ${String(runFixture.ids.exhibition)}
				AND "role" = 'DISPLAY_960'
		`);
		expect(crashedRelocation).toMatchObject({ state: 'MATERIALIZED' });
		if (!crashedRelocation) throw new Error('crashed relocation was not persisted');
		track(crashedRelocation.destinationBucket, crashedRelocation.destinationObjectKey);
		const crashedDestinationBeforeRestart = await objectDigest(
			s3,
			crashedRelocation.destinationBucket,
			crashedRelocation.destinationObjectKey,
		);
		expect(crashedDestinationBeforeRestart).toEqual({
			bytes: Number(crashedRelocation.sizeBytes),
			sha256: crashedRelocation.checksumSha256,
		});
		expect(await migrationClient.$queryRaw<Array<{ state: string }>>(Prisma.sql`
			SELECT "state"::text AS "state" FROM "orphan_objects"
			WHERE "bucket" = ${crashedRelocation.destinationBucket}
				AND "storage_key" = ${crashedRelocation.destinationObjectKey}
		`)).toEqual([{ state: 'PENDING' }]);
		expect(await migrationClient.exhibition.findUniqueOrThrow({
			where: { id: runFixture.ids.exhibition },
			select: { posterAssetId: true },
		})).toEqual({ posterAssetId: null });
		await trackMaterializedObjects();
		const objectsAtCrash = sortedObjects(trackedObjects);
		for (const object of objectsAtCrash) expect(await storage.head(object.bucket, object.key)).not.toBeNull();

		const persistedProgress = JSON.parse(JSON.stringify(first.progress)) as unknown;
		await restartProcess();
		if (!migrationClient) throw new Error('migration client restart failed');
		const restartedRepository = createCanonicalBackfillRepository(migrationClient);
		const resumed = await runCanonicalBackfill({
			repository: restartedRepository,
			verifier: verifier(storage),
			materializer: createCanonicalObjectMaterializer(s3, {
				tempRoot: `/tmp/${LEGACY_MIGRATION_FIXTURE_NAMESPACE}-${schema}`,
			}),
			...buckets,
			progress: parseCanonicalBackfillProgress(persistedProgress, 'apply'),
			options: { apply: true, batchSize: 2 },
		});
		expect(resumed.failures).toEqual([
			expect.objectContaining({ ref: { kind: 'webgl', id: runFixture.ids.malformedProject }, code: 'MALFORMED_LEGACY_ROW' }),
		]);
		expect(resumed.stats).toMatchObject({ objectsReused: 3 });
		expect(await objectDigest(
			s3,
			crashedRelocation.destinationBucket,
			crashedRelocation.destinationObjectKey,
		)).toEqual(crashedDestinationBeforeRestart);
		expect(await migrationClient.$queryRaw<Array<{ state: string }>>(Prisma.sql`
			SELECT "state"::text AS "state" FROM "canonical_object_relocations"
			WHERE "id" = ${crashedRelocation.id}
		`)).toEqual([{ state: 'COMMITTED' }]);
		expect(await migrationClient.$queryRaw<Array<{ state: string }>>(Prisma.sql`
			SELECT "state"::text AS "state" FROM "orphan_objects"
			WHERE "bucket" = ${crashedRelocation.destinationBucket}
				AND "storage_key" = ${crashedRelocation.destinationObjectKey}
		`)).toEqual([{ state: 'CANCELLED' }]);
		await trackMaterializedObjects();
		expect(sortedObjects(trackedObjects)).toEqual(objectsAtCrash);

		await migrationClient.$executeRaw(Prisma.sql`
			UPDATE "projects" SET "webgl_entry_key" = '' WHERE "id" = ${runFixture.ids.malformedProject}
		`);
		const reconciled = await runCanonicalBackfill({
			repository: restartedRepository,
			verifier: verifier(storage),
			materializer: createCanonicalObjectMaterializer(s3, {
				tempRoot: `/tmp/${LEGACY_MIGRATION_FIXTURE_NAMESPACE}-${schema}`,
			}),
			...buckets,
			progress: resumed.progress,
			options: { apply: true, batchSize: 2 },
		});
		expect(reconciled.failures).toHaveLength(0);
		const copiedKey = runFixture.expected.webglSourceKey;
		const copiedHead = await storage.head(buckets.protectedBucket, copiedKey);
		expect(copiedHead).toMatchObject({
			size: Number(currentRun.fixture.assets.find((asset) => asset.id === currentRun.ids.legacyWebglGame)!.sizeBytes),
			contentType: 'application/zip',
			checksumSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		const webglSourceKey = currentRun.fixture.assets.find((asset) => asset.id === currentRun.ids.legacyWebglGame)!.storageKey;
		expect(await objectDigest(s3, buckets.protectedBucket, copiedKey)).toEqual(
			await objectDigest(s3, buckets.protectedBucket, webglSourceKey),
		);

		const countsBeforeRestart = await migrationClient.$queryRaw<Array<{
			assets: bigint; representations: bigint; deployments: bigint; relocations: bigint;
		}>>(Prisma.sql`
			SELECT (SELECT count(*) FROM "assets") AS "assets",
				(SELECT count(*) FROM "asset_representations") AS "representations",
				(SELECT count(*) FROM "webgl_deployments") AS "deployments",
				(SELECT count(*) FROM "canonical_object_relocations") AS "relocations"
		`);
		expect(countsBeforeRestart).toEqual([{ assets: 10n, representations: 15n, deployments: 1n, relocations: 7n }]);
		const representationsFor = (assetId: number) => migrationClient!.assetRepresentation.findMany({
			where: { assetId },
			orderBy: { role: 'asc' as const },
			select: {
				role: true,
				bucket: true,
				objectKey: true,
				sourceIdentityAlgorithm: true,
				checksumAlgorithm: true,
			},
		});
		const gameRepresentations = await representationsFor(runFixture.ids.game);
		expect(gameRepresentations).toEqual([expect.objectContaining({
			role: 'ORIGINAL',
			bucket: buckets.protectedBucket,
			objectKey: currentRun.fixture.assets.find((asset) => asset.id === currentRun.ids.game)!.storageKey,
		})]);
		const videoRepresentations = await representationsFor(runFixture.ids.video);
		expect(videoRepresentations.map(({ role }) => role)).toEqual(['ORIGINAL', 'PLAYBACK']);
		const videoFixture = currentRun.fixture.assets.find((asset) => asset.id === currentRun.ids.video)!;
		expect(videoRepresentations.map(({ bucket, objectKey }) => ({ bucket, objectKey }))).toEqual([
			{ bucket: buckets.protectedBucket, objectKey: videoFixture.storageKey },
			{ bucket: buckets.protectedBucket, objectKey: videoFixture.playbackStorageKey },
		]);
		const posterRepresentations = await representationsFor(runFixture.ids.poster);
		expect(posterRepresentations.map(({ role }) => role)).toEqual(['ORIGINAL', 'CARD_480', 'DISPLAY_960']);
		expect(posterRepresentations.every((representation) => (
			representation.bucket === buckets.publicBucket
			&& representation.objectKey.startsWith(`public/images/${runFixture!.ids.poster}/${representation.role.toLowerCase()}/`)
			&& representation.sourceIdentityAlgorithm === 'MIGRATION_COPY_SHA256'
		))).toBe(true);
		const imageRepresentations = await representationsFor(runFixture.ids.image);
		expect(imageRepresentations.map(({ role }) => role)).toEqual(['ORIGINAL', 'CARD_480', 'DISPLAY_960']);
		expect(imageRepresentations.map(({ role, sourceIdentityAlgorithm }) => ({ role, sourceIdentityAlgorithm }))).toEqual([
			{ role: 'ORIGINAL', sourceIdentityAlgorithm: 'MIGRATION_COPY_SHA256' },
			{ role: 'CARD_480', sourceIdentityAlgorithm: 'MIGRATION_GENERATED_SHA256' },
			{ role: 'DISPLAY_960', sourceIdentityAlgorithm: 'MIGRATION_GENERATED_SHA256' },
		]);
		expect(imageRepresentations.every((representation) => (
			representation.bucket === buckets.publicBucket
			&& representation.objectKey.startsWith(`public/images/${runFixture!.ids.image}/${representation.role.toLowerCase()}/`)
			&& representation.checksumAlgorithm === 'SHA256'
		))).toBe(true);
		const legacyWebglGameRepresentations = await representationsFor(runFixture.ids.legacyWebglGame);
		expect(legacyWebglGameRepresentations).toEqual([expect.objectContaining({
			role: 'ORIGINAL',
			bucket: buckets.protectedBucket,
			objectKey: webglSourceKey,
		})]);
		expect(await migrationClient.assetRepresentation.count({
			where: { assetId: { in: [runFixture.ids.deleted, runFixture.ids.failed] } },
		})).toBe(0);
		const playbackFailedRepresentations = await representationsFor(runFixture.ids.playbackFailed);
		expect(playbackFailedRepresentations).toEqual([expect.objectContaining({
			role: 'ORIGINAL',
			bucket: buckets.protectedBucket,
			objectKey: currentRun.fixture.assets.find((asset) => asset.id === currentRun.ids.playbackFailed)!.storageKey,
		})]);
		expect(await migrationClient.webglDeployment.count({
			where: { projectId: runFixture.ids.malformedProject },
		})).toBe(0);
		const webglDeployment = await migrationClient.webglDeployment.findFirstOrThrow({
			where: { projectId: runFixture.ids.archivedProject },
			select: {
				sourceRepresentation: {
					select: {
						role: true,
						bucket: true,
						objectKey: true,
						sizeBytes: true,
						checksum: true,
						state: true,
						asset: { select: { id: true, kind: true } },
					},
				},
			},
		});
		expect(webglDeployment.sourceRepresentation.asset).toMatchObject({ kind: 'WEBGL' });
		expect(webglDeployment.sourceRepresentation.asset.id).not.toBe(runFixture.ids.legacyWebglGame);
		expect(webglDeployment.sourceRepresentation).toEqual({
			asset: webglDeployment.sourceRepresentation.asset,
			role: 'WEBGL_SOURCE',
			bucket: buckets.protectedBucket,
			objectKey: copiedKey,
			sizeBytes: BigInt(copiedHead!.size),
			checksum: copiedHead!.checksumSha256,
			state: 'READY',
		});
		const exhibitionPoster = await migrationClient.exhibition.findUniqueOrThrow({
			where: { id: runFixture.ids.exhibition },
			select: {
				poster: {
					select: {
						representations: {
							orderBy: { role: 'asc' },
							select: { role: true, bucket: true, objectKey: true, sourceIdentityAlgorithm: true },
						},
					},
				},
			},
		});
		expect(exhibitionPoster.poster?.representations.map(({ role }) => role)).toEqual([
			'ORIGINAL', 'CARD_480', 'DISPLAY_960',
		]);
		expect(exhibitionPoster.poster?.representations.every((representation) => (
			representation.bucket === buckets.publicBucket
			&& representation.objectKey.startsWith(`public/images/exhibitions/${runFixture!.ids.exhibition}/${representation.role.toLowerCase()}/`)
			&& representation.sourceIdentityAlgorithm === 'MIGRATION_COPY_SHA256'
		))).toBe(true);
		const relocationRows = await migrationClient.$queryRaw<Array<{
			sourceBucket: string;
			sourceObjectKey: string;
			destinationBucket: string;
			destinationObjectKey: string;
			sizeBytes: bigint;
			checksumSha256: string;
			state: string;
		}>>(Prisma.sql`
			SELECT "source_bucket" AS "sourceBucket", "source_object_key" AS "sourceObjectKey",
				"destination_bucket" AS "destinationBucket", "destination_object_key" AS "destinationObjectKey",
				"size_bytes" AS "sizeBytes", "checksum_sha256" AS "checksumSha256", "state"::text AS "state"
			FROM "canonical_object_relocations"
		`);
		expect(relocationRows).toHaveLength(7);
		for (const relocation of relocationRows) {
			expect(relocation.state).toBe('COMMITTED');
			const sourceHead = await storage.head(relocation.sourceBucket, relocation.sourceObjectKey);
			const destinationHead = await storage.head(relocation.destinationBucket, relocation.destinationObjectKey);
			expect(destinationHead).toMatchObject({
				size: Number(relocation.sizeBytes),
				checksumSha256: relocation.checksumSha256,
			});
			expect(sourceHead).toMatchObject({
				size: Number(relocation.sizeBytes),
				checksumSha256: relocation.checksumSha256,
			});
			expect(await objectDigest(s3, relocation.destinationBucket, relocation.destinationObjectKey)).toEqual(
				await objectDigest(s3, relocation.sourceBucket, relocation.sourceObjectKey),
			);
		}
		expect(await migrationClient.$queryRaw<Array<{ bucket: string; key: string; copies: bigint }>>(Prisma.sql`
			SELECT "destination_bucket" AS "bucket", "destination_object_key" AS "key", count(*) AS "copies"
			FROM "canonical_object_relocations"
			GROUP BY "destination_bucket", "destination_object_key" HAVING count(*) > 1
		`)).toEqual([]);
		await trackMaterializedObjects();
		const objectsBeforeRestart = sortedObjects(trackedObjects);
		for (const object of objectsBeforeRestart) expect(await storage.head(object.bucket, object.key)).not.toBeNull();

		await restartProcess();
		if (!migrationClient) throw new Error('migration client idempotency restart failed');
		const idempotent = await runCanonicalBackfill({
			repository: createCanonicalBackfillRepository(migrationClient),
			verifier: verifier(storage),
			materializer: createCanonicalObjectMaterializer(s3, {
				tempRoot: `/tmp/${LEGACY_MIGRATION_FIXTURE_NAMESPACE}-${schema}`,
			}),
			...buckets,
			progress: createCanonicalBackfillProgress('apply'),
			options: { apply: true, batchSize: 2 },
		});
		expect(idempotent.failures).toHaveLength(0);
		expect(idempotent.stats).toMatchObject({ objectCopies: 0, objectsReused: 0, imageRepairs: 0 });
		expect(await migrationClient.$queryRaw(Prisma.sql`
			SELECT (SELECT count(*) FROM "assets") AS "assets",
				(SELECT count(*) FROM "asset_representations") AS "representations",
				(SELECT count(*) FROM "webgl_deployments") AS "deployments",
				(SELECT count(*) FROM "canonical_object_relocations") AS "relocations"
		`)).toEqual(countsBeforeRestart);
		await trackMaterializedObjects();
		expect(sortedObjects(trackedObjects)).toEqual(objectsBeforeRestart);
		for (const object of objectsBeforeRestart) expect(await storage.head(object.bucket, object.key)).not.toBeNull();

		const preflightNow = new Date('2026-08-25T12:00:00.000Z');
		const observedAt = new Date(preflightNow.getTime() - 25 * 60 * 60 * 1_000);
		for (const name of LEGACY_BRIDGE_METRIC_NAMES) {
			await migrationClient.$executeRaw(Prisma.sql`
				INSERT INTO "migration_metrics" ("name", "scope", "value", "last_observed_at", "details", "updated_at")
				VALUES (${name}, '', 0, ${observedAt}, '{"fixture":"explicit-25h-observation"}'::jsonb, CURRENT_TIMESTAMP)
			`);
		}
		const inventory = sortedObjects(trackedObjects);
		const ownsRunKey = (bucket: string, key: string): boolean => trackedObjects.has(`${bucket}\0${key}`)
			|| key.startsWith(`migration-runs/${currentRun.runId}/`)
			|| (bucket === buckets.publicBucket && (
				key.startsWith(currentRun.expected.publicPrefix)
				|| key.startsWith(`public/images/${currentRun.ids.poster}/`)
				|| key.startsWith(`public/images/${currentRun.ids.image}/`)
				|| key.startsWith(`public/images/exhibitions/${currentRun.ids.exhibition}/`)
			))
			|| (bucket === buckets.protectedBucket && (
				key.startsWith(`webgl/${currentRun.ids.archivedProject}/${currentRun.runId}/`)
				|| key.startsWith(`protected/assets/webgl/${currentRun.ids.archivedProject}/${currentRun.runId}/`)
			));
		const multipartUploads = await listMultipartUploads(s3, ownsRunKey);
		expect(multipartUploads).toEqual([]);
		const report = await runContractPreflight({
			repository: createContractPreflightRepository(migrationClient),
			inventory: {
				identity: `phase1-canonical-chain:${schema}`,
				capturedAt: preflightNow.toISOString(),
				objects: inventory,
				multipartUploads,
			},
			head: async (bucket, key, signal) => {
				const metadata = await storage.head(bucket, key, { signal });
				return metadata ? {
					sizeBytes: BigInt(metadata.size),
					mimeType: metadata.contentType,
					etag: metadata.etag ?? null,
					checksumSha256: metadata.checksumSha256 ?? null,
				} : null;
			},
			now: () => preflightNow,
			options: { protectedBucket: buckets.protectedBucket, publicBucket: buckets.publicBucket },
		});
		expect(report.metricObservationReset).toBe(false);
		expect(report.clean, JSON.stringify(report.blockers, null, 2)).toBe(true);
		expect(report.blockers.duplicateCanonicalOwnership.count).toBe(0);
		expect(report.blockers.activeGarageMultipartUploads.count).toBe(0);
		expect(report.counts).toMatchObject({
			backfilledCanonicalRows: 9,
			verifiedCanonicalObjects: 18,
			verifiedRelocationSources: 7,
			physicalCopies: 8,
			generatedRenditions: 2,
			unresolvedRows: 0,
			legacyFallbackReads: 0,
		});
		const observations = await migrationClient.$queryRaw<Array<{ value: bigint; lastObservedAt: Date }>>(Prisma.sql`
			SELECT "value", "last_observed_at" AS "lastObservedAt"
			FROM "migration_metrics"
			WHERE "name" IN (${Prisma.join([...LEGACY_BRIDGE_METRIC_NAMES])})
		`);
		expect(observations).toHaveLength(LEGACY_BRIDGE_METRIC_NAMES.length);
		expect(observations.every((metric) => (
			metric.value === 0n && metric.lastObservedAt?.getTime() === observedAt.getTime()
		))).toBe(true);

		const assetsBeforeContract = await migrationClient.$queryRaw<Array<{
			id: number; projectId: number | null; exhibitionId: number | null; kind: string; status: string;
		}>>(Prisma.sql`
			SELECT "id", "project_id" AS "projectId", "exhibition_id" AS "exhibitionId",
				"kind"::text AS "kind", "status"::text AS "status"
			FROM "assets" ORDER BY "id"
		`);
		const representationsBeforeContract = await migrationClient.$queryRaw<Array<{
			id: string; assetId: number; role: string; bucket: string; objectKey: string; state: string;
		}>>(Prisma.sql`
			SELECT "id", "asset_id" AS "assetId", "role"::text AS "role", "bucket",
				"object_key" AS "objectKey", "state"::text AS "state"
			FROM "asset_representations" ORDER BY "id"
		`);
		const deploymentsBeforeContract = await migrationClient.$queryRaw<Array<{
			id: string; projectId: number; sourceRepresentationId: string;
			publicBucket: string; publicPrefix: string; entryObjectKey: string; state: string;
		}>>(Prisma.sql`
			SELECT "id", "project_id" AS "projectId", "source_representation_id" AS "sourceRepresentationId",
				"public_bucket" AS "publicBucket", "public_prefix" AS "publicPrefix",
				"entry_object_key" AS "entryObjectKey", "state"::text AS "state"
			FROM "webgl_deployments" ORDER BY "id"
		`);

		const videoOrdersBeforeContract = await migrationClient.$queryRaw(Prisma.sql`
			SELECT "id", "video_sort_order" FROM "assets" WHERE "kind" = 'VIDEO' ORDER BY "id"
		`);
		await applyMigration(databaseUrl, schema, contractMigration);
		expect(await migrationClient.$queryRaw(Prisma.sql`
			SELECT "id", "video_sort_order" FROM "assets" WHERE "kind" = 'VIDEO' ORDER BY "id"
		`)).toEqual(videoOrdersBeforeContract);


		expect(await migrationClient.$queryRaw(Prisma.sql`
			SELECT "id", "project_id" AS "projectId", "exhibition_id" AS "exhibitionId",
				"kind"::text AS "kind", "status"::text AS "status"
			FROM "assets" ORDER BY "id"
		`)).toEqual(assetsBeforeContract);
		expect(await migrationClient.$queryRaw(Prisma.sql`
			SELECT "id", "asset_id" AS "assetId", "role"::text AS "role", "bucket",
				"object_key" AS "objectKey", "state"::text AS "state"
			FROM "asset_representations" ORDER BY "id"
		`)).toEqual(representationsBeforeContract);
		expect(await migrationClient.$queryRaw(Prisma.sql`
			SELECT "id", "project_id" AS "projectId", "source_representation_id" AS "sourceRepresentationId",
				"public_bucket" AS "publicBucket", "public_prefix" AS "publicPrefix",
				"entry_object_key" AS "entryObjectKey", "state"::text AS "state"
			FROM "webgl_deployments" ORDER BY "id"
		`)).toEqual(deploymentsBeforeContract);

		const [legacyCatalog] = await migrationClient.$queryRaw<Array<{
			tables: bigint; columns: bigint;
		}>>(Prisma.sql`
			SELECT
				(SELECT count(*) FROM information_schema.tables
					WHERE table_schema = current_schema() AND table_name IN (
						'game_upload_active_sessions', 'game_upload_part_claims', 'game_upload_parts',
						'game_upload_sessions', 'migration_metrics', 'canonical_object_relocations'
					)) AS "tables",
				(SELECT count(*) FROM information_schema.columns
					WHERE table_schema = current_schema() AND (
						(table_name = 'projects' AND column_name = 'webgl_entry_key')
						OR (table_name = 'exhibitions' AND column_name IN (
							'poster_storage_key', 'poster_original_name', 'poster_mime_type', 'poster_size_bytes',
							'poster_width', 'poster_height', 'poster_card_480_height', 'poster_display_960_height'
						))
						OR (table_name = 'assets' AND column_name IN (
							'storage_key', 'playback_storage_key', 'mime_type', 'playback_mime_type', 'size_bytes',
							'width', 'height', 'card_480_height', 'display_960_height', 'playback_size_bytes',
							'playback_status', 'playback_error', 'is_public'
						))
					)) AS "columns"
		`);
		expect(legacyCatalog).toEqual({ tables: 0n, columns: 0n });

		const relocationCleanup = await migrationClient.$queryRaw<Array<{
			bucket: string; key: string; state: string;
		}>>(Prisma.sql`
			SELECT "bucket", "storage_key" AS "key", "state"::text AS "state"
			FROM "orphan_objects"
			WHERE "reason" = 'canonical-contract-relocation-source'
			ORDER BY "bucket", "storage_key"
		`);
		expect(relocationCleanup).toEqual(relocationRows
			.map((relocation) => ({
				bucket: relocation.sourceBucket,
				key: relocation.sourceObjectKey,
				state: 'PENDING',
			}))
			.sort((left, right) => `${left.bucket}/${left.key}`.localeCompare(`${right.bucket}/${right.key}`)));
		expect(await storage.head(buckets.protectedBucket, copiedKey)).toMatchObject(copiedHead!);
	}, 120_000);
});
