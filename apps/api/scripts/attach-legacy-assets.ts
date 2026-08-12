/**
 * Attach NAS assets to existing legacy projects in the database.
 *
 * Discovers ALL files matching {studentIds}_{prefix}.* on the NAS, regardless
 * of extension. Files are validated by the same magic-byte pipeline used by
 * normal web uploads before they are uploaded.
 *
 * Processing applied where possible:
 *   - Images/PDF posters         → decoded and re-encoded to WebP
 *   - Videos                     → ffprobe validation + MP4 playback preparation
 *   - Game files                 → ZIP structure validation before upload
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

import { readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { loadEnv } from '../src/config/env.js';
import type { AssetKind } from '../src/generated/prisma/client.js';
import { createScriptResources } from './resources.js';
import {
	createScriptAsset,
	runScriptUploadItem,
	type ScriptUploadItemResources,
} from './script-upload.js';

// ── Types ────────────────────────────────────────────────

interface MatchedAsset {
	kind: AssetKind;
	filePath: string;
	originalName: string;
	sizeBytes: number;
}

interface AttachStats {
	projects: number;
	assets: number;
	converted: number;
	noFiles: number;
	failed: { project: string; reason: string }[];
}

// ── Config ───────────────────────────────────────────────

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
		assets.push({
			kind,
			filePath,
			originalName: basename(filePath),
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

// ── Main ─────────────────────────────────────────────────

async function main() {
	const opts = parseArgs();
	const config = loadEnv();

	const resources = createScriptResources(config);
	try {
		await doAttach(resources, opts);
	} finally {
		await resources.close();
	}
}

async function doAttach(
	resources: ScriptUploadItemResources,
	opts: { assetRoot: string; yearFilter?: number; dryRun: boolean },
) {
	const prisma = resources.prisma;
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
				const { uploads } = await runScriptUploadItem(
					resources,
					{ projectId: project.id, exhibitionId: project.exhibitionId },
					assets.map((asset) => ({
						kind: asset.kind,
						filePath: asset.filePath,
						originalName: asset.originalName,
					})),
					async (tx, uploadedAssets) => {
						for (const uploaded of uploadedAssets) {
							const created = await createScriptAsset(tx, project.id, uploaded);
							if (uploaded.saved.kind === 'POSTER') {
								await tx.project.update({
									where: { id: project.id },
									data: { posterAssetId: created.id },
								});
							}
						}
					},
				);

				for (const uploaded of uploads) {
					if (uploaded.converted) stats.converted++;
					const sizeMB = (uploaded.saved.sizeBytes / 1024 / 1024).toFixed(1);
					const flag = uploaded.converted ? '→ converted' : '';
					console.log(
						`        ${uploaded.saved.kind.padEnd(7)} ${sizeMB} MB  ${uploaded.saved.mimeType} ${flag}`,
					);
				}

				const summary = uploads.map(({ saved }) => saved.kind[0]).join('');
				console.log(`  OK: ${label} [${summary}]`);
				stats.projects++;
				stats.assets += uploads.length;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`  FAIL: ${label} — ${msg}`);
				stats.failed.push({ project: label, reason: msg });
			}
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
