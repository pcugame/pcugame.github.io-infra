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

import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { loadEnv } from '../src/config/env.js';
import { prisma, disconnectPrisma } from '../src/lib/prisma.js';
import { s3 } from '../src/lib/s3.js';
import { upsertOrphan } from '../src/modules/orphan/repository.js';

async function listAllKeys(bucket: string): Promise<string[]> {
	const keys: string[] = [];
	let continuationToken: string | undefined;
	do {
		const res = await s3().send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }));
		for (const obj of res.Contents ?? []) {
			if (obj.Key) keys.push(obj.Key);
		}
		continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
	} while (continuationToken);
	return keys;
}

async function collectReferencedKeys(): Promise<Set<string>> {
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

	const referenced = await collectReferencedKeys();
	console.log(`DB references ${referenced.size} distinct storage keys`);

	for (const bucket of [cfg.S3_BUCKET_PUBLIC, cfg.S3_BUCKET_PROTECTED]) {
		const allKeys = await listAllKeys(bucket);
		const orphans = allKeys.filter((k) => !referenced.has(k));
		console.log(`[${bucket}] total=${allKeys.length} orphan=${orphans.length}`);

		if (dryRun) {
			for (const key of orphans.slice(0, 20)) console.log(`  would enqueue: ${key}`);
			if (orphans.length > 20) console.log(`  …and ${orphans.length - 20} more`);
			continue;
		}

		for (const key of orphans) {
			await upsertOrphan(bucket, key, 'reconcile');
		}
		console.log(`[${bucket}] enqueued ${orphans.length} orphans`);
	}
}

main()
	.catch((err) => {
		console.error('reconcile-orphans failed:', err);
		process.exitCode = 1;
	})
	.finally(() => disconnectPrisma());
