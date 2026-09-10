import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	TRAFFIC_EXCEPTION_CONTRACT_MIGRATION,
	TRAFFIC_EXCEPTION_PREP_MIGRATION,
	TRAFFIC_EXCEPTION_SCOPE,
	BRIDGE_EXCEPTION_CONTRACT_MIGRATION,
	BRIDGE_EXCEPTION_PREP_MIGRATION,
	BRIDGE_EXCEPTION_SCOPE,
	AGE_EXCEPTION_CONTRACT_MIGRATION,
	EXCEPTION_PREP_MIGRATION,
	OBSERVATION_EXCEPTION_SCOPE,
	parseArgs,
	validateObservationException,
	stageMigrationNames,
	type ExceptionReceipt,
	BASELINE_MIGRATION,
	CONTRACT_MIGRATION,
	PROJECT_CHANGE_MIGRATION,
	PROJECT_VIDEO_ORDER_MIGRATION,
	PROJECT_PUBLICATION_MIGRATION,
	REQUIRED_EXPAND_MIGRATIONS,
	assertNoFailedReleaseMigration,
	assertRuntime,
	releaseStatus,
	type MigrationRow,
} from './release-migrate.js';

const appliedAt = new Date('2026-08-24T00:00:00.000Z');

function completedMigration(migrationName: string): MigrationRow {
	return { migration_name: migrationName, finished_at: appliedAt, rolled_back_at: null };
}

function completePhase1History(): MigrationRow[] {
	return [BASELINE_MIGRATION, ...REQUIRED_EXPAND_MIGRATIONS].map(completedMigration);
}

describe('Phase 1 release migration history policy', () => {
	it('requires the additive project video order migration before Phase 1 can run', () => {
		const missing = completePhase1History().filter(
			(row) => row.migration_name !== PROJECT_VIDEO_ORDER_MIGRATION,
		);

		expect(releaseStatus(missing)).toMatchObject({
			canonicalObjectRelocationExpand: true,
			projectVideoOrderExpand: false,
			expand: false,
		});
		expect(() => assertRuntime(missing, 'phase1')).toThrow('phase1 runtime requires expand=applied');
	});

	it('rejects history missing the project publication expand migration', () => {
		const missing = completePhase1History().filter(
			(row) => row.migration_name !== PROJECT_PUBLICATION_MIGRATION,
		);

		expect(releaseStatus(missing)).toMatchObject({
			projectPublicationExpand: false,
			canonicalObjectRelocationExpand: true,
			expand: false,
		});
		expect(() => assertRuntime(missing, 'phase1')).toThrow('phase1 runtime requires expand=applied');
	});

	it.each([
		{ finished_at: null, rolled_back_at: null },
		{ finished_at: appliedAt, rolled_back_at: appliedAt },
	])('rejects malformed project publication history %#', ({ finished_at, rolled_back_at }) => {
		const malformed = completePhase1History().map((row) => (
			row.migration_name === PROJECT_PUBLICATION_MIGRATION
				? { ...row, finished_at, rolled_back_at }
				: row
		));

		expect(() => assertNoFailedReleaseMigration(malformed)).toThrow(
			`release migration history contains failed/rolled-back rows: ${PROJECT_PUBLICATION_MIGRATION}`,
		);
	});
});


describe('Phase 2 release migration history policy', () => {
	it('rejects the current Phase 1 database until contract is applied', () => {
		expect(() => assertRuntime(completePhase1History(), 'phase2')).toThrow('contract migration DB record');
	});

	it('accepts complete contract history and fences out Phase 1', () => {
		const history = [...completePhase1History(), completedMigration(CONTRACT_MIGRATION), completedMigration(PROJECT_CHANGE_MIGRATION)];
		expect(() => assertRuntime(history, 'phase2')).not.toThrow();
		expect(() => assertRuntime(history, 'phase1')).toThrow('contract=not-applied');
	});

	it('rejects a contract receipt with missing prerequisite history', () => {
		const history = [...completePhase1History(), completedMigration(CONTRACT_MIGRATION), completedMigration(PROJECT_CHANGE_MIGRATION)]
			.filter((row) => row.migration_name !== PROJECT_PUBLICATION_MIGRATION);
		expect(() => assertRuntime(history, 'phase2')).toThrow('complete expand history');
	});
});

