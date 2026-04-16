import { promises as fsp } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3, bucketForKind } from '../../../lib/s3.js';
import { logger } from '../../../lib/logger.js';
import { conflict } from '../../../shared/errors.js';
import type { AssetKind } from '@prisma/client';
import * as repo from './repository.js';

// ── Path helpers ────────────────────────────────────────

/** Remove characters forbidden in directory names on Windows/POSIX */
function safeDirName(name: string): string {
	return name
		.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
		.replace(/\s+/g, ' ')
		.trim()
		|| 'unnamed';
}

/** `{year}_{title}` */
function exhibitionDirName(year: number, title: string): string {
	return safeDirName(title ? `${year}_${title}` : `${year}`);
}

/** `{title}_{studentId1}{name1}_{studentId2}{name2}_...` */
function projectDirName(
	title: string,
	members: { studentId: string; name: string; sortOrder: number }[],
): string {
	const sorted = [...members].sort((a, b) => a.sortOrder - b.sortOrder);
	const memberPart = sorted.map((m) => `${m.studentId}${m.name}`).join('_');
	return safeDirName(memberPart ? `${title}_${memberPart}` : title);
}

function extFromKey(storageKey: string): string {
	const dot = storageKey.lastIndexOf('.');
	return dot >= 0 ? storageKey.slice(dot + 1) : 'bin';
}

/** `poster.webp`, `image.png`, `image_2.webp`, ... */
function assetFileName(kind: string, ext: string, index: number): string {
	const base = kind.toLowerCase();
	return index > 0 ? `${base}_${index + 1}.${ext}` : `${base}.${ext}`;
}

// ── Server-side mutex ──────────────────────────────────

let exportRunning = false;

function acquireExportLock(): void {
	if (exportRunning) {
		throw conflict('Export is already in progress');
	}
	exportRunning = true;
}

function releaseExportLock(): void {
	exportRunning = false;
}

// ── S3 download (atomic + abortable) ──────────────────

/** Generate a temp path next to the final destination */
function tmpPath(destPath: string): string {
	return `${destPath}.${randomUUID()}.tmp`;
}

async function downloadObject(
	bucket: string,
	key: string,
	destPath: string,
	signal?: AbortSignal,
): Promise<void> {
	const tmp = tmpPath(destPath);
	try {
		const res = await s3().send(
			new GetObjectCommand({ Bucket: bucket, Key: key }),
			{ abortSignal: signal },
		);
		const ws = createWriteStream(tmp);
		await pipeline(res.Body as Readable, ws, { signal });
		await fsp.rename(tmp, destPath);
	} catch (err) {
		// Clean up temp file on any failure (abort, network, disk, etc.)
		await fsp.unlink(tmp).catch(() => {});
		throw err;
	}
}

// ── Public API ──────────────────────────────────────────

export interface ExportOptions {
	outDir: string;
	year?: number;
	dryRun?: boolean;
	signal?: AbortSignal;
}

export interface ExportResult {
	projects: number;
	totalFiles: number;
	downloaded: number;
	skipped: number;
	failed: number;
	aborted: boolean;
	paths: string[];
}

export async function exportAssets(opts: ExportOptions): Promise<ExportResult> {
	acquireExportLock();
	try {
		return await doExport(opts);
	} finally {
		releaseExportLock();
	}
}

async function doExport(opts: ExportOptions): Promise<ExportResult> {
	const projects = await repo.findProjectsWithAssets(opts.year);

	const result: ExportResult = {
		projects: projects.length,
		totalFiles: 0,
		downloaded: 0,
		skipped: 0,
		failed: 0,
		aborted: false,
		paths: [],
	};

	if (projects.length === 0) return result;

	const assetsDir = join(opts.outDir, 'Assets');

	for (const project of projects) {
		// Check abort before each project
		if (opts.signal?.aborted) {
			result.aborted = true;
			logger().warn('Export aborted by client disconnect');
			break;
		}

		const exDir = exhibitionDirName(project.exhibition.year, project.exhibition.title);
		const projDir = projectDirName(project.title, project.members);
		const fullDir = join(assetsDir, exDir, projDir);

		const kindCount = new Map<string, number>();

		for (const asset of project.assets) {
			if (opts.signal?.aborted) {
				result.aborted = true;
				break;
			}

			const idx = kindCount.get(asset.kind) ?? 0;
			kindCount.set(asset.kind, idx + 1);

			const ext = extFromKey(asset.storageKey);
			const fileName = assetFileName(asset.kind, ext, idx);
			const destPath = join(fullDir, fileName);
			const bucket = bucketForKind(asset.kind as AssetKind);

			result.totalFiles++;

			if (opts.dryRun) {
				result.paths.push(destPath);
				continue;
			}

			// Idempotent: skip if file already exists
			try {
				await fsp.access(destPath);
				result.skipped++;
				continue;
			} catch {
				// doesn't exist — proceed
			}

			await fsp.mkdir(fullDir, { recursive: true });

			try {
				await downloadObject(bucket, asset.storageKey, destPath, opts.signal);
				result.downloaded++;
			} catch (err) {
				if (opts.signal?.aborted) {
					result.aborted = true;
					break;
				}
				logger().error({ err, storageKey: asset.storageKey }, 'Export download failed');
				result.failed++;
			}
		}

		if (result.aborted) break;
	}

	return result;
}
