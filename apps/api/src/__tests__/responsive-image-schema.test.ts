import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const foundationMigrationUrl = new URL(
	'../../prisma/migrations/20260812000000_responsive_image_foundation/migration.sql',
	import.meta.url,
);
const deterministicMigrationUrl = new URL(
	'../../prisma/migrations/20260812010000_deterministic_responsive_images/migration.sql',
	import.meta.url,
);

describe('responsive image schema migration history', () => {
	it('keeps the unapplied foundation migration atomic and model-free', async () => {
		const sql = await readFile(foundationMigrationUrl, 'utf8');

		expect(sql.trimStart().indexOf('BEGIN;')).toBeLessThan(sql.indexOf('ALTER TABLE'));
		expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
		expect(sql).toContain('ADD COLUMN "width" INTEGER');
		expect(sql).toContain('ADD COLUMN "height" INTEGER');
		expect(sql).toContain('ADD COLUMN "poster_width" INTEGER');
		expect(sql).toContain('ADD COLUMN "poster_height" INTEGER');
		expect(sql).not.toContain('ImageRenditionProfile');
		expect(sql).not.toContain('image_renditions');
	});

	it('moves deterministic readiness state onto owners in a follow-up migration', async () => {
		const sql = await readFile(deterministicMigrationUrl, 'utf8');

		expect(sql).toContain('BEGIN ISOLATION LEVEL READ COMMITTED;');
		expect(sql.indexOf('BEGIN ISOLATION LEVEL READ COMMITTED;')).toBeLessThan(
			sql.indexOf('DO $migration$'),
		);
		expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
		expect(sql).toContain('ADD COLUMN "card_480_height" INTEGER');
		expect(sql).toContain('ADD COLUMN "display_960_height" INTEGER');
		expect(sql).toContain('ADD COLUMN "poster_card_480_height" INTEGER');
		expect(sql).toContain('ADD COLUMN "poster_display_960_height" INTEGER');
		expect(sql).not.toMatch(/ADD COLUMN "(?:poster_)?(?:width|height)" INTEGER NOT NULL/);
		expect(sql).not.toContain('UPDATE "assets"');
		expect(sql).not.toContain('UPDATE "exhibitions"');
		expect(sql).toContain('rendition_inventory REGCLASS');
		expect(sql).toContain("to_regclass('\"image_renditions\"')");
		expect(sql).toContain("current_setting('transaction_isolation') <> 'read committed'");
		expect(sql).toMatch(/RAISE EXCEPTION[\s\S]*requires READ COMMITTED isolation/);
		expect(sql).toContain("'LOCK TABLE %s IN ACCESS EXCLUSIVE MODE'");
		expect(sql).toContain("'SELECT EXISTS (SELECT 1 FROM %s)'");
		expect(sql.indexOf("'LOCK TABLE %s IN ACCESS EXCLUSIVE MODE'")).toBeLessThan(
			sql.indexOf("'SELECT EXISTS (SELECT 1 FROM %s)'"),
		);
		expect(sql).toMatch(/RAISE EXCEPTION[\s\S]*Cannot remove non-empty image_renditions/);
		expect(sql.indexOf('RAISE EXCEPTION')).toBeLessThan(
			sql.indexOf('ADD COLUMN "card_480_height" INTEGER'),
		);
		expect(sql).toContain('DROP TABLE IF EXISTS "image_renditions"');
		expect(sql).toContain('DROP TYPE IF EXISTS "ImageRenditionProfile"');
	});

	it('validates that canonical source columns cannot occupy the rendition namespace', async () => {
		const sql = await readFile(deterministicMigrationUrl, 'utf8');

		expect(sql).toContain(
			'CONSTRAINT "assets_storage_key_not_deterministic_rendition_check" CHECK',
		);
		expect(sql).toContain(
			'CONSTRAINT "exhibitions_poster_key_not_deterministic_rendition_check" CHECK',
		);
		expect(sql).toContain('"poster_storage_key" IS NULL');
		expect(sql.match(/right\("storage_key"/g)).toHaveLength(2);
		expect(sql.match(/right\("poster_storage_key"/g)).toHaveLength(2);
		expect(sql.match(/\/__pcu_image_rendition__\/v1\/card-480[.]webp/g)).toHaveLength(6);
		expect(sql.match(/\/__pcu_image_rendition__\/v1\/display-960[.]webp/g)).toHaveLength(6);
		expect(sql).not.toContain('NOT VALID');
	});
});
