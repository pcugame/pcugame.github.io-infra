/**
 * Resumable Phase 1 canonical asset backfill. Dry-run is the default.
 *
 * Usage:
 *   npm run backfill:canonical-assets -- --batch-size=100
 *   npm run backfill:canonical-assets -- --apply --batch-size=100
 *     --progress-file=/var/lib/pcugame/canonical-assets.apply.progress.json
 *     --failures-file=/var/lib/pcugame/canonical-assets.apply.failures.json
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv } from '../src/config/env.js';
import { createPrismaClientForDatabase } from '../src/lib/prisma-client.js';
import { createS3Client } from '../src/lib/s3.js';
import { createObjectStorage } from '../src/lib/storage.js';
import {
	createCanonicalBackfillProgress,
	parseCanonicalBackfillOptions,
	parseCanonicalBackfillProgress,
	runCanonicalBackfill,
} from '../src/modules/migration/canonical-backfill.js';
import { createCanonicalBackfillRepository } from '../src/modules/migration/canonical-backfill.prisma.js';
import type {
	CanonicalBackfillMode,
	CanonicalBackfillProgress,
} from '../src/modules/migration/canonical-backfill.types.js';

interface CliPaths {
	progressFile: string;
	failuresFile: string;
	resetProgress: boolean;
}

function valueOption(args: readonly string[], name: string): string | undefined {
	const prefix = `--${name}=`;
	return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function cliPaths(args: readonly string[], mode: CanonicalBackfillMode): CliPaths {
	const stem = `canonical-assets.${mode}`;
	return {
		progressFile: resolve(valueOption(args, 'progress-file') || `${stem}.progress.json`),
		failuresFile: resolve(valueOption(args, 'failures-file') || `${stem}.failures.json`),
		resetProgress: args.includes('--reset-progress'),
	};
}

async function readProgress(
	path: string,
	mode: CanonicalBackfillMode,
	reset: boolean,
): Promise<CanonicalBackfillProgress> {
	if (reset) return createCanonicalBackfillProgress(mode);
	try {
		return parseCanonicalBackfillProgress(JSON.parse(await readFile(path, 'utf8')), mode);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createCanonicalBackfillProgress(mode);
		throw error;
	}
}

async function atomicJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
	await rename(temporary, path);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes('--help')) {
		console.log('backfill-canonical-assets [--apply|--dry-run] [--batch-size=N] [--progress-file=PATH] [--failures-file=PATH] [--reset-progress]');
		return;
	}
	const options = parseCanonicalBackfillOptions(args);
	const mode: CanonicalBackfillMode = options.apply ? 'apply' : 'dry-run';
	const paths = cliPaths(args, mode);
	const config = loadEnv();
	const prisma = createPrismaClientForDatabase(config.DATABASE_URL);
	const s3 = createS3Client(config);
	const storage = createObjectStorage(s3, { defaultPresignTtlSec: config.S3_PRESIGN_TTL_SEC });
	try {
		const progress = await readProgress(paths.progressFile, mode, paths.resetProgress);
		const result = await runCanonicalBackfill({
			repository: createCanonicalBackfillRepository(prisma),
			verifier: {
				async head(bucket, key) {
					const metadata = await storage.head(bucket, key);
					if (!metadata) return null;
					if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) {
						throw new Error('Object HEAD returned an unsafe Content-Length');
					}
					return {
						size: BigInt(metadata.size),
						mimeType: metadata.contentType,
						...(metadata.etag ? { etag: metadata.etag } : {}),
					};
				},
				async listPrefix(bucket, prefix, afterKey, limit) {
					const page = await storage.listKeyPage(bucket, prefix, {
						...(afterKey ? { startAfter: afterKey } : {}),
						maxKeys: limit,
					});
					return { keys: page.keys, isTruncated: page.isTruncated };
				},
			},
			protectedBucket: config.S3_BUCKET_PROTECTED,
			publicBucket: config.S3_BUCKET_PUBLIC,
			progress,
			options,
			onProgress: (next) => atomicJson(paths.progressFile, next),
			onLog: (record) => console.log(JSON.stringify(record)),
		});
		await atomicJson(paths.failuresFile, {
			version: 1,
			mode,
			generatedAt: new Date().toISOString(),
			failures: result.failures,
		});
		console.log(JSON.stringify({
			event: 'canonical_backfill_complete',
			...result,
			progressFile: paths.progressFile,
			failuresFile: paths.failuresFile,
		}, null, 2));
		if (result.failures.length > 0) process.exitCode = 2;
	} finally {
		s3.destroy();
		await prisma.$disconnect();
	}
}

const executedPath = process.argv[1];
if (executedPath && import.meta.url === pathToFileURL(executedPath).href) {
	void main().catch((error) => {
		console.error('backfill-canonical-assets failed:', error);
		process.exitCode = 1;
	});
}
