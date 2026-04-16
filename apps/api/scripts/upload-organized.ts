/**
 * Upload assets from D:\upload_ready organized directory structure.
 *
 * Each project folder: {number}_{studentId}_{name}_{title}/
 *   poster/   → POSTER (first image file)
 *   game/     → GAME (ZIP files only)
 *   trailer/  → VIDEO (mp4/mov files)
 *   *.txt     → read GitHub URL → update project.githubUrl
 *
 * Matches projects by studentId extracted from folder name against
 * project members in the database (2025 exhibition).
 *
 * Usage (run from apps/api):
 *   npx tsx scripts/upload-organized.ts <upload-ready-root> [--dry-run]
 */

import { PrismaClient } from '@prisma/client';
import { readdirSync, statSync, createReadStream, readFileSync, mkdtempSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnv } from '../src/config/env.js';
import { processImage } from '../src/modules/assets/upload/image-processing.js';
import { processVideo } from '../src/modules/assets/upload/video-processing.js';
import { uploadFile } from '../src/lib/storage.js';
import { bucketForKind } from '../src/lib/s3.js';
import { generateStorageKey } from '../src/shared/storage-path.js';
import { copyFileSync } from 'node:fs';
import type { AssetKind } from '@prisma/client';

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
	'.mkv': 'video/x-matroska',
};

const IMAGE_MIMES_FOR_PROCESSING = new Set(['image/jpeg', 'image/png']);
const VIDEO_MIMES_FOR_PROCESSING = new Set([
	'video/mp4', 'video/quicktime', 'video/x-matroska',
]);

const SKIP_NAMES = new Set(['@eadir', '.ds_store', 'thumbs.db', 'desktop.ini']);

// ── Types ────────────────────────────────────────────────

interface ProjectFolder {
	path: string;
	folderName: string;
	studentId: string;
	githubUrl: string;
	poster: string | null;
	games: string[];
	trailers: string[];
}

interface AssetRecord {
	kind: AssetKind;
	storageKey: string;
	originalName: string;
	mimeType: string;
	sizeBytes: bigint;
	isPublic: boolean;
}

// ── CLI ──────────────────────────────────────────────────

function parseArgs() {
	const args = process.argv.slice(2);
	const positional: string[] = [];
	let dryRun = false;

	for (const arg of args) {
		if (arg === '--dry-run') dryRun = true;
		else if (!arg.startsWith('--')) positional.push(arg);
	}

	const root = positional[0] ?? '';
	if (!root) {
		console.error('Usage: npx tsx scripts/upload-organized.ts <upload-ready-root> [--dry-run]');
		process.exit(1);
	}

	return { root, dryRun };
}

// ── Discovery ────────────────────────────────────────────

function discoverProjectFolder(folderPath: string): ProjectFolder {
	const folderName = basename(folderPath);

	// Extract studentId from folder name: {number}_{studentId}_{name}_{title}
	const match = folderName.match(/^\d+_(\d+)/);
	const studentId = match?.[1] ?? '';

	// Find GitHub URL from txt files in root
	let githubUrl = '';
	const rootFiles = readdirSync(folderPath);
	for (const f of rootFiles) {
		const ext = extname(f).toLowerCase();
		if (ext === '.txt') {
			const content = readFileSync(join(folderPath, f), 'utf-8').trim();
			const urlMatch = content.match(/https?:\/\/[^\s]+/);
			if (urlMatch) {
				githubUrl = urlMatch[0];
				break;
			}
		} else if (ext === '.url') {
			const content = readFileSync(join(folderPath, f), 'utf-8');
			const urlMatch = content.match(/URL=(https?:\/\/[^\s]+)/i);
			if (urlMatch) {
				githubUrl = urlMatch[1]!;
				break;
			}
		}
	}

	// Find poster (first image in poster/)
	let poster: string | null = null;
	const posterDir = join(folderPath, 'poster');
	try {
		const posterFiles = readdirSync(posterDir)
			.filter((f) => !SKIP_NAMES.has(f.toLowerCase()))
			.filter((f) => {
				const ext = extname(f).toLowerCase();
				return ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);
			});
		if (posterFiles.length > 0) {
			poster = join(posterDir, posterFiles[0]!);
		}
	} catch { /* no poster dir */ }

	// Find game ZIPs
	const games: string[] = [];
	const gameDir = join(folderPath, 'game');
	try {
		const gameFiles = readdirSync(gameDir)
			.filter((f) => extname(f).toLowerCase() === '.zip');
		for (const f of gameFiles) {
			games.push(join(gameDir, f));
		}
	} catch { /* no game dir */ }

	// Find trailers (mp4/mov)
	const trailers: string[] = [];
	const trailerDir = join(folderPath, 'trailer');
	try {
		const trailerFiles = readdirSync(trailerDir)
			.filter((f) => !SKIP_NAMES.has(f.toLowerCase()))
			.filter((f) => {
				const ext = extname(f).toLowerCase();
				return ['.mp4', '.mov', '.mkv'].includes(ext);
			});
		for (const f of trailerFiles) {
			trailers.push(join(trailerDir, f));
		}
	} catch { /* no trailer dir */ }

	return { path: folderPath, folderName, studentId, githubUrl, poster, games, trailers };
}

