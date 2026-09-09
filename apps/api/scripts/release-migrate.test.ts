import { describe, expect, it } from 'vitest';
import {
	BASELINE_MIGRATION,
	CONTRACT_MIGRATION,
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
		const history = [...completePhase1History(), completedMigration(CONTRACT_MIGRATION)];
		expect(() => assertRuntime(history, 'phase2')).not.toThrow();
		expect(() => assertRuntime(history, 'phase1')).toThrow('contract=not-applied');
	});

	it('rejects a contract receipt with missing prerequisite history', () => {
		const history = [...completePhase1History(), completedMigration(CONTRACT_MIGRATION)]
			.filter((row) => row.migration_name !== PROJECT_PUBLICATION_MIGRATION);
		expect(() => assertRuntime(history, 'phase2')).toThrow('complete expand history');
	});
});
