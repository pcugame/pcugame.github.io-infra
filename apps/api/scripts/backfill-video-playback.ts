/**
 * Backfill playback MP4 metadata/files for existing VIDEO assets.
 *
 * Usage (run from apps/api):
 *   npx tsx scripts/backfill-video-playback.ts [--dry-run] [--limit 20]
 *
 * The original S3 object is preserved. When a separate playback file is needed,
 * only playback_* fields on the Asset row are updated.
 */

import { createReadStream, createWriteStream, mkdtempSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { loadEnv } from '../src/config/env.js';
import { generateStorageKey } from '../src/shared/storage-path.js';
import { storageOptionsForAsset } from '../src/modules/assets/upload/storage-policy.js';
import {
	createScriptResources,
	createScriptUploadProcessing,
} from './resources.js';

function parseArgs() {
	const args = process.argv.slice(2);
	let dryRun = false;
	let limit: number | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === '--dry-run') dryRun = true;
		else if (arg === '--limit' && args[i + 1]) {
			limit = parseInt(args[i + 1]!, 10);
			i++;
		}
	}

	return { dryRun, limit };
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function main() {
	const opts = parseArgs();
	const config = loadEnv();
	const resources = createScriptResources(config);
	const processing = createScriptUploadProcessing(config);
	const prisma = resources.prisma;
	const tmpDir = mkdtempSync(join(tmpdir(), 'video-playback-backfill-'));

	try {
		const assets = await prisma.asset.findMany({
			where: {
				kind: 'VIDEO',
				status: 'READY',
				playbackStorageKey: null,
				playbackStatus: { in: ['PENDING', 'FAILED'] },
			},
			orderBy: { id: 'asc' },
			...(opts.limit ? { take: opts.limit } : {}),
		});

		console.log(`Found ${assets.length} VIDEO assets to inspect.`);

		for (const asset of assets) {
			const ext = extname(asset.storageKey).replace('.', '') || 'mp4';
			const localPath = join(tmpDir, `${asset.id}.${ext}`);

			try {
				const object = await resources.storage.stream(
					config.S3_BUCKET_PROTECTED,
					asset.storageKey,
				);
				if (!object) throw new Error(`Object not found: ${asset.storageKey}`);
				await pipeline(object.body, createWriteStream(localPath));
				const result = await processing.video({
					tmpPath: localPath,
					mimeType: asset.mimeType || 'video/mp4',
					ext,
					sizeBytes: Number(asset.sizeBytes),
				});

				const label = result.playback
					? `needs playback (${result.strategy})`
					: result.playbackStatus === 'READY'
						? 'already playable'
						: `failed: ${result.playbackError}`;
				console.log(`  #${asset.id} ${asset.storageKey}: ${label}`);

				if (opts.dryRun) continue;

				if (result.playback) {
					const playbackStorageKey = generateStorageKey('mp4');
					await resources.storage.upload(
						config.S3_BUCKET_PROTECTED,
						playbackStorageKey,
						createReadStream(result.playback.tmpPath),
						result.playback.mimeType,
						result.playback.sizeBytes,
						storageOptionsForAsset('VIDEO', 'playback'),
					);
					await prisma.asset.update({
						where: { id: asset.id },
						data: {
							playbackStorageKey,
							playbackMimeType: result.playback.mimeType,
							playbackSizeBytes: BigInt(result.playback.sizeBytes),
							playbackStatus: 'READY',
							playbackError: '',
						},
					});
				} else {
					await prisma.asset.update({
						where: { id: asset.id },
						data: {
							playbackMimeType: '',
							playbackSizeBytes: BigInt(0),
							playbackStatus: result.playbackStatus,
							playbackError: result.playbackError,
						},
					});
				}

				if (result.playback) {
					await fsp.unlink(result.playback.tmpPath).catch(() => {});
				}
			} catch (err) {
				const message = errorMessage(err).slice(0, 2000);
				console.error(`  #${asset.id} ${asset.storageKey}: ${message}`);
				if (!opts.dryRun) {
					await prisma.asset.update({
						where: { id: asset.id },
						data: { playbackStatus: 'FAILED', playbackError: message },
					});
				}
			} finally {
				await fsp.unlink(localPath).catch(() => {});
			}
		}
	} finally {
		await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		await resources.close();
	}
}

main().catch((err) => {
	console.error('Backfill failed:', err);
	process.exit(1);
});
