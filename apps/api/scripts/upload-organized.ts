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

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { loadEnv } from '../src/config/env.js';
import { createScriptResources } from './resources.js';
import {
	createScriptAsset,
	runScriptUploadItem,
	type ScriptUploadItemResources,
	type ScriptUploadSource,
} from './script-upload.js';

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

// ── Main ─────────────────────────────────────────────────

async function main() {
	const opts = parseArgs();
	const config = loadEnv();
	const resources = createScriptResources(config);

	try {
		await doUpload(resources, opts);
	} finally {
		await resources.close();
	}
}

async function doUpload(
	resources: ScriptUploadItemResources,
	opts: { root: string; dryRun: boolean },
) {
	const prisma = resources.prisma;
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

	let processed = 0;
	let totalAssets = 0;
	let totalConverted = 0;
	const failed: { folder: string; reason: string }[] = [];
	const notMatched: string[] = [];

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
				const sources: ScriptUploadSource[] = [];
				if (folder.poster) {
					sources.push({
						kind: 'POSTER',
						filePath: folder.poster,
						originalName: basename(folder.poster),
					});
				}
				for (const g of folder.games) {
					sources.push({
						kind: 'GAME',
						filePath: g,
						originalName: basename(g),
					});
				}
				for (const t of folder.trailers) {
					sources.push({
						kind: 'VIDEO',
						filePath: t,
						originalName: basename(t),
					});
				}

				const { uploads } = await runScriptUploadItem(
					resources,
					{ projectId: project.id, exhibitionId: project.exhibitionId },
					sources,
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

						if (folder.githubUrl && !project.githubUrl) {
							await tx.project.update({
								where: { id: project.id },
								data: { githubUrl: folder.githubUrl },
							});
						}
					},
				);

				for (const uploaded of uploads) {
					if (uploaded.converted) totalConverted++;
					const flag = uploaded.converted ? ' → converted' : '';
					console.log(
						`        ${uploaded.saved.kind.padEnd(7)} ${(uploaded.saved.sizeBytes / 1024 / 1024).toFixed(1)} MB  ${uploaded.saved.mimeType}${flag}`,
					);
				}

				const summary = uploads.map(({ saved }) => saved.kind[0]).join('');
				console.log(`  OK [${summary}]`);
				processed++;
				totalAssets += uploads.length;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`  FAIL: ${msg}`);
				failed.push({ folder: folder.folderName, reason: msg });
			}
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
