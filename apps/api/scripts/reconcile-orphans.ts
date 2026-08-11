/**
 * Conservative one-shot object reconciliation.
 *
 * Dry-run is the default. Mutating the durable deletion queue requires
 * `--apply`; only objects with a known LastModified older than the run's age
 * fence are considered.
 *
 * Usage:
 *   npx tsx scripts/reconcile-orphans.ts [--apply] [--older-than-minutes=60]
 */

import { pathToFileURL } from 'node:url';
import { loadEnv } from '../src/config/env.js';
import {
	parseReconcileOptions,
	reconcileObjects,
} from '../src/modules/orphan/reconcile.js';
import { createScriptResources } from './resources.js';

export { parseReconcileOptions, reconcileObjects };

async function main() {
	const cfg = loadEnv();
	const options = parseReconcileOptions(process.argv.slice(2));
	const resources = createScriptResources(cfg);
	try {
		const result = await reconcileObjects({
			prisma: resources.prisma,
			storage: resources.storage,
			publicBucket: cfg.S3_BUCKET_PUBLIC,
			protectedBucket: cfg.S3_BUCKET_PROTECTED,
			options,
		});
		console.log(
			`reconcile complete: scanned=${result.scanned} eligible=${result.eligible}`
			+ ` enqueued=${result.enqueued} skippedUnknownAge=${result.skippedUnknownAge}`,
		);
	} finally {
		await resources.close();
	}
}

const executedPath = process.argv[1];
if (executedPath && import.meta.url === pathToFileURL(executedPath).href) {
	void main().catch((error) => {
		console.error('reconcile-orphans failed:', error);
		process.exitCode = 1;
	});
}
