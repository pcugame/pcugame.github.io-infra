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
import type { AssetPlaybackStatus } from '@prisma/client';
import { readdirSync, statSync, createReadStream, readFileSync, mkdtempSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnv } from '../src/config/env.js';
import { processImage } from '../src/modules/assets/upload/image-processing.js';
import { processPdf } from '../src/modules/assets/upload/pdf-processing.js';
import { processVideo } from '../src/modules/assets/upload/video-processing.js';
import { validateFile } from '../src/modules/assets/upload/file-validator.js';
import { storageOptionsForAsset } from '../src/modules/assets/upload/storage-policy.js';
import { uploadFile } from '../src/lib/storage.js';
import { bucketForKind } from '../src/lib/s3.js';
import { generateStorageKey } from '../src/shared/storage-path.js';
import { copyFileSync } from 'node:fs';
import type { AssetKind } from '@prisma/client';

const SKIP_NAMES = new Set(['@eadir', '.ds_store', 'thumbs.db', 'desktop.ini']);

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

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
	playbackStorageKey?: string | null;
	originalName: string;
	mimeType: string;
	playbackMimeType?: string;
	sizeBytes: bigint;
	playbackSizeBytes?: bigint;
	playbackStatus?: AssetPlaybackStatus;
	playbackError?: string;
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
): Promise<{
	storageKey: string;
	playbackStorageKey?: string | null;
	mimeType: string;
	playbackMimeType?: string;
	sizeBytes: number;
	playbackSizeBytes?: number;
	playbackStatus?: AssetPlaybackStatus;
	playbackError?: string;
	converted: boolean;
}> {
	const validated = await validateFile(filePath, kind);
	let finalPath = filePath;
	let finalMime = validated.mimeType;
	let finalExt = validated.ext;
	let finalSize = validated.sizeBytes;
	let converted = false;
	const tempFiles: string[] = [];

	try {
		// Image processing
		if (kind !== 'GAME' && kind !== 'VIDEO') {
			const tmpPath = join(tmpDir, `${Date.now()}_${basename(filePath)}`);
			copyFileSync(filePath, tmpPath);
			tempFiles.push(tmpPath);
			const result = validated.mimeType === 'application/pdf'
				? await processPdf({ tmpPath })
				: await processImage({
					tmpPath, mimeType: validated.mimeType, ext: validated.ext, sizeBytes: validated.sizeBytes,
				});
			finalPath = result.tmpPath;
			finalMime = result.mimeType;
			finalExt = result.ext;
			finalSize = result.sizeBytes;
			converted = result.converted;
			if (result.converted && result.tmpPath !== tmpPath) tempFiles.push(result.tmpPath);
		}

		// Video processing
		if (kind === 'VIDEO') {
			const tmpPath = join(tmpDir, `${Date.now()}_${basename(filePath)}`);
			copyFileSync(filePath, tmpPath);
			tempFiles.push(tmpPath);

			const playback = await processVideo({
				tmpPath, mimeType: validated.mimeType, ext: validated.ext, sizeBytes: validated.sizeBytes,
			});
			if (playback.playbackStatus === 'FAILED') {
				throw new Error(`Video validation failed: ${playback.playbackError || 'unsupported or corrupt video'}`);
			}
			if (playback.playback) tempFiles.push(playback.playback.tmpPath);

			const storageKey = generateStorageKey(validated.ext);
			const bucket = bucketForKind(kind);
			await uploadFile(
				bucket,
				storageKey,
				createReadStream(tmpPath),
				validated.mimeType,
				validated.sizeBytes,
				storageOptionsForAsset(kind, 'original'),
			);

			let playbackStorageKey: string | null = null;
			let playbackMimeType = '';
			let playbackSizeBytes = 0;
			let playbackStatus = playback.playbackStatus;
			let playbackError = playback.playbackError;
			if (playback.playback) {
				const candidatePlaybackKey = generateStorageKey(playback.playback.ext);
				try {
					await uploadFile(
						bucket,
						candidatePlaybackKey,
						createReadStream(playback.playback.tmpPath),
						playback.playback.mimeType,
						playback.playback.sizeBytes,
						storageOptionsForAsset(kind, 'playback'),
					);
					playbackStorageKey = candidatePlaybackKey;
					playbackMimeType = playback.playback.mimeType;
					playbackSizeBytes = playback.playback.sizeBytes;
				} catch (err) {
					playbackStatus = 'FAILED';
					playbackError = errorMessage(err).slice(0, 2000);
				}
			}

			return {
				storageKey,
				playbackStorageKey,
				mimeType: validated.mimeType,
				playbackMimeType,
				sizeBytes: validated.sizeBytes,
				playbackSizeBytes,
				playbackStatus,
				playbackError,
				converted: playback.converted,
			};
		}

		// Upload to S3
		const storageKey = generateStorageKey(finalExt);
		const bucket = bucketForKind(kind);
		const stat = await fsp.stat(finalPath);
		const stream = createReadStream(finalPath);
		await uploadFile(bucket, storageKey, stream, finalMime, stat.size, storageOptionsForAsset(kind, 'original'));

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
						playbackStorageKey: result.playbackStorageKey,
						originalName: basename(folder.poster),
						mimeType: result.mimeType,
						playbackMimeType: result.playbackMimeType,
						sizeBytes: BigInt(result.sizeBytes),
						playbackSizeBytes: BigInt(result.playbackSizeBytes ?? 0),
						playbackStatus: result.playbackStatus,
						playbackError: result.playbackError,
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
						playbackStorageKey: result.playbackStorageKey,
						originalName: basename(g),
						mimeType: result.mimeType,
						playbackMimeType: result.playbackMimeType,
						sizeBytes: BigInt(result.sizeBytes),
						playbackSizeBytes: BigInt(result.playbackSizeBytes ?? 0),
						playbackStatus: result.playbackStatus,
						playbackError: result.playbackError,
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
						playbackStorageKey: result.playbackStorageKey,
						originalName: basename(t),
						mimeType: result.mimeType,
						playbackMimeType: result.playbackMimeType,
						sizeBytes: BigInt(result.sizeBytes),
						playbackSizeBytes: BigInt(result.playbackSizeBytes ?? 0),
						playbackStatus: result.playbackStatus,
						playbackError: result.playbackError,
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
								playbackStorageKey: rec.playbackStorageKey ?? null,
								originalName: rec.originalName,
								mimeType: rec.mimeType,
								playbackMimeType: rec.playbackMimeType ?? '',
								sizeBytes: rec.sizeBytes,
								playbackSizeBytes: rec.playbackSizeBytes ?? BigInt(0),
								playbackStatus: rec.playbackStatus ?? 'PENDING',
								playbackError: rec.playbackError ?? '',
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
