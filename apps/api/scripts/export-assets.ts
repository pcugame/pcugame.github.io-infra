/**
 * CLI wrapper for the export service.
 *
 * Usage:
 *   npx tsx scripts/export-assets.ts <output-dir> [--year 2024] [--dry-run]
 *
 * Requires: DATABASE_URL, S3_* env vars (via .env)
 */

import { loadEnv } from '../src/config/env.js';
import { exportAssets } from '../src/modules/admin/export/service.js';

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
	loadEnv();

	console.log(`Exporting assets to ${opts.outDir}${opts.year ? ` (year=${opts.year})` : ''}${opts.dryRun ? ' [dry-run]' : ''}`);

	const result = await exportAssets({
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
		for (const p of result.paths) console.log(`  ${p}`);
	}
	if (result.failed > 0) {
		console.log('\nWARNING: Some files failed. Re-run to retry (existing files are skipped).');
	}
}

main().catch((err) => {
	console.error('Export failed:', err);
	process.exit(1);
});
