/**
 * Resumable responsive-image backfill. Dry-run is the default; use --apply to
 * upload derivatives and commit metadata/rendition rows.
 *
 * Usage:
 *   npm run backfill:image-renditions -- --limit=50
 *   npm run backfill:image-renditions -- --apply --owner=all --concurrency=2
 *     --after-asset-id=100 --after-exhibition-id=20
 */

import { pathToFileURL } from 'node:url';
import { loadEnv } from '../src/config/env.js';
import {
	backfillImageRenditions,
	parseImageRenditionBackfillOptions,
} from '../src/modules/assets/image-rendition-backfill.js';
import { createScriptResources } from './resources.js';

export { backfillImageRenditions, parseImageRenditionBackfillOptions };

async function main(): Promise<void> {
	const config = loadEnv();
	const options = parseImageRenditionBackfillOptions(process.argv.slice(2));
	const resources = createScriptResources(config);
	try {
		const result = await backfillImageRenditions({
			prisma: resources.prisma,
			storage: resources.storage,
			fileSystem: resources.fileSystem,
			ids: resources.ids,
			logger: resources.logger,
			publicBucket: config.S3_BUCKET_PUBLIC,
			uploadIntents: resources.uploadLifecycle.uploadIntents,
			orphanDeletions: resources.uploadLifecycle.orphanDeletions,
		}, options);
		console.log(JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', ...result }, null, 2));
		if (result.failed > 0) process.exitCode = 1;
	} finally {
		await resources.close();
	}
}

const executedPath = process.argv[1];
if (executedPath && import.meta.url === pathToFileURL(executedPath).href) {
	void main().catch((error) => {
		console.error('backfill-image-renditions failed:', error);
		process.exitCode = 1;
	});
}
