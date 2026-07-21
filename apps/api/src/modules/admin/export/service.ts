import { dirname, join } from 'node:path';
import type {
	AssetKind,
	ExportFileStatus,
	ExportProgress,
	ExportResult,
} from '@pcu/contracts';
import { conflict } from '../../../shared/errors.js';
import { parseWebglEntryKey } from '../../webgl/paths.js';

export interface ExportProject {
	id: number;
	title: string;
	webglEntryKey: string;
	exhibition: { year: number; title: string };
	members: { name: string; studentId: string; sortOrder: number }[];
	assets: {
		id: number;
		kind: AssetKind;
		storageKey: string;
		originalName: string;
		mimeType: string;
		sizeBytes: bigint;
	}[];
}

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
export class InMemoryExportProgressStore {
	private progress: ExportProgress | null = null;

	start(year: number | null, startedAt: number): void {
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
		return this.progress;
	}

	update(update: (progress: ExportProgress) => void): void {
		if (this.progress) update(this.progress);
	}

	finish(): void {
		this.progress = null;
	}
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
	progressStore = new InMemoryExportProgressStore(),
) {
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
				+ (parseWebglEntryKey(project.id, project.webglEntryKey) ? 1 : 0),
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
			if (webgl) {
				projectFiles.push({
					asset: {
						id: -project.id,
						kind: 'WEBGL',
						storageKey: webgl.sourceKey,
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
					deps.logError({ err, storageKey: asset.storageKey }, 'Export download failed');
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
			progressStore.start(options.year ?? null, deps.now());
			try {
				return await doExport(options);
			} finally {
				progressStore.finish();
			}
		},
	};
}
