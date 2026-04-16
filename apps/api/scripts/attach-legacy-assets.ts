/**
 * Attach NAS assets to existing legacy projects in the database.
 *
 * Unlike bulk-import.ts (which creates new projects), this script finds
 * legacy projects that already exist but have no assets, discovers matching
 * files on the NAS, uploads them to S3, and creates Asset records.
 *
 * Usage (run from apps/api):
 *   npx tsx scripts/attach-legacy-assets.ts <nas-asset-root> [--year 2024] [--dry-run]
 *
 * Example (local):
 *   npx tsx scripts/attach-legacy-assets.ts /mnt/nas/Asset --year 2024
 *
 * Example (container):
 *   npx tsx scripts/attach-legacy-assets.ts /nas/Asset --dry-run
 *
 * NAS asset directory structure expected:
 *   <root>/{year}/poster/{ids}_poster.{webp|png|jpg|jpeg}
 *   <root>/{year}/game/{ids}_game.zip
 *   <root>/{year}/video/{ids}_video.{mp4|mov}
 *
 * Where {ids} = studentIds joined by "_" (e.g., "1988002_1988042")
 *
 * Requires: DATABASE_URL, S3_* env vars (via .env or environment)
 */

import { PrismaClient } from '@prisma/client';
import { readdirSync, statSync, createReadStream } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../src/config/env.js';
import { uploadFile } from '../src/lib/storage.js';
import { bucketForKind } from '../src/lib/s3.js';
import type { AssetKind } from '@prisma/client';

// ── Types ────────────────────────────────────────────────

interface MatchedAsset {
	kind: AssetKind;
	filePath: string;
	originalName: string;
	mimeType: string;
	sizeBytes: number;
}

interface AttachStats {
	projects: number;
	assets: number;
	noFiles: number;
	failed: { project: string; reason: string }[];
}

// ── Config ───────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
	'.webp': 'image/webp',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.pdf': 'application/pdf',
	'.zip': 'application/zip',
	'.mp4': 'video/mp4',
	'.mov': 'video/quicktime',
};

const POSTER_EXTS = ['.webp', '.png', '.jpg', '.jpeg'];
const VIDEO_EXTS = ['.mp4', '.mov'];

// ── CLI ──────────────────────────────────────────────────

function parseArgs() {
	const args = process.argv.slice(2);
	const positional: string[] = [];
	let yearFilter: number | undefined;
	let dryRun = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === '--year' && args[i + 1]) {
			yearFilter = parseInt(args[i + 1]!, 10);
			i++;
		} else if (arg === '--dry-run') {
			dryRun = true;
		} else if (!arg.startsWith('--')) {
			positional.push(arg);
		}
	}

	const assetRoot = positional[0] ?? '';

	if (!assetRoot) {
		console.error('Usage: npx tsx scripts/attach-legacy-assets.ts <nas-asset-root> [--year 2024] [--dry-run]');
		console.error('');
		console.error('  nas-asset-root: directory containing {year}/poster/, {year}/game/, {year}/video/');
		process.exit(1);
	}

	return { assetRoot, yearFilter, dryRun };
}

// ── Asset discovery (adapted from bulk-import.ts) ────────

function buildFileKey(studentIds: string[]): string {
	return studentIds.join('_');
}

function findAssetFile(
	dir: string,
	fileKey: string,
	prefix: string,
	extensions: string[],
): string | null {
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return null;
	}

	for (const ext of extensions) {
		const target = `${fileKey}_${prefix}${ext}`;
		const found = files.find((f) => f.toLowerCase() === target.toLowerCase());
		if (found) return join(dir, found);
	}

	return null;
}

function discoverAssets(
	assetRoot: string,
	year: number,
	studentIds: string[],
): MatchedAsset[] {
	const fileKey = buildFileKey(studentIds);
	const yearDir = join(assetRoot, String(year));
	const assets: MatchedAsset[] = [];

	// Poster
	const posterPath = findAssetFile(join(yearDir, 'poster'), fileKey, 'poster', POSTER_EXTS);
	if (posterPath) {
		const ext = extname(posterPath).toLowerCase();
		assets.push({
			kind: 'POSTER',
			filePath: posterPath,
			originalName: `${fileKey}_poster${ext}`,
			mimeType: MIME_MAP[ext] ?? 'application/octet-stream',
			sizeBytes: statSync(posterPath).size,
		});
	}

	// Game
	const gamePath = findAssetFile(join(yearDir, 'game'), fileKey, 'game', ['.zip']);
	if (gamePath) {
		assets.push({
			kind: 'GAME',
			filePath: gamePath,
			originalName: `${fileKey}_game.zip`,
			mimeType: 'application/zip',
			sizeBytes: statSync(gamePath).size,
		});
	}

	// Video
	const videoPath = findAssetFile(join(yearDir, 'video'), fileKey, 'video', VIDEO_EXTS);
	if (videoPath) {
		const ext = extname(videoPath).toLowerCase();
		assets.push({
			kind: 'VIDEO',
			filePath: videoPath,
			originalName: `${fileKey}_video${ext}`,
			mimeType: MIME_MAP[ext] ?? 'video/mp4',
			sizeBytes: statSync(videoPath).size,
		});
	}

	return assets;
}

