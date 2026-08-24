/**
 * Production release migration fence.
 *
 * Prisma normally applies every pending migration. A two-release expand/contract
 * cutover must instead expose only the migrations authorized for that phase.
 * This command creates a temporary Prisma tree containing the approved prefix,
 * lets Prisma apply and record it normally, and verifies the durable DB record.
 */
import { cp, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createPrismaClientForDatabase } from '../src/lib/prisma-client.js';

const BASELINE_MIGRATION = '20260812010000_deterministic_responsive_images';
const CANONICAL_EXPAND_MIGRATION = '20260821000000_canonical_asset_expand';
const PROJECT_DRAFT_MIGRATION = '20260821400000_project_submission_draft_status';
const PROJECT_SUBMISSION_MIGRATION = '20260821500000_project_submission_expand';
const PROJECT_FINALIZING_MIGRATION = '20260821550000_project_submission_finalizing_status';
const PHASE1_TARGET_MIGRATION = '20260821700000_canonical_object_relocation_expand';
const CONTRACT_MIGRATION = '20260822000000_canonical_asset_contract';

type RuntimePhase = 'phase1' | 'phase2';
type Command = 'status' | 'apply-expand' | 'apply-contract' | 'assert-runtime';

type MigrationRow = {
	migration_name: string;
	finished_at: Date | null;
	rolled_back_at: Date | null;
};

function apiRoot(): string {
	const current = fileURLToPath(import.meta.url);
	// src execution: scripts/*.ts; compiled execution: dist-release/scripts/*.js
	const scriptDirectory = dirname(current);
	return basename(dirname(scriptDirectory)) === 'dist-release'
		? resolve(scriptDirectory, '..', '..')
		: resolve(scriptDirectory, '..');
}

function parseArgs(args: readonly string[]): { command: Command; phase?: RuntimePhase } {
	const [command, phase, ...rest] = args;
	if (rest.length > 0) throw new Error(`unexpected arguments: ${rest.join(' ')}`);
	if (!['status', 'apply-expand', 'apply-contract', 'assert-runtime'].includes(command ?? '')) {
		throw new Error('usage: release-migrate <status|apply-expand|apply-contract|assert-runtime phase1|phase2>');
	}
	if (command === 'assert-runtime') {
		if (phase !== 'phase1' && phase !== 'phase2') throw new Error('assert-runtime requires phase1 or phase2');
		return { command, phase };
	}
	if (phase !== undefined) throw new Error(`${command} takes no phase argument`);
	return { command: command as Command };
}

async function migrationRows(databaseUrl: string): Promise<MigrationRow[]> {
	const prisma = createPrismaClientForDatabase(databaseUrl);
	try {
		return await prisma.$queryRawUnsafe<MigrationRow[]>(
			'SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at, migration_name',
		);
	} catch (error) {
		throw new Error(
			'Prisma migration history is missing or unreadable; direct fresh/master-to-final deployment is forbidden',
			{ cause: error },
		);
	} finally {
		await prisma.$disconnect();
	}
}

function completed(rows: readonly MigrationRow[]): Set<string> {
	return new Set(rows.filter((row) => row.finished_at && !row.rolled_back_at).map((row) => row.migration_name));
}

function releaseStatus(rows: readonly MigrationRow[]) {
	const applied = completed(rows);
	return {
		baseline: applied.has(BASELINE_MIGRATION),
		canonicalExpand: applied.has(CANONICAL_EXPAND_MIGRATION),
		projectDraftExpand: applied.has(PROJECT_DRAFT_MIGRATION),
		projectSubmissionExpand: applied.has(PROJECT_SUBMISSION_MIGRATION),
		projectPublicationExpand: applied.has(PHASE1_TARGET_MIGRATION),
		expand: [
			CANONICAL_EXPAND_MIGRATION,
			PROJECT_DRAFT_MIGRATION,
			PROJECT_SUBMISSION_MIGRATION,
			PROJECT_FINALIZING_MIGRATION,
			PHASE1_TARGET_MIGRATION,
		]
			.every((migration) => applied.has(migration)),
		contract: applied.has(CONTRACT_MIGRATION),
		completedMigrations: [...applied].sort(),
	};
}

