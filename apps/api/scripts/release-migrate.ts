/**
 * Production release migration fence.
 *
 * Prisma normally applies every pending migration. A two-release expand/contract
 * cutover must instead expose only the migrations authorized for that phase.
 * This command creates a temporary Prisma tree containing the approved prefix,
 * lets Prisma apply and record it normally, and verifies the durable DB record.
 */
import { cp, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createPrismaClientForDatabase } from '../src/lib/prisma-client.js';

export const BASELINE_MIGRATION = '20260812010000_deterministic_responsive_images';
export const CANONICAL_EXPAND_MIGRATION = '20260821000000_canonical_asset_expand';
export const PROJECT_DRAFT_MIGRATION = '20260821400000_project_submission_draft_status';
export const PROJECT_SUBMISSION_MIGRATION = '20260821500000_project_submission_expand';
export const PROJECT_FINALIZING_MIGRATION = '20260821550000_project_submission_finalizing_status';
export const PROJECT_PUBLICATION_MIGRATION = '20260821600000_project_publication_expand';
// Keep the relocation target stable as the durable object-migration boundary.
// Later additive Phase 1 migrations extend the staged Prisma prefix via the
// explicit ceiling below.
export const PHASE1_TARGET_MIGRATION = '20260821700000_canonical_object_relocation_expand';
export const PROJECT_VIDEO_ORDER_MIGRATION = '20260821800000_project_video_order_expand';
export const PROJECT_MATERIAL_KIND_MIGRATION = '20260821900000_project_material_kind_expand';
export const PROJECT_MATERIAL_CONSTRAINTS_MIGRATION = '20260821910000_project_material_constraints_expand';
export const PHASE1_MIGRATION_CEILING = PROJECT_MATERIAL_CONSTRAINTS_MIGRATION;
export const REQUIRED_EXPAND_MIGRATIONS = [
	CANONICAL_EXPAND_MIGRATION,
	PROJECT_DRAFT_MIGRATION,
	PROJECT_SUBMISSION_MIGRATION,
	PROJECT_FINALIZING_MIGRATION,
	PROJECT_PUBLICATION_MIGRATION,
	PHASE1_TARGET_MIGRATION,
	PROJECT_VIDEO_ORDER_MIGRATION,
	PROJECT_MATERIAL_KIND_MIGRATION,
	PROJECT_MATERIAL_CONSTRAINTS_MIGRATION,
] as const;
export const EXCEPTION_PREP_MIGRATION = '20260821990000_release_exception_receipts';
export const AGE_EXCEPTION_CONTRACT_MIGRATION = '20260822000001_canonical_asset_contract_age_exception';
export const BRIDGE_EXCEPTION_PREP_MIGRATION = '20260821991000_release_image_bridge_exception';
export const BRIDGE_EXCEPTION_CONTRACT_MIGRATION = '20260822000002_canonical_asset_contract_image_bridge36';
export const BRIDGE_EXCEPTION_SCOPE = '24-hour-observation-age-and-image-bridge-36';
export const OBSERVATION_EXCEPTION_SCOPE = '24-hour-observation-age-only';
export const CONTRACT_MIGRATION = '20260822000000_canonical_asset_contract';
export const PROJECT_CHANGE_MIGRATION = '20260909100000_project_change_requests';

type RuntimePhase = 'phase1' | 'phase2';
type Command = 'status' | 'apply-expand' | 'apply-contract' | 'assert-runtime';

export type MigrationRow = {
	migration_name: string;
	finished_at: Date | null;
	rolled_back_at: Date | null;
	checksum?: string;
};

function apiRoot(): string {
	const current = fileURLToPath(import.meta.url);
	// src execution: scripts/*.ts; compiled execution: dist-release/scripts/*.js
	const scriptDirectory = dirname(current);
	return basename(dirname(scriptDirectory)) === 'dist-release'
		? resolve(scriptDirectory, '..', '..')
		: resolve(scriptDirectory, '..');
}

export type ObservationException = {
	exceptionId: string;
	sourceSha: string;
	image: string;
	actor: string;
	runId: string;
	profile?: 'image-bridge-36';
};

