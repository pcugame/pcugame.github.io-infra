/**
 * Attach NAS assets to existing legacy projects in the database.
 *
 * Discovers ALL files matching {studentIds}_{prefix}.* on the NAS, regardless
 * of extension. No magic-byte validation is performed — files are trusted.
 *
 * Processing applied where possible:
 *   - Images (JPEG/PNG > 512 KB) → WebP conversion via sharp
 *   - Videos (non-MP4)           → MP4 normalisation via ffmpeg
 *   - Everything else            → uploaded as-is
 *
 * Usage (run from apps/api):
 *   npx tsx scripts/attach-legacy-assets.ts <nas-asset-root> [--year 2024] [--dry-run]
 *
 * NAS directory structure:
 *   <root>/{year}/poster/{ids}_poster.*
 *   <root>/{year}/game/{ids}_game.*
 *   <root>/{year}/video/{ids}_video.*
 *   <root>/{year}/poster/{ids}_manual.*   ← also picked up
 *
 * Requires: DATABASE_URL, S3_* env vars
 */

import { PrismaClient } from '@prisma/client';
import { readdirSync, statSync, copyFileSync, createReadStream, mkdtempSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnv } from '../src/config/env.js';
import { processImage } from '../src/modules/assets/upload/image-processing.js';
import { processVideo } from '../src/modules/assets/upload/video-processing.js';
import { uploadFile } from '../src/lib/storage.js';
import { bucketForKind } from '../src/lib/s3.js';
import { generateStorageKey } from '../src/shared/storage-path.js';
import type { AssetKind } from '@prisma/client';

// ── Types ────────────────────────────────────────────────

interface MatchedAsset {
	kind: AssetKind;
	filePath: string;
	originalName: string;
	mimeType: string;
	sizeBytes: number;
}

interface AssetRecord {
	kind: AssetKind;
	storageKey: string;
	originalName: string;
	mimeType: string;
	sizeBytes: bigint;
	isPublic: boolean;
}

interface AttachStats {
	projects: number;
	assets: number;
	converted: number;
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
	'.txt': 'text/plain',
	'.zip': 'application/zip',
	'.apk': 'application/vnd.android.package-archive',
	'.7z': 'application/x-7z-compressed',
	'.exe': 'application/x-msdownload',
	'.egg': 'application/octet-stream',
	'.rbxl': 'application/octet-stream',
	'.mp4': 'video/mp4',
	'.mov': 'video/quicktime',
	'.mkv': 'video/x-matroska',
	'.avi': 'video/x-msvideo',
	'.wmv': 'video/x-ms-wmv',
};

/** MIME types eligible for sharp WebP conversion. */
const PROCESSABLE_IMAGE_MIMES = new Set(['image/jpeg', 'image/png']);

/** MIME types eligible for ffmpeg MP4 normalisation. */
const PROCESSABLE_VIDEO_MIMES = new Set([
	'video/mp4', 'video/quicktime',
	'video/x-matroska', 'video/x-msvideo', 'video/x-ms-wmv',
]);

/** Preferred extension order for each prefix (best first). */
const POSTER_PREF = ['.webp', '.png', '.jpg', '.jpeg', '.pdf'];
const GAME_PREF = ['.zip', '.apk', '.7z', '.exe'];
const VIDEO_PREF = ['.mp4', '.mov', '.mkv', '.avi', '.wmv'];

/** Skip these entries (Synology metadata, etc.) */
const SKIP_NAMES = new Set(['@eadir', '.ds_store', 'thumbs.db']);

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
		process.exit(1);
	}

	return { assetRoot, yearFilter, dryRun };
}

// ── Asset discovery ──────────────────────────────────────

function buildFileKey(studentIds: string[]): string {
	return studentIds.join('_');
}

/**
 * Find a file matching `{fileKey}_{prefix}.*` in the given directory.
 * Tries preferred extensions first, then falls back to any extension.
 */
function findAssetFile(
	dir: string,
	fileKey: string,
	prefix: string,
	preferredExts: string[],
): string | null {
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => !SKIP_NAMES.has(f.toLowerCase()));
	} catch {
		return null;
	}

	const pattern = `${fileKey}_${prefix}`.toLowerCase();

	// Try preferred extensions first
	for (const ext of preferredExts) {
		const target = `${pattern}${ext}`;
		const found = files.find((f) => f.toLowerCase() === target);
		if (found) return join(dir, found);
	}

	// Fallback: any file matching the pattern
	const found = files.find((f) => {
		const lower = f.toLowerCase();
		const dotIdx = lower.lastIndexOf('.');
		if (dotIdx === -1) return false;
		return lower.substring(0, dotIdx) === pattern;
	});
	return found ? join(dir, found) : null;
}

