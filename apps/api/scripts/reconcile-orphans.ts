/**
 * One-shot reconcile: list every object in both S3 buckets, subtract the set of
 * storage keys referenced by DB rows, and enqueue the remainder into OrphanObject
 * so the reaper (or a manual sweep) cleans them up.
 *
 * Usage:
 *   npx tsx scripts/reconcile-orphans.ts [--dry-run]
 *
 * Requires: DATABASE_URL, S3_* env vars (via .env).
 * Safe to re-run — upsertOrphan is idempotent per (bucket, storage_key).
 */

import { loadEnv } from '../src/config/env.js';
import type { ObjectStorage } from '../src/application/ports.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { createOrphanRepository } from '../src/modules/orphan/repository.js';
import { createScriptResources } from './resources.js';

async function listAllKeys(storage: ObjectStorage, bucket: string): Promise<string[]> {
	return storage.listKeys(bucket, '');
}

async function collectReferencedKeys(prisma: PrismaClient): Promise<Set<string>> {
	const referenced = new Set<string>();

	const assetRows = await prisma.asset.findMany({ select: { storageKey: true } });
	for (const row of assetRows) referenced.add(row.storageKey);

	const sessionRows = await prisma.gameUploadSession.findMany({
		where: { storageKey: { not: null } },
		select: { storageKey: true },
	});
	for (const row of sessionRows) {
		if (row.storageKey) referenced.add(row.storageKey);
	}

	return referenced;
}

async function main() {
	const cfg = loadEnv();
	const dryRun = process.argv.includes('--dry-run');
	const resources = createScriptResources(cfg);
	const orphanRepository = createOrphanRepository(resources.prisma);

	try {
		const referenced = await collectReferencedKeys(resources.prisma);
		console.log(`DB references ${referenced.size} distinct storage keys`);

		for (const bucket of [cfg.S3_BUCKET_PUBLIC, cfg.S3_BUCKET_PROTECTED]) {
			const allKeys = await listAllKeys(resources.storage, bucket);
			const orphans = allKeys.filter((key) => !referenced.has(key));
			console.log(`[${bucket}] total=${allKeys.length} orphan=${orphans.length}`);

			if (dryRun) {
				for (const key of orphans.slice(0, 20)) console.log(`  would enqueue: ${key}`);
				if (orphans.length > 20) console.log(`  …and ${orphans.length - 20} more`);
				continue;
			}

			for (const key of orphans) {
				await orphanRepository.upsertOrphan(bucket, key, 'reconcile');
			}
			console.log(`[${bucket}] enqueued ${orphans.length} orphans`);
		}
	} finally {
		await resources.close();
	}
}

main()
	.catch((err) => {
		console.error('reconcile-orphans failed:', err);
		process.exitCode = 1;
	});
