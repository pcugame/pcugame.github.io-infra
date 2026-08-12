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
	it('preserves the already-published foundation migration', async () => {
		const sql = await readFile(foundationMigrationUrl, 'utf8');

		expect(sql).toContain('ADD COLUMN "width" INTEGER');
		expect(sql).toContain('ADD COLUMN "height" INTEGER');
		expect(sql).toContain('ADD COLUMN "poster_width" INTEGER');
		expect(sql).toContain('ADD COLUMN "poster_height" INTEGER');
		expect(sql).toContain("CREATE TYPE \"ImageRenditionProfile\" AS ENUM ('CARD_480', 'DISPLAY_960')");
		expect(sql).toContain('CREATE TABLE "image_renditions"');
		expect(sql).toContain('CONSTRAINT "image_renditions_owner_xor_check" CHECK');
	});

	it('moves deterministic readiness state onto owners in a follow-up migration', async () => {
		const sql = await readFile(deterministicMigrationUrl, 'utf8');

		expect(sql).toContain('ADD COLUMN "card_480_height" INTEGER');
		expect(sql).toContain('ADD COLUMN "display_960_height" INTEGER');
		expect(sql).toContain('ADD COLUMN "poster_card_480_height" INTEGER');
		expect(sql).toContain('ADD COLUMN "poster_display_960_height" INTEGER');
		expect(sql).not.toMatch(/ADD COLUMN "(?:poster_)?(?:width|height)" INTEGER NOT NULL/);
		expect(sql).not.toContain('UPDATE "assets"');
		expect(sql).not.toContain('UPDATE "exhibitions"');
		expect(sql).toContain('IF EXISTS (SELECT 1 FROM "image_renditions")');
		expect(sql).toMatch(/RAISE EXCEPTION[\s\S]*Cannot remove non-empty image_renditions/);
		expect(sql.indexOf('RAISE EXCEPTION')).toBeLessThan(
			sql.indexOf('DROP TABLE "image_renditions"'),
		);
		expect(sql).toContain('DROP TABLE "image_renditions"');
		expect(sql).toContain('DROP TYPE "ImageRenditionProfile"');
	});

	it('validates that canonical source columns cannot occupy the rendition namespace', async () => {
		const sql = await readFile(deterministicMigrationUrl, 'utf8');

		expect(sql).toContain(
			'CONSTRAINT "assets_storage_key_not_deterministic_rendition_check" CHECK',
		);
		expect(sql).toContain(
			'CONSTRAINT "exhibitions_poster_storage_key_not_deterministic_rendition_check" CHECK',
		);
		expect(sql).toContain('"poster_storage_key" IS NULL');
		expect(sql.match(/right\("storage_key"/g)).toHaveLength(2);
		expect(sql.match(/right\("poster_storage_key"/g)).toHaveLength(2);
		expect(sql.match(/\/__pcu_image_rendition__\/v1\/card-480[.]webp/g)).toHaveLength(6);
		expect(sql.match(/\/__pcu_image_rendition__\/v1\/display-960[.]webp/g)).toHaveLength(6);
		expect(sql).not.toContain('NOT VALID');
	});
});