// ── Upload ───────────────────────────────────────────────

async function uploadAsset(
	filePath: string,
	kind: AssetKind,
	tmpDir: string,
): Promise<{ storageKey: string; mimeType: string; sizeBytes: number; converted: boolean }> {
	const ext = extname(filePath).toLowerCase();
	const mime = MIME_MAP[ext] ?? 'application/octet-stream';
	let finalPath = filePath;
	let finalMime = mime;
	let finalExt = ext.replace('.', '');
	let finalSize = statSync(filePath).size;
	let converted = false;
	const tempFiles: string[] = [];

	try {
		// Image processing
		if (kind !== 'GAME' && kind !== 'VIDEO' && IMAGE_MIMES_FOR_PROCESSING.has(mime)) {
			const tmpPath = join(tmpDir, `${Date.now()}_${basename(filePath)}`);
			copyFileSync(filePath, tmpPath);
			tempFiles.push(tmpPath);
			try {
				const result = await processImage({
					tmpPath, mimeType: mime, ext: finalExt, sizeBytes: finalSize,
				});
				finalPath = result.tmpPath;
				finalMime = result.mimeType;
				finalExt = result.ext;
				finalSize = result.sizeBytes;
				converted = result.converted;
				if (result.converted && result.tmpPath !== tmpPath) tempFiles.push(result.tmpPath);
			} catch {
				finalPath = tmpPath;
			}
		}

		// Video processing
		if (kind === 'VIDEO' && VIDEO_MIMES_FOR_PROCESSING.has(mime)) {
			const tmpPath = join(tmpDir, `${Date.now()}_${basename(filePath)}`);
			copyFileSync(filePath, tmpPath);
			tempFiles.push(tmpPath);
			try {
				const result = await processVideo({
					tmpPath, mimeType: mime, ext: finalExt, sizeBytes: finalSize,
				});
				finalPath = result.tmpPath;
				finalMime = result.mimeType;
				finalExt = result.ext;
				finalSize = result.sizeBytes;
				converted = result.converted;
				if (result.converted && result.tmpPath !== tmpPath) tempFiles.push(result.tmpPath);
			} catch {
				finalPath = tmpPath;
			}
		}

		// Upload to S3
		const storageKey = generateStorageKey(finalExt);
		const bucket = bucketForKind(kind);
		const stat = await fsp.stat(finalPath);
		const stream = createReadStream(finalPath);
		await uploadFile(bucket, storageKey, stream, finalMime, stat.size);

		return { storageKey, mimeType: finalMime, sizeBytes: stat.size, converted };
	} finally {
		for (const t of tempFiles) await fsp.unlink(t).catch(() => {});
	}
}

// ── Main ─────────────────────────────────────────────────

async function main() {
	const opts = parseArgs();
	loadEnv();
	const prisma = new PrismaClient();

	try {
		await doUpload(prisma, opts);
	} finally {
		await prisma.$disconnect();
	}
}

