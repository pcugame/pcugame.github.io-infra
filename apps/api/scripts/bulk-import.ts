/**
 * Bulk import legacy projects WITH assets from NAS.
 *
 * Usage (run from apps/api):
 *   npx tsx scripts/bulk-import.ts <nas-asset-root> <legacy-json-dir> [--year 2024] [--dry-run]
 *
 * Example (local):
 *   npx tsx scripts/bulk-import.ts /mnt/nas/Asset ../../server --year 2024
 *
 * Example (container):
 *   npx tsx scripts/bulk-import.ts /nas/Asset /nas/legacy --dry-run
 *
 * NAS asset directory structure expected:
 *   <root>/{year}/poster/{ids}_poster.{webp|png|jpg|pdf}
 *   <root>/{year}/game/{ids}_game.zip
 *   <root>/{year}/video/{ids}_video.{mp4|mov}
 *
 * Where {ids} = studentIds joined by "_" (e.g., "1988002_1988042")
 *
 * Requires: DATABASE_URL, S3_* env vars (via .env or environment)
 */

import { PrismaClient } from '@prisma/client';
import { readFileSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../src/config/env.js';
import { uploadFile } from '../src/lib/storage.js';
import { bucketForKind } from '../src/lib/s3.js';
import { toSlug } from '../src/shared/slug.js';
import type { AssetKind } from '@prisma/client';

// ── Types ────────────────────────────────────────────────

interface LegacyEntry {
	title: string;
	studentIds: string[];
	names: string[];
	originalPosterFormat?: string;
	isMobile?: boolean;
	githubLink?: string;
	poster?: string;
	videoId?: string;
	downloadId?: string;
}

interface MatchedAsset {
	kind: AssetKind;
	filePath: string;
	originalName: string;
	mimeType: string;
	sizeBytes: number;
}

interface ImportStats {
	projects: number;
	assets: number;
	skipped: number;
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
	'.apk': 'application/vnd.android.package-archive',
	'.7z': 'application/x-7z-compressed',
	'.exe': 'application/x-msdownload',
	'.mp4': 'video/mp4',
	'.mov': 'video/quicktime',
	'.mkv': 'video/x-matroska',
	'.avi': 'video/x-msvideo',
	'.wmv': 'video/x-ms-wmv',
};

// Poster preference: webp first, then original formats
const POSTER_EXTS = ['.webp', '.png', '.jpg', '.jpeg', '.pdf'];
const GAME_EXTS = ['.zip', '.apk', '.7z', '.exe'];
const VIDEO_EXTS = ['.mp4', '.mov', '.mkv', '.avi', '.wmv'];

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
	const legacyDir = positional[1] ?? '';

	if (!assetRoot || !legacyDir) {
		console.error('Usage: npx tsx scripts/bulk-import.ts <nas-asset-root> <legacy-json-dir> [--year 2024] [--dry-run]');
		console.error('');
		console.error('  nas-asset-root:  directory containing {year}/poster/, {year}/game/, {year}/video/');
		console.error('  legacy-json-dir: directory containing legacy_example_20XX_projects.json files');
		process.exit(1);
	}

	return { assetRoot, legacyDir, yearFilter, dryRun };
}

// ── Asset discovery ──────────────────────────────────────

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

	// Exact match: {fileKey}_{prefix}.{ext}
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
	const gamePath = findAssetFile(join(yearDir, 'game'), fileKey, 'game', GAME_EXTS);
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

// ── Main import ──────────────────────────────────────────

async function main() {
	const opts = parseArgs();
	loadEnv();

	const prisma = new PrismaClient();

	try {
		await doImport(prisma, opts);
	} finally {
		await prisma.$disconnect();
	}
}

