import { describe, expect, it } from 'vitest';
import {
	BASELINE_MIGRATION,
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
