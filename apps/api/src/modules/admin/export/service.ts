import { dirname, join } from 'node:path';
import type {
	AssetKind,
	ExportFileStatus,
	ExportProgress,
	ExportResult,
} from '@pcu/contracts';
import { conflict } from '../../../shared/errors.js';
import { parseWebglEntryKey } from '../../webgl/paths.js';
import type { ExportProject } from './ports.js';
export type { ExportProject } from './ports.js';

function safeDirName(name: string): string {
	return name
		.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
		.replace(/\s+/g, ' ')
		.trim()
		|| 'unnamed';
}

function exhibitionDirName(year: number, title: string): string {
	return safeDirName(title ? `${year}_${title}` : `${year}`);
}

function projectDirName(
	title: string,
	members: { studentId: string; name: string; sortOrder: number }[],
): string {
	const sorted = [...members].sort((a, b) => a.sortOrder - b.sortOrder);
	const memberPart = sorted.map((member) => `${member.studentId}${member.name}`).join('_');
	return safeDirName(memberPart ? `${title}_${memberPart}` : title);
}

function extFromKey(storageKey: string): string {
	const dot = storageKey.lastIndexOf('.');
	return dot >= 0 ? storageKey.slice(dot + 1) : 'bin';
}

function assetFileName(kind: string, ext: string, index: number): string {
	const base = kind.toLowerCase();
	return index > 0 ? `${base}_${index + 1}.${ext}` : `${base}.${ext}`;
}

/** Process-local lock/progress implementation. Replace this port for multi-replica operation. */
export interface ExportProgressStore {
	start(year: number | null, startedAt: number): void;
	get(): ExportProgress | null;
	update(update: (progress: ExportProgress) => void): void;
	finish(): void;
	close(): void;
}

class InMemoryExportProgressStore implements ExportProgressStore {
	private progress: ExportProgress | null = null;
	private closed = false;

	start(year: number | null, startedAt: number): void {
		if (this.closed) throw new Error('Export progress store is closed');
		if (this.progress) throw conflict('Export is already in progress');
		this.progress = {
			year,
			startedAt,
			phase: 'preparing',
			totalProjects: 0,
			currentProjectIndex: 0,
			currentProjectTitle: null,
			currentProjectFiles: [],
			totalFiles: 0,
			downloaded: 0,
			skipped: 0,
			failed: 0,
		};
	}

	get(): ExportProgress | null {
		return this.progress
			? { ...this.progress, currentProjectFiles: [...this.progress.currentProjectFiles] }
			: null;
	}

	update(update: (progress: ExportProgress) => void): void {
		if (this.closed) return;
		if (this.progress) update(this.progress);
	}

	finish(): void {
		this.progress = null;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.progress = null;
	}
}

export function createExportProgressStore(): ExportProgressStore {
	return new InMemoryExportProgressStore();
}

export interface ExportOptions {
	outDir: string;
	year?: number;
	dryRun?: boolean;
	signal?: AbortSignal;
}

export interface ExportServiceDependencies {
	findProjects(year?: number): Promise<ExportProject[]>;
	pathExists(path: string): Promise<boolean>;
	ensureDirectory(path: string): Promise<void>;
	saveObject(bucket: string, key: string, destination: string, signal?: AbortSignal): Promise<void>;
	bucketForKind(kind: AssetKind): string;
	protectedBucket: string;
	now(): number;
	logWarn(message: string): void;
	logError(context: Record<string, unknown>, message: string): void;
}