function assertNoFailedReleaseMigration(rows: readonly MigrationRow[]): void {
	const failed = rows.filter((row) => (
		([
			CANONICAL_EXPAND_MIGRATION,
			PROJECT_DRAFT_MIGRATION,
			PROJECT_SUBMISSION_MIGRATION,
			PROJECT_FINALIZING_MIGRATION,
			PHASE1_TARGET_MIGRATION,
			CONTRACT_MIGRATION,
		] as string[]).includes(row.migration_name)
		&& (!row.finished_at || row.rolled_back_at)
	));
	if (failed.length > 0) {
		throw new Error(`release migration history contains failed/rolled-back rows: ${failed.map((row) => row.migration_name).join(', ')}`);
	}
}

type StorageBucketRow = { bucket: string; visibility: 'PROTECTED' | 'PUBLIC' };

function configuredStorageBuckets(): readonly [StorageBucketRow, StorageBucketRow] {
	const protectedBucket = process.env['S3_BUCKET_PROTECTED'];
	const publicBucket = process.env['S3_BUCKET_PUBLIC'];
	if (!protectedBucket || !publicBucket || protectedBucket === publicBucket) {
		throw new Error('S3_BUCKET_PROTECTED and S3_BUCKET_PUBLIC must be distinct non-empty bucket names');
	}
	return [
		{ bucket: protectedBucket, visibility: 'PROTECTED' },
		{ bucket: publicBucket, visibility: 'PUBLIC' },
	];
}

async function seedStorageBucketRegistry(databaseUrl: string): Promise<void> {
	const prisma = createPrismaClientForDatabase(databaseUrl);
	const configured = configuredStorageBuckets();
	try {
		await prisma.$transaction(async (tx) => {
			for (const entry of configured) {
				const existing = await tx.$queryRawUnsafe<StorageBucketRow[]>(
					'SELECT "bucket", "visibility"::text AS "visibility" FROM "storage_buckets" WHERE "bucket" = $1 FOR UPDATE',
					entry.bucket,
				);
				if (existing[0] && existing[0].visibility !== entry.visibility) {
					throw new Error(`storage bucket ${entry.bucket} is already registered as ${existing[0].visibility}`);
				}
				await tx.$executeRawUnsafe(
					`INSERT INTO "storage_buckets" ("bucket", "visibility", "updated_at")
					 VALUES ($1, $2::"StorageVisibility", CURRENT_TIMESTAMP)
					 ON CONFLICT ("bucket") DO UPDATE SET "updated_at" = CURRENT_TIMESTAMP`,
					entry.bucket,
					entry.visibility,
				);
			}
		});
	} finally {
		await prisma.$disconnect();
	}
}

async function verifyStorageBucketRegistry(databaseUrl: string): Promise<void> {
	const prisma = createPrismaClientForDatabase(databaseUrl);
	try {
		const rows = await prisma.$queryRawUnsafe<StorageBucketRow[]>(
			'SELECT "bucket", "visibility"::text AS "visibility" FROM "storage_buckets" WHERE "bucket" IN ($1, $2)',
			...configuredStorageBuckets().map(({ bucket }) => bucket),
		);
		for (const expected of configuredStorageBuckets()) {
			if (!rows.some((row) => row.bucket === expected.bucket && row.visibility === expected.visibility)) {
				throw new Error(`storage bucket registry does not map ${expected.bucket} to ${expected.visibility}`);
			}
		}
	} finally {
		await prisma.$disconnect();
	}
}

function assertRuntime(rows: readonly MigrationRow[], phase: RuntimePhase): void {
	assertNoFailedReleaseMigration(rows);
	const status = releaseStatus(rows);
	if (!status.baseline) throw new Error(`required master baseline ${BASELINE_MIGRATION} is not applied`);
	if (phase === 'phase1' && (!status.expand || status.contract)) {
		throw new Error('phase1 runtime requires expand=applied and contract=not-applied');
	}
	if (phase === 'phase2' && !status.contract) {
		throw new Error('phase2 runtime requires the contract migration DB record');
	}
}