/**
 * Find ALL files matching `{fileKey}_*.*` in a directory that don't match
 * the given main prefix. Used to discover extras like `_manual.*`.
 */
function findExtraFiles(
	dir: string,
	fileKey: string,
	mainPrefix: string,
): string[] {
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => !SKIP_NAMES.has(f.toLowerCase()));
	} catch {
		return [];
	}

	const keyLower = `${fileKey}_`.toLowerCase();
	const mainPattern = `${fileKey}_${mainPrefix}`.toLowerCase();

	return files
		.filter((f) => {
			const lower = f.toLowerCase();
			if (!lower.startsWith(keyLower)) return false;
			const dotIdx = lower.lastIndexOf('.');
			if (dotIdx === -1) return false;
			const nameWithoutExt = lower.substring(0, dotIdx);
			return nameWithoutExt !== mainPattern;
		})
		.map((f) => join(dir, f));
}

function discoverAssets(
	assetRoot: string,
	year: number,
	studentIds: string[],
): MatchedAsset[] {
	const fileKey = buildFileKey(studentIds);
	const yearDir = join(assetRoot, String(year));
	const assets: MatchedAsset[] = [];

	const addAsset = (kind: AssetKind, filePath: string) => {
		const ext = extname(filePath).toLowerCase();
		assets.push({
			kind,
			filePath,
			originalName: basename(filePath),
			mimeType: MIME_MAP[ext] ?? 'application/octet-stream',
			sizeBytes: statSync(filePath).size,
		});
	};

	// ── Standard assets (one per prefix) ──────────
	const posterDir = join(yearDir, 'poster');
	const gameDir = join(yearDir, 'game');
	const videoDir = join(yearDir, 'video');

	const posterPath = findAssetFile(posterDir, fileKey, 'poster', POSTER_PREF);
	if (posterPath) addAsset('POSTER', posterPath);

	const gamePath = findAssetFile(gameDir, fileKey, 'game', GAME_PREF);
	if (gamePath) addAsset('GAME', gamePath);

	const videoPath = findAssetFile(videoDir, fileKey, 'video', VIDEO_PREF);
	if (videoPath) addAsset('VIDEO', videoPath);

	// ── Extra files (manual, etc.) → IMAGE kind ──────────
	for (const extra of findExtraFiles(posterDir, fileKey, 'poster')) {
		addAsset('IMAGE', extra);
	}
	for (const extra of findExtraFiles(gameDir, fileKey, 'game')) {
		addAsset('IMAGE', extra);
	}
	for (const extra of findExtraFiles(videoDir, fileKey, 'video')) {
		addAsset('IMAGE', extra);
	}

	return assets;
}

// ── Upload & processing ──────────────────────────────────

/**
 * Upload a single asset to S3, applying conversion where possible.
 * No magic-byte validation — files are trusted.
 */
