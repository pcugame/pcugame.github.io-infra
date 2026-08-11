/**
 * CLI wrapper for the export service.
 *
 * Usage:
 *   npx tsx scripts/export-assets.ts <output-dir> [--year 2024] [--dry-run]
 *
 * Requires: DATABASE_URL, S3_* env vars (via .env)
 */

import { loadEnv } from '../src/config/env.js';
import { createNodeFileSystem, createCryptoIdGenerator } from '../src/infrastructure/production-ports.js';
import { createRootLogger } from '../src/lib/logger.js';
import { createExportFileWriter } from '../src/modules/admin/export/file.adapter.js';
import { createExportRepository } from '../src/modules/admin/export/repository.js';
import {
	createExportProgressStore,
	createExportService,
} from '../src/modules/admin/export/service.js';
import { bucketForKind, createScriptResources } from './resources.js';

function parseArgs() {
	const args = process.argv.slice(2);
	let outDir = '';
	let year: number | undefined;
	let dryRun = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === '--year' && args[i + 1]) {
			year = parseInt(args[i + 1]!, 10);
			i++;
		} else if (arg === '--dry-run') {
			dryRun = true;
		} else if (!arg.startsWith('--')) {
			outDir = arg;
		}
	}

	if (!outDir) {
		console.error('Usage: npx tsx scripts/export-assets.ts <output-dir> [--year 2024] [--dry-run]');
		process.exit(1);
	}

	return { outDir, year, dryRun };
}

async function main() {
	const opts = parseArgs();
	const config = loadEnv();
	const resources = createScriptResources(config);
	const fileSystem = createNodeFileSystem();
	const logger = createRootLogger(config);
	const progress = createExportProgressStore();
	const repository = createExportRepository(resources.prisma);
	const writer = createExportFileWriter({
		ids: createCryptoIdGenerator(),
		async getObject(bucket, key, signal) {
			const object = await resources.storage.stream(bucket, key, undefined, signal);
			if (!object) throw new Error(`Export object not found: ${key}`);
			return object.body;
		},
		createWriteStream: fileSystem.createWriteStream,
		rename: fileSystem.rename,
		remove: fileSystem.remove,
		logCleanupError: (error, path) => logger.warn(
			{ error, path },
			'Failed to remove partial export file',
		),
	});
	const exportService = createExportService({
		findProjects: repository.findProjectsWithAssets,
		async pathExists(path) {
			try {
				await fileSystem.access(path);
				return true;
			} catch {
				return false;
			}
		},
		ensureDirectory: (path) => fileSystem.mkdir(path, { recursive: true }),
		saveObject: writer.saveObject,
		bucketForKind: (kind) => bucketForKind(config, kind),
		protectedBucket: config.S3_BUCKET_PROTECTED,
		now: Date.now,
		logWarn: (message) => logger.warn(message),
		logError: (context, message) => logger.error(context, message),
	}, progress);

	console.log(`Exporting assets to ${opts.outDir}${opts.year ? ` (year=${opts.year})` : ''}${opts.dryRun ? ' [dry-run]' : ''}`);

	try {
		const result = await exportService.exportAssets({
			outDir: opts.outDir,
			year: opts.year,
			dryRun: opts.dryRun,
		});

		console.log('');
		console.log('=== Export Summary ===');
		console.log(`  Projects:    ${result.projects}`);
		console.log(`  Total files: ${result.totalFiles}`);
		if (!opts.dryRun) {
			console.log(`  Downloaded:  ${result.downloaded}`);
			console.log(`  Skipped:     ${result.skipped} (already exist)`);
			console.log(`  Failed:      ${result.failed}`);
		} else {
			for (const path of result.paths) console.log(`  ${path}`);
		}
		if (result.failed > 0) {
			console.log('\nWARNING: Some files failed. Re-run to retry (existing files are skipped).');
		}
	} finally {
		await exportService.close();
		progress.close();
		await resources.close();
	}
}

main().catch((err) => {
	console.error('Export failed:', err);
	process.exit(1);
});