export function createExportService(
	deps: ExportServiceDependencies,
	progressStore: ExportProgressStore,
) {
	let closed = false;
	let active:
		| {
			controller: AbortController;
			settled: Promise<void>;
		}
		| undefined;
	let closePromise: Promise<void> | undefined;

	function setCurrentFileStatus(assetId: number, status: ExportFileStatus): void {
		progressStore.update((progress) => {
			progress.currentProjectFiles = progress.currentProjectFiles.map((file) =>
				file.assetId === assetId ? { ...file, status } : file,
			);
		});
	}

	async function doExport(options: ExportOptions): Promise<ExportResult> {
		const projects = await deps.findProjects(options.year);
		const totalFiles = projects.reduce(
			(sum, project) => sum + project.assets.length
				+ (parseWebglEntryKey(project.id, project.webglEntryKey) && project.webglSourceKey ? 1 : 0),
			0,
		);
		const result: ExportResult = {
			projects: projects.length,
			totalFiles,
			downloaded: 0,
			skipped: 0,
			failed: 0,
			aborted: false,
			paths: [],
		};

		progressStore.update((progress) => {
			progress.totalProjects = projects.length;
			progress.totalFiles = totalFiles;
			progress.phase = projects.length === 0 ? 'finishing' : 'downloading';
		});
		if (projects.length === 0) return result;

		const assetsDir = join(options.outDir, 'ExportedAssets');
		for (let projectIndex = 0; projectIndex < projects.length; projectIndex++) {
			const project = projects[projectIndex];
			if (!project) continue;
			if (options.signal?.aborted) {
				result.aborted = true;
				deps.logWarn('Export aborted by client disconnect');
				break;
			}

			progressStore.update((progress) => {
				progress.currentProjectIndex = projectIndex;
				progress.currentProjectTitle = project.title;
			});

			const fullDir = join(
				assetsDir,
				exhibitionDirName(project.exhibition.year, project.exhibition.title),
				projectDirName(project.title, project.members),
			);
			const kindCount = new Map<string, number>();
			const projectFiles: Array<{
				asset: { id: number; kind: AssetKind | 'WEBGL'; storageKey: string; originalName: string };
				fileName: string;
				destination: string;
			}> = project.assets.map((asset) => {
				const index = kindCount.get(asset.kind) ?? 0;
				kindCount.set(asset.kind, index + 1);
				const fileName = assetFileName(asset.kind, extFromKey(asset.storageKey), index);
				return { asset, fileName, destination: join(fullDir, fileName) };
			});
			const webgl = parseWebglEntryKey(project.id, project.webglEntryKey);
			if (webgl && project.webglSourceKey) {
				projectFiles.push({
					asset: {
						id: -project.id,
						kind: 'WEBGL',
						storageKey: project.webglSourceKey,
						originalName: 'webgl.zip',
					},
					fileName: 'webgl/webgl.zip',
					destination: join(fullDir, 'webgl', 'webgl.zip'),
				});
			}

			progressStore.update((progress) => {
				progress.currentProjectFiles = projectFiles.map(({ asset, fileName }) => ({
					assetId: asset.id,
					kind: asset.kind,
					originalName: asset.originalName,
					fileName,
					status: 'pending',
				}));
			});

			for (const { asset, destination } of projectFiles) {
				if (options.signal?.aborted) {
					result.aborted = true;
					break;
				}
				const bucket = asset.kind === 'WEBGL'
					? deps.protectedBucket
					: deps.bucketForKind(asset.kind);
				if (options.dryRun) {
					result.paths.push(destination);
					continue;
				}
				if (await deps.pathExists(destination)) {
					result.skipped++;
					progressStore.update((progress) => { progress.skipped = result.skipped; });
					setCurrentFileStatus(asset.id, 'skipped');
					continue;
				}

				await deps.ensureDirectory(dirname(destination));
				try {
					setCurrentFileStatus(asset.id, 'saving');
					await deps.saveObject(bucket, asset.storageKey, destination, options.signal);
					result.downloaded++;
					progressStore.update((progress) => { progress.downloaded = result.downloaded; });
					setCurrentFileStatus(asset.id, 'saved');
				} catch (err) {
					if (options.signal?.aborted) {
						result.aborted = true;
						break;
					}
					deps.logError({ err, assetId: asset.id, projectId: project.id }, 'Export download failed');
					result.failed++;
					progressStore.update((progress) => { progress.failed = result.failed; });
					setCurrentFileStatus(asset.id, 'failed');
				}
			}
			if (result.aborted) break;
		}

		if (!result.aborted) {
			progressStore.update((progress) => { progress.phase = 'finishing'; });
		}
		return result;
	}

	return {
		getExportProgress: () => progressStore.get(),
		async exportAssets(options: ExportOptions): Promise<ExportResult> {
			if (closed) throw new Error('Export service is closed');
			progressStore.start(options.year ?? null, deps.now());
			const controller = new AbortController();
			const abort = () => controller.abort();
			if (options.signal?.aborted) abort();
			else options.signal?.addEventListener('abort', abort, { once: true });
			const operation = doExport({ ...options, signal: controller.signal });
			let resolveSettled!: () => void;
			const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
			active = { controller, settled };
			try {
				return await operation;
			} finally {
				options.signal?.removeEventListener('abort', abort);
				progressStore.finish();
				if (active?.controller === controller) active = undefined;
				resolveSettled();
			}
		},
		/**
		 * Context shutdown first aborts storage/stream/filesystem work, then waits
		 * for sibling-temp cleanup and the service finally block to release the
		 * active lock. The context closes the progress store only after this ends.
		 */
		close(): Promise<void> {
			closePromise ??= (async () => {
				closed = true;
				const running = active;
				running?.controller.abort();
				await running?.settled;
			})();
			return closePromise;
		},
	};
}
