import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const baseConstraintMigration = new URL(
	'../../prisma/migrations/20260721010000_game_upload_state_constraints/migration.sql',
	import.meta.url,
);
const sourceIdentityMigration = new URL(
	'../../prisma/migrations/20260820000000_game_upload_source_identity/migration.sql',
	import.meta.url,
);
const directMigration = new URL(
	'../../prisma/migrations/20260820120000_direct_game_upload_transport/migration.sql',
	import.meta.url,
);

describe('direct game-upload expand migration', () => {
	it('drops only constraint names established by checked-in base migrations', async () => {
		const [base, source, direct] = await Promise.all([
			readFile(baseConstraintMigration, 'utf8'),
			readFile(sourceIdentityMigration, 'utf8'),
			readFile(directMigration, 'utf8'),
		]);
		expect(base).toContain('CONSTRAINT "game_upload_sessions_status_check"');
		expect(source).toContain('CONSTRAINT "game_upload_sessions_active_source_identity_check"');
		expect(direct).toContain('DROP CONSTRAINT "game_upload_sessions_status_check"');
		expect(direct).toContain(
			'DROP CONSTRAINT "game_upload_sessions_active_source_identity_check"',
		);
	});

	it('defaults existing rows to proxy transport and constrains the direct lifecycle', async () => {
		const migration = await readFile(directMigration, 'utf8');
		expect(migration).toContain(
			'ADD COLUMN "transport" "GameUploadTransport" NOT NULL DEFAULT \'API_CHUNK_PROXY\'',
		);
		for (const state of [
			'PENDING', 'COMPLETING', 'VERIFYING', 'COMPLETED',
			'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED',
		]) {
			expect(migration).toContain(`'${state}'`);
		}
		expect(migration).toContain('game_upload_sessions_transport_state_check');
		expect(migration).toContain('game_upload_sessions_verification_claim_idx');
	});
});