async function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
		child.once('error', reject);
		child.once('exit', (code, signal) => {
			if (code === 0) resolvePromise();
			else reject(new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}`));
		});
	});
}

async function stagedMigrate(target: typeof PHASE1_TARGET_MIGRATION | typeof CONTRACT_MIGRATION, databaseUrl: string): Promise<void> {
	const root = apiRoot();
	const sourcePrisma = join(root, 'prisma');
	const migrationNames = (await readdir(join(sourcePrisma, 'migrations'), { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && entry.name <= target)
		.map((entry) => entry.name)
		.sort();
	if (!migrationNames.includes(target)) throw new Error(`release image does not contain ${target}`);

	const staging = await mkdtemp(join(tmpdir(), 'pcugame-release-migrate-'));
	try {
		await mkdir(join(staging, 'prisma', 'migrations'), { recursive: true });
		await cp(join(sourcePrisma, 'schema.prisma'), join(staging, 'prisma', 'schema.prisma'));
		await cp(join(sourcePrisma, 'migrations', 'migration_lock.toml'), join(staging, 'prisma', 'migrations', 'migration_lock.toml'));
		for (const name of migrationNames) {
			await cp(join(sourcePrisma, 'migrations', name), join(staging, 'prisma', 'migrations', name), { recursive: true });
		}
		await writeFile(join(staging, 'prisma.config.ts'), [
			"import { defineConfig } from 'prisma/config';",
			"export default defineConfig({ schema: 'prisma/schema.prisma', migrations: { path: 'prisma/migrations' }, datasource: { url: process.env['DATABASE_URL']! } });",
			'',
		].join('\n'));
		const prismaCli = join(root, 'node_modules', 'prisma', 'build', 'index.js');
		await run(process.execPath, [prismaCli, 'migrate', 'deploy', '--config', join(staging, 'prisma.config.ts')], staging, {
			...process.env,
			DATABASE_URL: databaseUrl,
		});
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const { command, phase } = parseArgs(process.argv.slice(2));
	const databaseUrl = process.env['DATABASE_URL'];
	if (!databaseUrl) throw new Error('DATABASE_URL is required');
	let rows = await migrationRows(databaseUrl);
	assertNoFailedReleaseMigration(rows);
	let status = releaseStatus(rows);

	if (command === 'status') {
		console.log(JSON.stringify({ event: 'release_migration_status', ...status }, null, 2));
		return;
	}
	if (command === 'assert-runtime') {
		assertRuntime(rows, phase!);
		await verifyStorageBucketRegistry(databaseUrl);
		console.log(JSON.stringify({ event: 'release_runtime_schema_verified', phase, ...status }));
		return;
	}
	if (!status.baseline) {
		throw new Error(`required master baseline ${BASELINE_MIGRATION} is not applied; fresh/master-to-final direct deploy is forbidden`);
	}

	if (command === 'apply-expand') {
		if (status.contract) throw new Error('contract is already applied; expand runtime must never be deployed');
		if (!status.expand) await stagedMigrate(PHASE1_TARGET_MIGRATION, databaseUrl);
		await seedStorageBucketRegistry(databaseUrl);
	} else {
		if (!status.expand) throw new Error('contract cannot be applied before the Phase 1 expand release');
		await seedStorageBucketRegistry(databaseUrl);
		await verifyStorageBucketRegistry(databaseUrl);
		if (!status.contract) await stagedMigrate(CONTRACT_MIGRATION, databaseUrl);
	}

	rows = await migrationRows(databaseUrl);
	status = releaseStatus(rows);
	if (command === 'apply-expand') assertRuntime(rows, 'phase1');
	else assertRuntime(rows, 'phase2');
	console.log(JSON.stringify({ event: 'release_migration_applied_and_recorded', command, ...status }, null, 2));
}

void main().catch((error) => {
	console.error(JSON.stringify({
		event: 'release_migration_failed_closed',
		message: error instanceof Error ? error.message : String(error),
	}));
	process.exitCode = 1;
});