async function doImport(
	prisma: PrismaClient,
	opts: { assetRoot: string; legacyDir: string; yearFilter?: number; dryRun: boolean },
) {
	// Find legacy JSON files
	const legacyFiles = readdirSync(opts.legacyDir)
		.filter((f) => /^legacy_example_(\d{4})_projects\.json$/.test(f))
		.sort();

	if (legacyFiles.length === 0) {
		console.error(`No legacy_example_*_projects.json files found in ${opts.legacyDir}`);
		process.exit(1);
	}

	// Ensure a system user exists for creatorId
	const systemUser = await prisma.user.upsert({
		where: { googleSub: 'system-import' },
		update: {},
		create: {
			googleSub: 'system-import',
			email: 'import@system.local',
			name: 'System Import',
			role: 'ADMIN',
		},
	});

	const stats: ImportStats = { projects: 0, assets: 0, skipped: 0, failed: [] };

	for (const file of legacyFiles) {
		const yearMatch = file.match(/(\d{4})/);
		if (!yearMatch) continue;
		const year = parseInt(yearMatch[1]!, 10);

		if (opts.yearFilter && year !== opts.yearFilter) continue;
		if (year >= 2025) continue; // 2025 has different structure (Google Drive)

		console.log(`\n═══ ${year}년도 ═══`);

		const entries: LegacyEntry[] = JSON.parse(
			readFileSync(join(opts.legacyDir, file), 'utf-8'),
		);

		// Upsert exhibition
		const exhibitionTitle = `${year} 졸업작품전`;
		const exhibition = await prisma.exhibition.upsert({
			where: { year_title: { year, title: exhibitionTitle } },
			update: {},
			create: { year, title: exhibitionTitle, isUploadEnabled: false },
		});
		console.log(`전시회: ${exhibitionTitle} (id=${exhibition.id})`);

		for (const entry of entries) {
			const label = `${entry.title} (${entry.studentIds.join(', ')})`;

			// Skip if project already exists
			const baseSlug = toSlug(entry.title);
			const existing = await prisma.project.findFirst({
				where: {
					exhibitionId: exhibition.id,
					title: entry.title,
				},
			});
			if (existing) {
				console.log(`  SKIP: ${label} — already exists`);
				stats.skipped++;
				continue;
			}

			// Discover assets on NAS
			const assets = discoverAssets(opts.assetRoot, year, entry.studentIds);

			if (opts.dryRun) {
				console.log(`  DRY: ${label}`);
				for (const a of assets) {
					const sizeMB = (a.sizeBytes / 1024 / 1024).toFixed(1);
					console.log(`        ${a.kind}: ${a.filePath} (${sizeMB} MB)`);
				}
				if (assets.length === 0) console.log('        (no assets found)');
				stats.projects++;
				stats.assets += assets.length;
				continue;
			}

			// Generate unique slug
			let slug = baseSlug;
			let attempt = 0;
			while (
				await prisma.project.findUnique({
					where: { project_exhibition_slug: { exhibitionId: exhibition.id, slug } },
				})
			) {
				attempt++;
				slug = `${baseSlug}-${attempt}`;
			}

			// Determine platforms
			const platforms: ('PC' | 'MOBILE')[] = [];
			if (entry.isMobile === true) platforms.push('MOBILE');
			else platforms.push('PC');

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

				// Create project + members + assets in single transaction
				const project = await prisma.project.create({
					data: {
						exhibitionId: exhibition.id,
						slug,
						title: entry.title,
						isIncomplete: true,
						status: 'PUBLISHED',
						githubUrl: entry.githubLink ?? '',
						platforms,
						creatorId: systemUser.id,
						members: {
							create: entry.names.map((name, i) => ({
								name,
								studentId: entry.studentIds[i] ?? '',
								sortOrder: i,
							})),
						},
						assets: {
							create: assetRecords.map((a) => ({
								kind: a.kind,
								status: 'READY',
								storageKey: a.storageKey,
								originalName: a.originalName,
								mimeType: a.mimeType,
								sizeBytes: a.sizeBytes,
								isPublic: a.isPublic,
							})),
						},
					},
					include: { assets: true },
				});

				// Set poster
				const posterAsset = project.assets.find((a) => a.kind === 'POSTER');
				if (posterAsset) {
					await prisma.project.update({
						where: { id: project.id },
						data: { posterAssetId: posterAsset.id },
					});
				}

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
	}

	// Summary
	console.log('\n═══ Summary ═══');
	console.log(`  Projects imported: ${stats.projects}`);
	console.log(`  Assets uploaded:   ${stats.assets}`);
	console.log(`  Skipped (exist):   ${stats.skipped}`);
	console.log(`  Failed:            ${stats.failed.length}`);
	if (stats.failed.length > 0) {
		console.log('\nFailed projects:');
		for (const f of stats.failed) {
			console.log(`  - ${f.project}: ${f.reason}`);
		}
	}
}

main().catch((err) => {
	console.error('Import failed:', err);
	process.exit(1);
});