export type ExceptionReceipt = {
	migration_name: string;
	exception_id: string;
	source_sha: string;
	image: string;
	actor: string;
	run_id: string;
	scope: string;
	migration_checksum: string;
	authorized_at: Date;
	expires_at: Date;
	applied_at: Date | null;
	// SQL joins the receipt to the matching consumed prior authorization.
	authorization_matches: boolean;
	metrics: unknown;
	relocation_summary: unknown;
};

export function validateObservationException(value: ObservationException): void {
	if (value.profile !== undefined && value.profile !== 'image-bridge-36') throw new Error('invalid exception profile');
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.exceptionId)) throw new Error('invalid observation exception ID');
	if (!/^[0-9a-f]{40}$/.test(value.sourceSha)) throw new Error('release source must be a full lowercase 40-character commit SHA');
	if (!/^ghcr\.io\/pcugame\/pcu-graduationproject-v2-api@sha256:[0-9a-f]{64}$/.test(value.image)) throw new Error('release image must be an immutable repository@sha256 digest');
	if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value.actor)) throw new Error('invalid exception actor');
	if (!/^[0-9]{1,30}$/.test(value.runId)) throw new Error('invalid exception run ID');
}

export function parseArgs(args: readonly string[]): { command: Command; phase?: RuntimePhase; exception?: ObservationException } {
	const [command, ...rest] = args;
	if (!['status', 'apply-expand', 'apply-contract', 'assert-runtime'].includes(command ?? '')) {
		throw new Error('usage: release-migrate <status|apply-expand|apply-contract|assert-runtime phase1|phase2>');
	}
	if (command === 'assert-runtime') {
		if (rest.length !== 1 || (rest[0] !== 'phase1' && rest[0] !== 'phase2')) throw new Error('assert-runtime requires phase1 or phase2');
		return { command, phase: rest[0] };
	}
	if (rest.length === 0) return { command: command as Command };
	if (command !== 'apply-contract') throw new Error(`${command} takes no arguments`);
	const flags = new Map<string, string>();
	const allowed = ['--observation-exception-id', '--release-source-sha', '--release-image', '--exception-actor', '--exception-run-id'];
	for (let index = 0; index < rest.length; index += 2) {
		const flag = rest[index]!;
		const value = rest[index + 1];
		if (!([...allowed, '--exception-profile'].includes(flag)) || flags.has(flag) || !value || value.startsWith('--')) throw new Error(`invalid or duplicate exception argument: ${flag}`);
		flags.set(flag, value);
	}
	if (!allowed.every((flag) => flags.has(flag))) throw new Error('observation exception requires ID, release source SHA, immutable release image, actor and run ID together');
	const profile = flags.get('--exception-profile');
	if (profile !== undefined && profile !== 'image-bridge-36') throw new Error('invalid exception profile');
	const exception: ObservationException = {
		...(profile ? { profile } : {}),
		exceptionId: flags.get('--observation-exception-id')!,
		sourceSha: flags.get('--release-source-sha')!,
		image: flags.get('--release-image')!,
		actor: flags.get('--exception-actor')!,
		runId: flags.get('--exception-run-id')!,
	};
	validateObservationException(exception);
	return { command, exception };
}

