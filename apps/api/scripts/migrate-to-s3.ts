/**
 * Migration script: copy local files to S3 (Garage).
 *
 * IMPORTANT: This script NEVER deletes local files.
 * Both local originals and S3 objects coexist after migration.
 * Local cleanup must be done manually after verifying S3 data integrity.
 *
 * Usage:
 *   npx tsx scripts/migrate-to-s3.ts
 *
 * Requires:
 *   - DATABASE_URL, S3_* env vars set (via .env)
 *   - UPLOAD_ROOT_PUBLIC and UPLOAD_ROOT_PROTECTED set to local paths
 */

import { createReadStream, promises as fsp } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { loadEnv } from '../src/config/env.js';
import { buildStoragePath } from '../src/shared/storage-path.js';
import { uploadFile, headObject } from '../src/lib/storage.js';
import { bucketForKind } from '../src/lib/s3.js';

const prisma = new PrismaClient();

async function main() {
	const cfg = loadEnv();

	if (!cfg.UPLOAD_ROOT_PUBLIC || !cfg.UPLOAD_ROOT_PROTECTED) {
		console.error('ERROR: UPLOAD_ROOT_PUBLIC and UPLOAD_ROOT_PROTECTED must be set for migration.');
		process.exit(1);
	}

	const assets = await prisma.asset.findMany({
		where: { status: 'READY' },
		select: { id: true, storageKey: true, kind: true, mimeType: true },
	});

	console.log(`Found ${assets.length} assets to migrate.`);

	let uploaded = 0;
	let skipped = 0;
	let failed = 0;
	let notFound = 0;

	for (const asset of assets) {
		const bucket = bucketForKind(asset.kind);
		const root = asset.kind === 'GAME' ? cfg.UPLOAD_ROOT_PROTECTED : cfg.UPLOAD_ROOT_PUBLIC;
		const localPath = buildStoragePath(root, asset.storageKey);

		// Check local file exists
		try {
			await fsp.access(localPath);
		} catch {
			console.warn(`  WARN: Local file not found for asset ${asset.id} (${asset.storageKey}), skipping.`);
			notFound++;
			continue;
		}

		// Check if already in S3
		const existing = await headObject(bucket, asset.storageKey);
		if (existing) {
			skipped++;
			continue;
		}

		// Upload to S3
		try {
			const stat = await fsp.stat(localPath);
			const stream = createReadStream(localPath);
			await uploadFile(bucket, asset.storageKey, stream, asset.mimeType, stat.size);
			uploaded++;

			if ((uploaded + skipped) % 50 === 0) {
				console.log(`  Progress: ${uploaded} uploaded, ${skipped} skipped, ${failed} failed (${uploaded + skipped + failed + notFound}/${assets.length})`);
			}
		} catch (err) {
			console.error(`  ERROR: Failed to upload asset ${asset.id} (${asset.storageKey}):`, err);
			failed++;
		}
	}

	console.log('');
	console.log('=== Migration Summary ===');
	console.log(`  Total assets:    ${assets.length}`);
	console.log(`  Uploaded:        ${uploaded}`);
	console.log(`  Already in S3:   ${skipped}`);
	console.log(`  Local not found: ${notFound}`);
	console.log(`  Failed:          ${failed}`);
	console.log('');
	if (failed > 0) {
		console.log('WARNING: Some files failed to upload. Re-run this script to retry.');
	} else {
		console.log('All files migrated successfully.');
	}
	console.log('NOTE: Local files have NOT been deleted. Verify S3 data integrity before manual cleanup.');
}

main()
	.catch((err) => {
		console.error('Migration script failed:', err);
		process.exit(1);
	})
	.finally(() => prisma.$disconnect());