describe('project change release schema', () => {
	it('requires the additive request migration for the new phase2 runtime', () => {
		const old = [...completePhase1History(), completedMigration(CONTRACT_MIGRATION)];
		expect(() => assertRuntime(old, 'phase2')).toThrow('project change migration');
		expect(() => assertRuntime([...old, completedMigration(PROJECT_CHANGE_MIGRATION)], 'phase2')).not.toThrow();
	});
	it('does not add the request migration to phase1 or waive its contract prohibition', () => {
		expect(() => assertRuntime(completePhase1History(), 'phase1')).not.toThrow();
		expect(() => assertRuntime([...completePhase1History(), completedMigration(CONTRACT_MIGRATION), completedMigration(PROJECT_CHANGE_MIGRATION)], 'phase1')).toThrow();
	});
	it('rejects a failed request migration', () => {
		expect(() => assertNoFailedReleaseMigration([{ migration_name: PROJECT_CHANGE_MIGRATION, finished_at: null, rolled_back_at: null }])).toThrow(PROJECT_CHANGE_MIGRATION);
	});
});

const exception = {
	exceptionId: 'review-123:age-only', sourceSha: 'a'.repeat(40),
	image: `ghcr.io/pcugame/pcu-graduationproject-v2-api@sha256:${'b'.repeat(64)}`, actor: 'pcugame-admin', runId: '123456',
};
const exceptionFlags = [
	'--observation-exception-id', exception.exceptionId, '--release-source-sha', exception.sourceSha,
	'--release-image', exception.image, '--exception-actor', exception.actor, '--exception-run-id', exception.runId,
];
const alternateChecksum = createHash('sha256').update(readFileSync(new URL(
	`../prisma/contract-migration-paths/${AGE_EXCEPTION_CONTRACT_MIGRATION}/migration.sql`, import.meta.url,
))).digest('hex');
function alternateHistory(): MigrationRow[] {
	return [...completePhase1History(), completedMigration(EXCEPTION_PREP_MIGRATION),
		{ ...completedMigration(AGE_EXCEPTION_CONTRACT_MIGRATION), checksum: alternateChecksum }, completedMigration(PROJECT_CHANGE_MIGRATION)];
}
function receipt(): ExceptionReceipt {
	return {
		migration_name: AGE_EXCEPTION_CONTRACT_MIGRATION, exception_id: exception.exceptionId,
		source_sha: exception.sourceSha, image: exception.image, actor: exception.actor, run_id: exception.runId,
		scope: OBSERVATION_EXCEPTION_SCOPE, migration_checksum: alternateChecksum,
		authorized_at: new Date('2026-08-23T23:30:00Z'), expires_at: new Date('2026-08-24T00:30:00Z'),
		applied_at: appliedAt, authorization_matches: true,
		metrics: ['asset_download_legacy_fallback', 'asset_download_legacy_route', 'public_image_legacy_bridge',
			'public_image_legacy_fallback', 'public_webgl_legacy_bridge', 'public_webgl_legacy_fallback', 'export_legacy_fallback']
			.map((name) => ({ name, value: 0, last_observed_at: '2026-08-23T23:00:00Z' })),
		relocation_summary: { total: 0, by_state: {} },
	};
}