async function migrationRows(databaseUrl: string): Promise<MigrationRow[]> {
	const prisma = createPrismaClientForDatabase(databaseUrl);
	try {
		return await prisma.$queryRawUnsafe<MigrationRow[]>(
			'SELECT migration_name, finished_at, rolled_back_at, checksum FROM "_prisma_migrations" ORDER BY started_at, migration_name',
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

const REQUIRED_OBSERVATION_METRICS = [
	'asset_download_legacy_fallback', 'asset_download_legacy_route', 'public_image_legacy_bridge',
	'public_image_legacy_fallback', 'public_webgl_legacy_bridge', 'public_webgl_legacy_fallback', 'export_legacy_fallback',
];

function receiptObservedTime(value: unknown): number {
	if (typeof value !== 'string') return Number.NaN;
	// migration_metrics uses PostgreSQL timestamp(3) without a timezone, stored as UTC.
	return Date.parse(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.]\d+)?$/.test(value) ? `${value}Z` : value);
}

function validReceiptEvidence(receipt: ExceptionReceipt): boolean {
	if (!Array.isArray(receipt.metrics) || !receipt.applied_at || typeof receipt.relocation_summary !== 'object' || !receipt.relocation_summary) return false;
	const metrics = receipt.metrics as Array<{ name?: unknown; scope?: unknown; value?: unknown; last_observed_at?: unknown; details?: unknown }>;
	const bridgeProfile = receipt.scope === BRIDGE_EXCEPTION_SCOPE;
	const pinned = (metric: typeof metrics[number]) => metric?.name === 'public_image_legacy_bridge' && metric.scope === 'api-route'
		&& metric.value === 36 && typeof metric.last_observed_at === 'string'
		&& receiptObservedTime(metric.last_observed_at) === Date.parse('2026-09-09T10:37:52.913Z')
		&& metric.details !== null && typeof metric.details === 'object' && !Array.isArray(metric.details)
		&& (metric.details as Record<string, unknown>)['usedLegacyLookup'] === false;
	if (bridgeProfile && metrics.filter(pinned).length !== 1) return false;
	if (!metrics.every((metric) => metric && (metric.value === 0 || (bridgeProfile && pinned(metric))))) return false;
	return REQUIRED_OBSERVATION_METRICS.every((name) => {
		const observations = metrics.filter((metric) => metric.name === name);
		return observations.length > 0 && observations.every((metric) => {
			const observed = receiptObservedTime(metric.last_observed_at);
			return Number.isFinite(observed) && observed <= receipt.applied_at!.getTime();
		});
	});
}

export function assertContractPath(rows: readonly MigrationRow[], receipt: ExceptionReceipt | null = null): void {
	assertNoFailedReleaseMigration(rows);
	const original = rows.some((row) => row.migration_name === CONTRACT_MIGRATION);
	const alternate = rows.filter((row) => isAlternateContract(row.migration_name));
	if (original && alternate.length) throw new Error('mixed original and observation exception contract migration history is forbidden');
	if (!alternate.length) {
		if (receipt) throw new Error('observation exception receipt exists without its completed Prisma migration');
		return;
	}
	if (alternate.length !== 1 || !receipt || !receipt.applied_at || !receipt.authorization_matches
		|| receipt.migration_name !== alternate[0]!.migration_name || receipt.scope !== scopeForPath(receipt.migration_name)
		|| (receipt.migration_name === BRIDGE_EXCEPTION_CONTRACT_MIGRATION && !completed(rows).has(BRIDGE_EXCEPTION_PREP_MIGRATION))
		|| !/^[0-9a-f]{64}$/.test(receipt.migration_checksum) || alternate[0]!.checksum !== receipt.migration_checksum
		|| !completed(rows).has(EXCEPTION_PREP_MIGRATION)
		|| !Number.isFinite(receipt.authorized_at.getTime()) || !Number.isFinite(receipt.expires_at.getTime())
		|| !Number.isFinite(receipt.applied_at.getTime()) || receipt.applied_at < receipt.authorized_at
		|| receipt.expires_at <= receipt.authorized_at || receipt.expires_at.getTime() - receipt.authorized_at.getTime() > 3_600_000
		|| !validReceiptEvidence(receipt)) {
		throw new Error('observation exception contract requires one completed migration and a valid matching applied authorization receipt');
	}
	validateObservationException({ exceptionId: receipt.exception_id, sourceSha: receipt.source_sha, image: receipt.image, actor: receipt.actor, runId: receipt.run_id });
}

export function releaseStatus(rows: readonly MigrationRow[], receipt: ExceptionReceipt | null = null) {
	assertContractPath(rows, receipt);
	const applied = completed(rows);
	return {
		baseline: applied.has(BASELINE_MIGRATION),
		canonicalExpand: applied.has(CANONICAL_EXPAND_MIGRATION),
		projectDraftExpand: applied.has(PROJECT_DRAFT_MIGRATION),
		projectSubmissionExpand: applied.has(PROJECT_SUBMISSION_MIGRATION),
		projectPublicationExpand: applied.has(PROJECT_PUBLICATION_MIGRATION),
		canonicalObjectRelocationExpand: applied.has(PHASE1_TARGET_MIGRATION),
		projectVideoOrderExpand: applied.has(PROJECT_VIDEO_ORDER_MIGRATION),
		expand: REQUIRED_EXPAND_MIGRATIONS.every((migration) => applied.has(migration)),
		contract: applied.has(CONTRACT_MIGRATION) || [...applied].some(isAlternateContract),
		contractPath: applied.has(BRIDGE_EXCEPTION_CONTRACT_MIGRATION) ? BRIDGE_EXCEPTION_CONTRACT_MIGRATION : applied.has(AGE_EXCEPTION_CONTRACT_MIGRATION) ? AGE_EXCEPTION_CONTRACT_MIGRATION : applied.has(CONTRACT_MIGRATION) ? CONTRACT_MIGRATION : null,
		observationExceptionReceipt: receipt ? {
			exceptionId: receipt.exception_id, sourceSha: receipt.source_sha, image: receipt.image,
			actor: receipt.actor, runId: receipt.run_id, scope: receipt.scope,
			migrationChecksum: receipt.migration_checksum, appliedAt: receipt.applied_at,
		} : null,
		projectChanges: applied.has(PROJECT_CHANGE_MIGRATION),
		completedMigrations: [...applied].sort(),
	};
}

export function assertNoFailedReleaseMigration(rows: readonly MigrationRow[]): void {
	const failed = rows.filter((row) => (
		(([...REQUIRED_EXPAND_MIGRATIONS, EXCEPTION_PREP_MIGRATION, BRIDGE_EXCEPTION_PREP_MIGRATION, CONTRACT_MIGRATION, AGE_EXCEPTION_CONTRACT_MIGRATION, BRIDGE_EXCEPTION_CONTRACT_MIGRATION, PROJECT_CHANGE_MIGRATION] as string[]).includes(row.migration_name) || row.migration_name > PROJECT_CHANGE_MIGRATION)
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

export function assertRuntime(rows: readonly MigrationRow[], phase: RuntimePhase, receipt: ExceptionReceipt | null = null): void {
	assertNoFailedReleaseMigration(rows);
	const status = releaseStatus(rows, receipt);
	if (!status.baseline) throw new Error(`required master baseline ${BASELINE_MIGRATION} is not applied`);
	if (phase === 'phase1' && (!status.expand || status.contract)) {
		throw new Error('phase1 runtime requires expand=applied and contract=not-applied');
	}
	if (phase === 'phase2' && (!status.expand || !status.contract || !status.projectChanges)) {
		throw new Error('phase2 runtime requires complete expand history, the contract migration DB record and project change migration DB record');
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

function isAlternateContract(name: string): boolean {
	return name === AGE_EXCEPTION_CONTRACT_MIGRATION || name === BRIDGE_EXCEPTION_CONTRACT_MIGRATION;
}
function exceptionPath(exception: ObservationException): string {
	return exception.profile === 'image-bridge-36' ? BRIDGE_EXCEPTION_CONTRACT_MIGRATION : AGE_EXCEPTION_CONTRACT_MIGRATION;
}
function scopeForPath(name: string): string {
	if (name === BRIDGE_EXCEPTION_CONTRACT_MIGRATION) return BRIDGE_EXCEPTION_SCOPE;
	if (name === AGE_EXCEPTION_CONTRACT_MIGRATION) return OBSERVATION_EXCEPTION_SCOPE;
	throw new Error('unknown alternate contract migration');
}

export function stageMigrationNames(names: readonly string[], target: string, alternate: boolean | string): string[] {
	const selected = names.filter((name) => name <= target && !(alternate && name === CONTRACT_MIGRATION));
	if (typeof alternate === 'string' && !isAlternateContract(alternate)) throw new Error('unknown alternate contract migration');
	if (!selected.includes(target)) throw new Error(`release image does not contain ${target}`);
	if (alternate && target >= CONTRACT_MIGRATION) selected.push(typeof alternate === 'string' ? alternate : AGE_EXCEPTION_CONTRACT_MIGRATION);
	return selected.sort();
}

async function exceptionChecksum(path: string): Promise<string> {
	scopeForPath(path);
	return createHash('sha256').update(await readFile(join(apiRoot(), 'prisma', 'contract-migration-paths', path, 'migration.sql'))).digest('hex');
}

async function exceptionReceipt(databaseUrl: string): Promise<ExceptionReceipt | null> {
	const prisma = createPrismaClientForDatabase(databaseUrl);
	try {
		const exists = await prisma.$queryRawUnsafe<{ receipt: string | null }[]>("SELECT to_regclass('release_contract_exception_receipts')::text AS receipt");
		if (!exists[0]?.receipt) return null;
		const receipts = await prisma.$queryRawUnsafe<ExceptionReceipt[]>(`
			SELECT r.*, (a.exception_id = r.exception_id AND a.scope = r.scope
			  AND a.source_sha = r.source_sha AND a.image = r.image AND a.actor = r.actor AND a.run_id = r.run_id
			  AND a.migration_checksum = r.migration_checksum AND a.authorized_at = r.authorized_at
			  AND a.expires_at = r.expires_at AND a.consumed_at IS NOT NULL) AS authorization_matches
			FROM release_contract_exception_receipts r
			LEFT JOIN release_contract_authorizations a ON a.migration_name = r.migration_name`);
		if (receipts.length > 1) throw new Error('multiple contract exception receipts are forbidden');
		const receipt = receipts[0] ?? null;
		if (receipt && receipt.migration_checksum !== await exceptionChecksum(receipt.migration_name)) throw new Error('release image alternate SQL differs from the applied exception receipt checksum');
		return receipt;
	} finally {
		await prisma.$disconnect();
	}
}

async function authorizeObservationException(databaseUrl: string, exception: ObservationException): Promise<void> {
	validateObservationException(exception);
	const path = exceptionPath(exception);
	const checksum = await exceptionChecksum(path);
	const prisma = createPrismaClientForDatabase(databaseUrl);
	try {
		await prisma.$transaction(async (tx) => {
			await tx.$executeRawUnsafe(`INSERT INTO release_contract_authorizations
			  (migration_name, exception_id, scope, source_sha, image, actor, run_id, migration_checksum)
			  VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (migration_name) DO NOTHING`,
			path, exception.exceptionId, scopeForPath(path),
			exception.sourceSha, exception.image, exception.actor, exception.runId, checksum);
			const matched = await tx.$queryRawUnsafe<{ valid: boolean }[]>(`SELECT (
			  exception_id = $2 AND scope = $3 AND source_sha = $4 AND image = $5 AND actor = $6
			  AND run_id = $7 AND migration_checksum = $8 AND consumed_at IS NULL
			  AND authorized_at <= CURRENT_TIMESTAMP AND expires_at > CURRENT_TIMESTAMP) AS valid
			  FROM release_contract_authorizations WHERE migration_name = $1 FOR UPDATE`,
			path, exception.exceptionId, scopeForPath(path),
			exception.sourceSha, exception.image, exception.actor, exception.runId, checksum);
			if (matched.length !== 1 || !matched[0]!.valid) throw new Error('existing exception authorization is expired, consumed or bound to a different release; manual review is required');
		});
	} finally {
		await prisma.$disconnect();
	}
}

async function stagedMigrate(target: string, databaseUrl: string, alternate: boolean | string = false): Promise<void> {
	const root = apiRoot();
	const sourcePrisma = join(root, 'prisma');
	const migrationNames = stageMigrationNames((await readdir(join(sourcePrisma, 'migrations'), { withFileTypes: true }))
		.filter((entry) => entry.isDirectory()).map((entry) => entry.name), target, alternate);

	const staging = await mkdtemp(join(tmpdir(), 'pcugame-release-migrate-'));
	try {
		await mkdir(join(staging, 'prisma', 'migrations'), { recursive: true });
		await cp(join(sourcePrisma, 'schema.prisma'), join(staging, 'prisma', 'schema.prisma'));
		await cp(join(sourcePrisma, 'migrations', 'migration_lock.toml'), join(staging, 'prisma', 'migrations', 'migration_lock.toml'));
		for (const name of migrationNames) {
			await cp(join(sourcePrisma, isAlternateContract(name) ? 'contract-migration-paths' : 'migrations', name), join(staging, 'prisma', 'migrations', name), { recursive: true });
		}
		await writeFile(join(staging, 'prisma.config.ts'), [
			// The temporary tree is outside node_modules ancestry; keep its config dependency-free.
			"export default { schema: 'prisma/schema.prisma', migrations: { path: 'prisma/migrations' }, datasource: { url: process.env['DATABASE_URL'] } };",
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
	const { command, phase, exception } = parseArgs(process.argv.slice(2));
	const databaseUrl = process.env['DATABASE_URL'];
	if (!databaseUrl) throw new Error('DATABASE_URL is required');
	let rows = await migrationRows(databaseUrl);
	assertNoFailedReleaseMigration(rows);
	let receipt = await exceptionReceipt(databaseUrl);
	let status = releaseStatus(rows, receipt);

	if (command === 'status') {
		console.log(JSON.stringify({ event: 'release_migration_status', ...status }, null, 2));
		return;
	}
	if (command === 'assert-runtime') {
		assertRuntime(rows, phase!, receipt);
		await verifyStorageBucketRegistry(databaseUrl);
		console.log(JSON.stringify({ event: 'release_runtime_schema_verified', phase, ...status }));
		return;
	}
	if (!status.baseline) {
		throw new Error(`required master baseline ${BASELINE_MIGRATION} is not applied; fresh/master-to-final direct deploy is forbidden`);
	}

	if (command === 'apply-expand') {
		if (status.contract) throw new Error('contract is already applied; expand runtime must never be deployed');
		if (!status.expand) await stagedMigrate(PHASE1_MIGRATION_CEILING, databaseUrl);
		await seedStorageBucketRegistry(databaseUrl);
	} else {
		if (!status.expand) throw new Error('contract cannot be applied before the Phase 1 expand release');
		await seedStorageBucketRegistry(databaseUrl);
		await verifyStorageBucketRegistry(databaseUrl);
		if (exception && status.contractPath === CONTRACT_MIGRATION) throw new Error('cannot attach an observation exception to an already applied original contract');
		if (exception && receipt && (receipt.exception_id !== exception.exceptionId || receipt.source_sha !== exception.sourceSha
			|| receipt.migration_name !== exceptionPath(exception) || receipt.image !== exception.image || receipt.actor !== exception.actor || receipt.run_id !== exception.runId)) {
			throw new Error('provided exception authorization differs from the applied receipt');
		}
		if (exception && !status.contract) {
			await stagedMigrate(exception.profile ? BRIDGE_EXCEPTION_PREP_MIGRATION : EXCEPTION_PREP_MIGRATION, databaseUrl);
			await authorizeObservationException(databaseUrl, exception);
		}
		const latestMigration = (await readdir(join(apiRoot(), 'prisma', 'migrations'), { withFileTypes: true }))
			.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().at(-1);
		if (!latestMigration || latestMigration < PROJECT_CHANGE_MIGRATION) throw new Error('release image is missing current contract migrations');
		const recordedPath = status.contractPath && isAlternateContract(status.contractPath) ? status.contractPath : false;
		await stagedMigrate(latestMigration, databaseUrl, exception ? exceptionPath(exception) : recordedPath);
	}

	rows = await migrationRows(databaseUrl);
	receipt = await exceptionReceipt(databaseUrl);
	status = releaseStatus(rows, receipt);
	if (command === 'apply-expand') assertRuntime(rows, 'phase1', receipt);
	else assertRuntime(rows, 'phase2', receipt);
	console.log(JSON.stringify({ event: 'release_migration_applied_and_recorded', command, ...status }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	void main().catch((error) => {
		console.error(JSON.stringify({
			event: 'release_migration_failed_closed',
			message: error instanceof Error ? error.message : String(error),
		}));
		process.exitCode = 1;
	});
}