async function uploadAsset(
	asset: MatchedAsset,
	tmpDir: string,
): Promise<{ storageKey: string; mimeType: string; sizeBytes: number; converted: boolean }> {
	let finalPath = asset.filePath;
	let finalMime = asset.mimeType;
	let finalExt = extname(asset.filePath).toLowerCase().replace('.', '');
	let finalSize = asset.sizeBytes;
	let converted = false;
	const tempFiles: string[] = [];

	try {
		// ── Image processing (WebP conversion) ────────────────
		if (
			asset.kind !== 'GAME' && asset.kind !== 'VIDEO'
			&& PROCESSABLE_IMAGE_MIMES.has(asset.mimeType)
		) {
			const tmpPath = join(tmpDir, `${Date.now()}_${basename(asset.filePath)}`);
			copyFileSync(asset.filePath, tmpPath);
			tempFiles.push(tmpPath);

			try {
				const result = await processImage({
					tmpPath,
					mimeType: asset.mimeType,
					ext: finalExt,
					sizeBytes: asset.sizeBytes,
				});
				finalPath = result.tmpPath;
				finalMime = result.mimeType;
				finalExt = result.ext;
				finalSize = result.sizeBytes;
				converted = result.converted;
				if (result.converted && result.tmpPath !== tmpPath) {
					tempFiles.push(result.tmpPath);
				}
			} catch {
				// Processing failed — use original copy
				finalPath = tmpPath;
			}
		}

		// ── Video processing (MP4 normalisation) ──────────────
		if (asset.kind === 'VIDEO' && PROCESSABLE_VIDEO_MIMES.has(asset.mimeType)) {
			const tmpPath = join(tmpDir, `${Date.now()}_${basename(asset.filePath)}`);
			copyFileSync(asset.filePath, tmpPath);
			tempFiles.push(tmpPath);

			try {
				const result = await processVideo({
					tmpPath,
					mimeType: asset.mimeType,
					ext: finalExt,
					sizeBytes: asset.sizeBytes,
				});
				finalPath = result.tmpPath;
				finalMime = result.mimeType;
				finalExt = result.ext;
				finalSize = result.sizeBytes;
				converted = result.converted;
				if (result.converted && result.tmpPath !== tmpPath) {
					tempFiles.push(result.tmpPath);
				}
			} catch {
				// Processing failed — use original copy
				finalPath = tmpPath;
			}
		}

		// ── Upload to S3 ──────────────────────────────────────
		const storageKey = generateStorageKey(finalExt);
		const bucket = bucketForKind(asset.kind);
		const stat = await fsp.stat(finalPath);
		const stream = createReadStream(finalPath);
		await uploadFile(bucket, storageKey, stream, finalMime, stat.size);

		return { storageKey, mimeType: finalMime, sizeBytes: stat.size, converted };
	} finally {
		// Clean up temp files
		for (const t of tempFiles) {
			await fsp.unlink(t).catch(() => {});
		}
	}
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

	const stats: AttachStats = {
		projects: 0, assets: 0, converted: 0, noFiles: 0, failed: [],
	};
	let currentYear = 0;

	const tmpDir = mkdtempSync(join(tmpdir(), 'legacy-import-'));
	console.log(`Temp directory: ${tmpDir}\n`);

	try {
		for (const project of projects) {
			const year = project.exhibition.year;

			if (year !== currentYear) {
				currentYear = year;
				const yearProjects = projects.filter((p) => p.exhibition.year === year);
				console.log(`\n═══ ${year}년도 ═══`);
				console.log(`전시회: ${project.exhibition.title} (${yearProjects.length} projects without assets)`);
			}

			const studentIds = project.members
				.map((m) => m.studentId)
				.filter((id) => id.length > 0);

			const label = `${project.title} (${studentIds.join(', ')})`;

			if (studentIds.length === 0) {
				console.log(`  SKIP: ${label} — no studentIds on members`);
				stats.noFiles++;
				continue;
			}

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
					console.log(`        ${a.kind.padEnd(7)} ${a.originalName} (${sizeMB} MB)`);
				}
				stats.projects++;
				stats.assets += assets.length;
				continue;
			}

			try {
				const records: AssetRecord[] = [];

				for (const asset of assets) {
					const result = await uploadAsset(asset, tmpDir);
					if (result.converted) stats.converted++;

					records.push({
						kind: asset.kind,
						storageKey: result.storageKey,
						originalName: asset.originalName,
						mimeType: result.mimeType,
						sizeBytes: BigInt(result.sizeBytes),
						isPublic: asset.kind !== 'GAME' && asset.kind !== 'VIDEO',
					});

					const sizeMB = (result.sizeBytes / 1024 / 1024).toFixed(1);
					const flag = result.converted ? '→ converted' : '';
					console.log(`        ${asset.kind.padEnd(7)} ${sizeMB} MB  ${result.mimeType} ${flag}`);
				}

				await prisma.$transaction(async (tx) => {
					for (const rec of records) {
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

						if (rec.kind === 'POSTER') {
							await tx.project.update({
								where: { id: project.id },
								data: { posterAssetId: created.id },
							});
						}
					}
				});

				const summary = records.map((a) => a.kind[0]).join('');
				console.log(`  OK: ${label} [${summary}]`);
				stats.projects++;
				stats.assets += records.length;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`  FAIL: ${label} — ${msg}`);
				stats.failed.push({ project: label, reason: msg });
			}
		}
	} finally {
		await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}

	console.log('\n═══ Summary ═══');
	console.log(`  Projects processed: ${stats.projects}`);
	console.log(`  Assets uploaded:    ${stats.assets}`);
	console.log(`  Converted:          ${stats.converted}`);
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