describe('explicit observation age authorization arguments', () => {
	it('keeps normal interfaces and accepts all provenance only on explicit contract exceptions', () => {
		expect(parseArgs(['apply-contract'])).toEqual({ command: 'apply-contract' });
		expect(parseArgs(['assert-runtime', 'phase2'])).toEqual({ command: 'assert-runtime', phase: 'phase2' });
		expect(parseArgs(['apply-contract', ...exceptionFlags])).toEqual({ command: 'apply-contract', exception });
	});
	it.each(['status', 'apply-expand', 'assert-runtime'])('rejects exception flags on %s', (command) => {
		expect(() => parseArgs([command, ...exceptionFlags])).toThrow();
	});
	it('rejects partial, unknown, repeated, or value-less flags', () => {
		for (const invalid of [exceptionFlags.slice(0, -2), [...exceptionFlags, '--unsafe'], [...exceptionFlags, ...exceptionFlags.slice(0, 2)], ['--waive-metrics', 'true']]) {
			expect(() => parseArgs(['apply-contract', ...invalid])).toThrow();
		}
	});
	it.each([
		{ sourceSha: 'abc1234' }, { sourceSha: 'A'.repeat(40) }, { image: 'ghcr.io/pcugame/pcu-graduationproject-v2-api:latest' },
		{ image: `ghcr.io/pcugame/pcu-graduationproject-v2-api@sha256:${'b'.repeat(63)}` }, { exceptionId: 'bad id' },
		{ actor: 'operator;command' }, { runId: '123/attempts' },
	])('rejects malformed provenance %#', (override) => {
		expect(() => validateObservationException({ ...exception, ...override })).toThrow();
	});
});

describe('honest alternate contract history', () => {
	it('accepts a completed alternate with matching receipt and fences Phase 1', () => {
		expect(() => assertRuntime(alternateHistory(), 'phase2', receipt())).not.toThrow();
		expect(releaseStatus(alternateHistory(), receipt())).toMatchObject({ contract: true, contractPath: AGE_EXCEPTION_CONTRACT_MIGRATION });
		expect(() => assertRuntime(alternateHistory(), 'phase1', receipt())).toThrow('contract=not-applied');
	});
	it('emits provenance only, preserving metric scopes and object mappings in the database', () => {
		const output = releaseStatus(alternateHistory(), receipt()).observationExceptionReceipt;
		expect(output).toMatchObject({ exceptionId: exception.exceptionId, image: exception.image, runId: exception.runId });
		expect(output).not.toHaveProperty('metrics');
		expect(output).not.toHaveProperty('relocation_summary');
	});
	it.each([
		{ value: 1 }, { last_observed_at: null }, { last_observed_at: '-infinity' },
		{ last_observed_at: '2027-01-01T00:00:00Z' },
	])('rejects malformed receipt metric evidence %#', (override) => {
		const candidate = receipt();
		candidate.metrics = (candidate.metrics as Array<Record<string, unknown>>).map((metric, index) => index === 0 ? { ...metric, ...override } : metric);
		expect(() => assertRuntime(alternateHistory(), 'phase2', candidate)).toThrow();
	});
	it('rejects missing receipt, orphan receipt, mixed histories and missing preparation', () => {
		expect(() => assertRuntime(alternateHistory(), 'phase2')).toThrow('valid matching applied authorization receipt');
		expect(() => releaseStatus(completePhase1History(), receipt())).toThrow('without its completed Prisma migration');
		expect(() => releaseStatus([...alternateHistory(), completedMigration(CONTRACT_MIGRATION)], receipt())).toThrow('mixed');
		expect(() => releaseStatus(alternateHistory().filter((row) => row.migration_name !== EXCEPTION_PREP_MIGRATION), receipt())).toThrow();
	});
	it.each([
		{ applied_at: null }, { authorization_matches: false }, { migration_checksum: 'c'.repeat(64) },
		{ migration_name: CONTRACT_MIGRATION }, { scope: 'skip-all-metrics' }, { source_sha: 'abcd' },
		{ image: 'ghcr.io/pcugame/pcu-graduationproject-v2-api:master' }, { authorized_at: new Date('invalid') },
		{ expires_at: new Date('2026-08-24T04:30:00Z') }, { metrics: null }, { metrics: [] }, { relocation_summary: null },
	])('rejects invalid receipt %#', (override) => {
		expect(() => assertRuntime(alternateHistory(), 'phase2', { ...receipt(), ...override })).toThrow();
	});
	it.each([{ finished_at: null, rolled_back_at: null }, { finished_at: appliedAt, rolled_back_at: appliedAt }])('rejects failed alternate history %#', (override) => {
		const history = alternateHistory().map((row) => row.migration_name === AGE_EXCEPTION_CONTRACT_MIGRATION ? { ...row, ...override } : row);
		expect(() => releaseStatus(history, receipt())).toThrow('failed/rolled-back');
	});
	it('retains the normal graph and always replaces the original on a recorded alternate branch', () => {
		const names = [...completePhase1History().map((row) => row.migration_name), EXCEPTION_PREP_MIGRATION, CONTRACT_MIGRATION, PROJECT_CHANGE_MIGRATION];
		expect(stageMigrationNames(names, PROJECT_CHANGE_MIGRATION, false)).toEqual([...names].sort());
		const selected = stageMigrationNames(names, PROJECT_CHANGE_MIGRATION, true);
		expect(selected).toContain(AGE_EXCEPTION_CONTRACT_MIGRATION);
		expect(selected).not.toContain(CONTRACT_MIGRATION);
		expect(stageMigrationNames(names, EXCEPTION_PREP_MIGRATION, true)).not.toContain(AGE_EXCEPTION_CONTRACT_MIGRATION);
		const future = '20261001000000_future_additive';
		const recordedAlternate = releaseStatus(alternateHistory(), receipt()).contractPath === AGE_EXCEPTION_CONTRACT_MIGRATION;
		expect(stageMigrationNames([...names, future], future, recordedAlternate)).toEqual([...selected, future]);
	});
	it('preserves all original SQL beyond receipt metadata and explicit observation changes', () => {
		const original = readFileSync(new URL(`../prisma/migrations/${CONTRACT_MIGRATION}/migration.sql`, import.meta.url), 'utf8');
		const alternate = readFileSync(new URL(`../prisma/contract-migration-paths/${AGE_EXCEPTION_CONTRACT_MIGRATION}/migration.sql`, import.meta.url), 'utf8');
		const stripped = alternate.replace(/-- Explicit alternate history:[\s\S]*?(?=DO \$contract_preflight\$)/, '')
			.replace(/-- Successful completion is durable[\s\S]*?(?=COMMIT;)/, '')
			.replace('IF TRUE THEN -- An explicit exception requires all seven observations even on an empty database.', 'IF has_business_data THEN')
			.replace('        OR bool_or(NOT isfinite(metric."last_observed_at"))\n', '')
			.replace('OR max(metric."last_observed_at") > CURRENT_TIMESTAMP\n', 'OR max(metric."last_observed_at") > CURRENT_TIMESTAMP - INTERVAL \'24 hours\'\n');
		expect(stripped).toBe(original);
	});
});


