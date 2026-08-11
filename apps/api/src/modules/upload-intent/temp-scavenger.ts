import type { FileSystem } from '../../application/ports.js';

const DEFAULT_GRACE_MS = 60 * 60 * 1000;
const SAFE_UPLOAD_TEMP_NAME = /^(?:pcu-project-upload-|project-asset-|exhibition-poster-)[0-9a-f-]+(?:\.webp|\.playback\.mp4)?$/i;

/**
 * Remove only application-owned upload residue. Unknown age, directory entries,
 * symlinks, and names outside the closed prefix grammar fail closed.
 */
export function createUploadTempScavenger(deps: {
	fileSystem: Pick<FileSystem, 'temporaryDirectory' | 'remove' | 'listFiles'>;
	clock: { now(): Date };
	logger: {
		info(context: Record<string, unknown>, message: string): void;
		error(context: Record<string, unknown>, message: string): void;
	};
	graceMs?: number;
}) {
	return {
		async sweep(signal?: AbortSignal): Promise<{ scanned: number; removed: number; failed: number }> {
			if (signal?.aborted) return { scanned: 0, removed: 0, failed: 0 };
			if (!deps.fileSystem.listFiles) return { scanned: 0, removed: 0, failed: 0 };
			const startedAt = deps.clock.now();
			const fence = startedAt.getTime() - (deps.graceMs ?? DEFAULT_GRACE_MS);
			const files = await deps.fileSystem.listFiles(deps.fileSystem.temporaryDirectory());
			let removed = 0;
			let failed = 0;
			for (const file of files) {
				if (signal?.aborted) break;
				if (!SAFE_UPLOAD_TEMP_NAME.test(file.name)
					|| !file.lastModified
					|| file.lastModified.getTime() > fence
					|| file.lastModified > startedAt) continue;
				try {
					await deps.fileSystem.remove(file.path);
					removed++;
				} catch (error) {
					failed++;
					deps.logger.error(
						{ error, temporaryPath: file.path },
						'Upload temp scavenger failed to remove residue',
					);
				}
			}
			deps.logger.info(
				{ scanned: files.length, removed, failed },
				'Upload temp scavenger sweep complete',
			);
			return { scanned: files.length, removed, failed };
		},
	};
}