// ── S3 upload ────────────────────────────────────────────

async function uploadAssetToS3(asset: MatchedAsset): Promise<string> {
	const ext = extname(asset.filePath).toLowerCase();
	const storageKey = `${randomUUID()}${ext}`;
	const bucket = bucketForKind(asset.kind);

	const stream = createReadStream(asset.filePath);
	await uploadFile(bucket, storageKey, stream, asset.mimeType, asset.sizeBytes);

	return storageKey;
}

// ── Main ─────────────────────────────────────────────────

async function main() {
	const opts = parseArgs();
	loadEnv();

	const prisma = new PrismaClient();

	try {
		await doAttach(prisma, opts);
	} finally {
		await prisma.$disconnect();
	}
}

async function doAttach(
	prisma: PrismaClient,
	opts: { assetRoot: string; yearFilter?: number; dryRun: boolean },
) {
	// Find legacy projects with no assets
	const projects = await prisma.project.findMany({
		where: {
			isIncomplete: true,
			status: 'PUBLISHED',
			assets: { none: {} },
			...(opts.yearFilter ? { exhibition: { year: opts.yearFilter } } : {}),
		},
		include: {
			exhibition: { select: { year: true, title: true } },
			members: { orderBy: { sortOrder: 'asc' }, select: { studentId: true } },
		},
		orderBy: [
			{ exhibition: { year: 'asc' } },
			{ title: 'asc' },
		],
	});

	if (projects.length === 0) {
		console.log('No legacy projects without assets found.');
		return;
	}

	console.log(`Found ${projects.length} legacy projects without assets.\n`);

	const stats: AttachStats = { projects: 0, assets: 0, noFiles: 0, failed: [] };
	let currentYear = 0;

	for (const project of projects) {
		const year = project.exhibition.year;

		// Print year header
		if (year !== currentYear) {
			currentYear = year;
			const yearProjects = projects.filter((p) => p.exhibition.year === year);
			console.log(`\n═══ ${year}년도 ═══`);
			console.log(`전시회: ${project.exhibition.title} (${yearProjects.length} projects without assets)`);
		}

		// Build studentId list (filter out empty)
		const studentIds = project.members
			.map((m) => m.studentId)
			.filter((id) => id.length > 0);

		const label = `${project.title} (${studentIds.join(', ')})`;

		if (studentIds.length === 0) {
			console.log(`  SKIP: ${label} — no studentIds on members`);
			stats.noFiles++;
			continue;
		}

		// Discover assets on NAS
		const assets = discoverAssets(opts.assetRoot, year, studentIds);

		if (assets.length === 0) {
			console.log(`  SKIP: ${label} — no NAS files found`);
			stats.noFiles++;
			continue;
		}

		if (opts.dryRun) {
			console.log(`  DRY: ${label}`);
			for (const a of assets) {
				const sizeMB = (a.sizeBytes / 1024 / 1024).toFixed(1);
				console.log(`        ${a.kind}: ${a.filePath} (${sizeMB} MB)`);
			}
			stats.projects++;
			stats.assets += assets.length;
			continue;
		}

		try {
			// Upload assets to S3
			const assetRecords: {
				kind: AssetKind;
				storageKey: string;
				originalName: string;
				mimeType: string;
				sizeBytes: bigint;
				isPublic: boolean;
			}[] = [];

			for (const asset of assets) {
				const storageKey = await uploadAssetToS3(asset);
				assetRecords.push({
					kind: asset.kind,
					storageKey,
					originalName: asset.originalName,
					mimeType: asset.mimeType,
					sizeBytes: BigInt(asset.sizeBytes),
					isPublic: asset.kind !== 'GAME' && asset.kind !== 'VIDEO',
				});
			}

			// Create asset records + set poster in a transaction
			await prisma.$transaction(async (tx) => {
				for (const rec of assetRecords) {
					const created = await tx.asset.create({
						data: {
							projectId: project.id,
							kind: rec.kind,
							status: 'READY',
							storageKey: rec.storageKey,
							originalName: rec.originalName,
							mimeType: rec.mimeType,
							sizeBytes: rec.sizeBytes,
							isPublic: rec.isPublic,
						},
					});

					// Set poster reference on project
					if (rec.kind === 'POSTER') {
						await tx.project.update({
							where: { id: project.id },
							data: { posterAssetId: created.id },
						});
					}
				}
			});

			const assetSummary = assetRecords.map((a) => a.kind[0]).join('') || '-';
			console.log(`  OK: ${label} [${assetSummary}]`);
			stats.projects++;
			stats.assets += assetRecords.length;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`  FAIL: ${label} — ${msg}`);
			stats.failed.push({ project: label, reason: msg });
		}
	}

	// Summary
	console.log('\n═══ Summary ═══');
	console.log(`  Projects processed: ${stats.projects}`);
	console.log(`  Assets uploaded:    ${stats.assets}`);
	console.log(`  No files found:     ${stats.noFiles}`);
	console.log(`  Failed:             ${stats.failed.length}`);
	if (stats.failed.length > 0) {
		console.log('\nFailed projects:');
		for (const f of stats.failed) {
			console.log(`  - ${f.project}: ${f.reason}`);
		}
	}
}

main().catch((err) => {
	console.error('Attach failed:', err);
	process.exit(1);
});