describe('pinned bridge36 release history', () => {
 function bridgeReceipt(): ExceptionReceipt {
  const candidate = receipt();
  return { ...candidate, migration_name: BRIDGE_EXCEPTION_CONTRACT_MIGRATION, scope: BRIDGE_EXCEPTION_SCOPE,
   authorized_at: new Date('2026-09-10T00:00:00Z'), expires_at: new Date('2026-09-10T01:00:00Z'), applied_at: new Date('2026-09-10T00:01:00Z'),
   metrics: [...candidate.metrics as unknown[], { name: 'public_image_legacy_bridge', scope: 'api-route', value: 36, last_observed_at: '2026-09-09T10:37:52.913Z', details: { usedLegacyLookup: false } }],
  };
 }
 function history() { return [...completePhase1History(), completedMigration(EXCEPTION_PREP_MIGRATION), completedMigration(BRIDGE_EXCEPTION_PREP_MIGRATION), { ...completedMigration(BRIDGE_EXCEPTION_CONTRACT_MIGRATION), checksum: alternateChecksum }, completedMigration(PROJECT_CHANGE_MIGRATION)]; }
 it('parses profile without changing the age-only default', () => {
  expect(parseArgs(['apply-contract', ...exceptionFlags, '--exception-profile', 'image-bridge-36']).exception?.profile).toBe('image-bridge-36');
  expect(() => parseArgs(['apply-contract', ...exceptionFlags, '--exception-profile', 'anything'])).toThrow();
 });
 it('recognizes genuine bridge history and stages future additions on that same path', () => {
  expect(() => assertRuntime(history(), 'phase2', bridgeReceipt())).not.toThrow();
  const naive = bridgeReceipt();
  Object.assign((naive.metrics as Array<Record<string, unknown>>).at(-1)!, { last_observed_at: '2026-09-09T10:37:52.913' });
  expect(() => assertRuntime(history(), 'phase2', naive)).not.toThrow();
  const path = releaseStatus(history(), bridgeReceipt()).contractPath!;
  expect(path).toBe(BRIDGE_EXCEPTION_CONTRACT_MIGRATION);
  expect(stageMigrationNames([CONTRACT_MIGRATION, PROJECT_CHANGE_MIGRATION, '20261001000000_next'], '20261001000000_next', path)).toEqual([BRIDGE_EXCEPTION_CONTRACT_MIGRATION, PROJECT_CHANGE_MIGRATION, '20261001000000_next']);
 });
 it('rejects missing prep, mixed alternatives, and altered receipt evidence', () => {
  expect(() => releaseStatus(history().filter((r) => r.migration_name !== BRIDGE_EXCEPTION_PREP_MIGRATION), bridgeReceipt())).toThrow();
  expect(() => releaseStatus([...history(), completedMigration(AGE_EXCEPTION_CONTRACT_MIGRATION)], bridgeReceipt())).toThrow();
  for (const override of [{ value: 37 }, { value: 35 }, { scope: 'other' }, { details: { usedLegacyLookup: true } }, { last_observed_at: '2026-09-09T10:37:52.914Z' }]) {
   const candidate = bridgeReceipt();
   Object.assign((candidate.metrics as Array<Record<string, unknown>>).at(-1)!, override);
   expect(() => releaseStatus(history(), candidate)).toThrow();
  }
 });
});