async function doUpload(
	prisma: PrismaClient,
	opts: { root: string; dryRun: boolean },
) {
	// Read project folders
	const folders = readdirSync(opts.root)
		.filter((f) => {
			const p = join(opts.root, f);
			return statSync(p).isDirectory() && /^\d+_\d+/.test(f);
		})
		.sort()
		.map((f) => discoverProjectFolder(join(opts.root, f)));

	console.log(`Found ${folders.length} project folders.\n`);

	// Load 2025 projects from DB with members
	const dbProjects = await prisma.project.findMany({
		where: {
			exhibition: { year: 2025 },
		},
		include: {
			members: { select: { studentId: true } },
			assets: { select: { id: true } },
		},
	});

	const tmpDir = mkdtempSync(join(tmpdir(), 'upload-organized-'));
	console.log(`Temp directory: ${tmpDir}\n`);

	let processed = 0;
	let totalAssets = 0;
	let totalConverted = 0;
	const failed: { folder: string; reason: string }[] = [];
	const notMatched: string[] = [];

	try {
		for (const folder of folders) {
			console.log(`\n── ${folder.folderName} ──`);

			if (!folder.studentId) {
				console.log('  SKIP: no studentId in folder name');
				notMatched.push(folder.folderName);
				continue;
			}

			// Match by studentId
			const project = dbProjects.find((p) =>
				p.members.some((m) => m.studentId === folder.studentId),
			);

			if (!project) {
				console.log(`  SKIP: no matching project for studentId ${folder.studentId}`);
				notMatched.push(folder.folderName);
				continue;
			}

			if (project.assets.length > 0) {
				console.log(`  SKIP: ${project.title} already has ${project.assets.length} assets`);
				continue;
			}

			const hasContent = folder.poster || folder.games.length > 0 || folder.trailers.length > 0;
			if (!hasContent) {
				console.log(`  SKIP: no uploadable files`);
				continue;
			}

			console.log(`  Project: ${project.title} (id=${project.id})`);
			if (folder.githubUrl) console.log(`  GitHub: ${folder.githubUrl}`);

			if (folder.poster) {
				const sizeMB = (statSync(folder.poster).size / 1024 / 1024).toFixed(1);
				console.log(`  POSTER: ${basename(folder.poster)} (${sizeMB} MB)`);
			}
			for (const g of folder.games) {
				const sizeMB = (statSync(g).size / 1024 / 1024).toFixed(1);
				console.log(`  GAME:   ${basename(g)} (${sizeMB} MB)`);
			}
			for (const t of folder.trailers) {
				const sizeMB = (statSync(t).size / 1024 / 1024).toFixed(1);
				console.log(`  VIDEO:  ${basename(t)} (${sizeMB} MB)`);
			}

			if (opts.dryRun) {
				processed++;
				totalAssets += (folder.poster ? 1 : 0) + folder.games.length + folder.trailers.length;
				continue;
			}

			try {
				const records: AssetRecord[] = [];

				// Upload poster
				if (folder.poster) {
					const result = await uploadAsset(folder.poster, 'POSTER', tmpDir);
					if (result.converted) totalConverted++;
					records.push({
						kind: 'POSTER',
						storageKey: result.storageKey,
						originalName: basename(folder.poster),
						mimeType: result.mimeType,
						sizeBytes: BigInt(result.sizeBytes),
						isPublic: true,
					});
					const flag = result.converted ? ' → converted' : '';
					console.log(`        POSTER  ${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB  ${result.mimeType}${flag}`);
				}

				// Upload games
				for (const g of folder.games) {
					const result = await uploadAsset(g, 'GAME', tmpDir);
					records.push({
						kind: 'GAME',
						storageKey: result.storageKey,
						originalName: basename(g),
						mimeType: result.mimeType,
						sizeBytes: BigInt(result.sizeBytes),
						isPublic: false,
					});
					console.log(`        GAME    ${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB  ${result.mimeType}`);
				}

				// Upload trailers
				for (const t of folder.trailers) {
					const result = await uploadAsset(t, 'VIDEO', tmpDir);
					if (result.converted) totalConverted++;
					records.push({
						kind: 'VIDEO',
						storageKey: result.storageKey,
						originalName: basename(t),
						mimeType: result.mimeType,
						sizeBytes: BigInt(result.sizeBytes),
						isPublic: false,
					});
					const flag = result.converted ? ' → converted' : '';
					console.log(`        VIDEO   ${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB  ${result.mimeType}${flag}`);
				}

				// DB transaction: create assets + set poster + update githubUrl
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

					// Update GitHub URL if found
					if (folder.githubUrl && !project.githubUrl) {
						await tx.project.update({
							where: { id: project.id },
							data: { githubUrl: folder.githubUrl },
						});
					}
				});

				const summary = records.map((r) => r.kind[0]).join('');
				console.log(`  OK [${summary}]`);
				processed++;
				totalAssets += records.length;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`  FAIL: ${msg}`);
				failed.push({ folder: folder.folderName, reason: msg });
			}
		}
	} finally {
		await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}

	console.log('\n═══ Summary ═══');
	console.log(`  Projects processed: ${processed}`);
	console.log(`  Assets uploaded:    ${totalAssets}`);
	console.log(`  Converted:          ${totalConverted}`);
	console.log(`  Not matched:        ${notMatched.length}`);
	console.log(`  Failed:             ${failed.length}`);
	if (notMatched.length > 0) {
		console.log('\nNot matched:');
		for (const f of notMatched) console.log(`  - ${f}`);
	}
	if (failed.length > 0) {
		console.log('\nFailed:');
		for (const f of failed) console.log(`  - ${f.folder}: ${f.reason}`);
	}
}

main().catch((err) => {
	console.error('Upload failed:', err);
	process.exit(1);
});
