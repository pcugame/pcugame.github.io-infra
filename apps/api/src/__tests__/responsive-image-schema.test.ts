import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
	'../../prisma/migrations/20260812000000_responsive_image_foundation/migration.sql',
	import.meta.url,
);

describe('responsive image additive schema', () => {
	it('keeps canonical dimensions nullable and enforces rendition identity constraints', async () => {
		const sql = await readFile(migrationUrl, 'utf8');

		expect(sql).toContain('ADD COLUMN "width" INTEGER');
		expect(sql).toContain('ADD COLUMN "height" INTEGER');
		expect(sql).toContain('ADD COLUMN "poster_width" INTEGER');
		expect(sql).toContain('ADD COLUMN "poster_height" INTEGER');
		expect(sql).not.toMatch(/ADD COLUMN "(?:poster_)?(?:width|height)" INTEGER NOT NULL/);
		expect(sql).toContain("CREATE TYPE \"ImageRenditionProfile\" AS ENUM ('CARD_480', 'DISPLAY_960')");
		expect(sql).toContain('CONSTRAINT "image_renditions_owner_xor_check" CHECK');
		expect(sql).toContain('("asset_id" IS NOT NULL AND "exhibition_id" IS NULL)');
		expect(sql).toContain('("asset_id" IS NULL AND "exhibition_id" IS NOT NULL)');
		expect(sql).toContain('CREATE UNIQUE INDEX "image_renditions_storage_key_key"');
		expect(sql).toContain('CREATE UNIQUE INDEX "image_renditions_asset_id_profile_key"');
		expect(sql).toContain('CREATE UNIQUE INDEX "image_renditions_exhibition_id_profile_key"');
		expect(sql).toContain('"source_storage_key" TEXT NOT NULL');
	});
});