it('preserves age-path DDL and all non-observation guards in the pinned path', () => {
 const read = (name: string) => readFileSync(new URL(`../prisma/contract-migration-paths/${name}/migration.sql`, import.meta.url), 'utf8');
 const age = read(AGE_EXCEPTION_CONTRACT_MIGRATION);
 const bridge = read(BRIDGE_EXCEPTION_CONTRACT_MIGRATION)
  .replaceAll(BRIDGE_EXCEPTION_CONTRACT_MIGRATION, AGE_EXCEPTION_CONTRACT_MIGRATION)
  .replaceAll(BRIDGE_EXCEPTION_SCOPE, OBSERVATION_EXCEPTION_SCOPE)
  .replace('the observation age and one pinned image bridge record are waived.', 'only the observation age comparison is waived.');
 const removeMetricSection = (sql: string) => sql.replace(/  SELECT count\(\*\) INTO violations\n  FROM "migration_metrics"[\s\S]*?(?=  SELECT count\(\*\) INTO violations\n  FROM "game_upload_sessions")/, '<METRIC_GUARDS>');
 expect(removeMetricSection(bridge)).toBe(removeMetricSection(age));
});


it('fails closed on a future additive migration that did not finish', () => {
 expect(() => assertNoFailedReleaseMigration([{ migration_name: '20261001000000_next', finished_at: null, rolled_back_at: null }])).toThrow('failed/rolled-back');
});


