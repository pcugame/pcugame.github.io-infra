import { describe, expect, it } from 'vitest';
import { assertExactMigrationHistory, parseArgs, type MigrationRow } from './release-migrate.js';

const row: MigrationRow = { migration_name: '001', checksum: 'a'.repeat(64), finished_at: new Date(), rolled_back_at: null };
const image = new Map([['001', 'a'.repeat(64)]]);
describe('no-change release migration gate', () => {
	it('accepts only the exact successful image history', () => {
		expect(parseArgs(['assert-unchanged'])).toEqual({ command: 'assert-unchanged' });
		expect(() => assertExactMigrationHistory([row], image)).not.toThrow();
	});
	for (const [name, rows] of Object.entries({
		pending: [], unknown: [row, { ...row, migration_name: '002' }],
		failed: [{ ...row, finished_at: null }], rollback: [{ ...row, rolled_back_at: new Date() }],
		checksum: [{ ...row, checksum: 'b'.repeat(64) }], duplicate: [row, row],
	})) it(`rejects ${name} before switching`, () => {
		expect(() => assertExactMigrationHistory(rows, image)).toThrow();
	});
});