describe('image bridge traffic release authorization', () => {
	function evidence(count: number): ExceptionReceipt {
		const candidate = receipt();
		return { ...candidate, migration_name: TRAFFIC_EXCEPTION_CONTRACT_MIGRATION, scope: TRAFFIC_EXCEPTION_SCOPE,
			metrics: [...candidate.metrics as unknown[], { name: 'public_image_legacy_bridge', scope: 'api-route', value: count, last_observed_at: '2026-08-23T23:00:00Z', details: { usedLegacyLookup: false } }],
		};
	}
	function history(): MigrationRow[] {
		return [...completePhase1History(), completedMigration(EXCEPTION_PREP_MIGRATION), completedMigration(BRIDGE_EXCEPTION_PREP_MIGRATION), completedMigration(TRAFFIC_EXCEPTION_PREP_MIGRATION), { ...completedMigration(TRAFFIC_EXCEPTION_CONTRACT_MIGRATION), checksum: alternateChecksum }, completedMigration(PROJECT_CHANGE_MIGRATION)];
	}
	it('requires a named explicit profile with full existing provenance', () => {
		expect(parseArgs(['apply-contract', ...exceptionFlags, '--exception-profile', 'image-bridge-traffic']).exception?.profile).toBe('image-bridge-traffic');
		expect(() => parseArgs(['apply-contract', '--exception-profile', 'image-bridge-traffic'])).toThrow();
	});
	it.each([0, 1, 37, 1000, Number.MAX_SAFE_INTEGER])('accepts count %s with genuine alternate history', (count) => {
		expect(() => assertRuntime(history(), 'phase2', evidence(count))).not.toThrow();
		expect(releaseStatus(history(), evidence(count)).contractPath).toBe(TRAFFIC_EXCEPTION_CONTRACT_MIGRATION);
	});
	it.each([{ value: -1 }, { value: Number.MAX_SAFE_INTEGER + 1 }, { value: 1.5 }, { scope: 'other' }, { details: { usedLegacyLookup: true } }, { details: { usedLegacyLookup: 'false' } }, { details: null }, { last_observed_at: null }, { last_observed_at: '2027-01-01T00:00:00Z' }])('rejects invalid bridge evidence %#', (override) => {
		const candidate = evidence(37);
		Object.assign((candidate.metrics as Array<Record<string, unknown>>).at(-1)!, override);
		expect(() => releaseStatus(history(), candidate)).toThrow();
	});
	it('rejects other fallback, missing prep, and mixed alternatives', () => {
		const candidate = evidence(37);
		(candidate.metrics as Array<Record<string, unknown>>).push({ name: 'public_image_legacy_fallback', value: 1, last_observed_at: '2026-08-23T23:00:00Z' });
		expect(() => releaseStatus(history(), candidate)).toThrow();
		expect(() => releaseStatus(history().filter((row) => row.migration_name !== TRAFFIC_EXCEPTION_PREP_MIGRATION), evidence(37))).toThrow();
		expect(() => releaseStatus([...history(), completedMigration(BRIDGE_EXCEPTION_CONTRACT_MIGRATION)], evidence(37))).toThrow();
	});
	it('retains the traffic path while staging future additive migrations', () => {
		const path = releaseStatus(history(), evidence(37)).contractPath!;
		expect(stageMigrationNames([CONTRACT_MIGRATION, PROJECT_CHANGE_MIGRATION, '20261001000000_next'], '20261001000000_next', path)).toEqual([TRAFFIC_EXCEPTION_CONTRACT_MIGRATION, PROJECT_CHANGE_MIGRATION, '20261001000000_next']);
	});
	it('preserves all prior non-metric SQL guards and DDL', () => {
		const read = (name: string) => readFileSync(new URL(`../prisma/contract-migration-paths/${name}/migration.sql`, import.meta.url), 'utf8');
		const age = read(AGE_EXCEPTION_CONTRACT_MIGRATION);
		const traffic = read(TRAFFIC_EXCEPTION_CONTRACT_MIGRATION)
			.replaceAll(TRAFFIC_EXCEPTION_CONTRACT_MIGRATION, AGE_EXCEPTION_CONTRACT_MIGRATION)
			.replaceAll(TRAFFIC_EXCEPTION_SCOPE, OBSERVATION_EXCEPTION_SCOPE)
			.replace('observation age and canonical image bridge traffic counts are waived.', 'only the observation age comparison is waived.');
		const removeMetricSection = (sql: string) => sql.replace(/  SELECT count\(\*\) INTO violations\n  FROM "migration_metrics"[\s\S]*?(?=  SELECT count\(\*\) INTO violations\n  FROM "game_upload_sessions")/, '<METRIC_GUARDS>');
		expect(removeMetricSection(traffic)).toBe(removeMetricSection(age));
	});
});
