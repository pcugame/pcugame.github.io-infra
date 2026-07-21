import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface ExportFileWriterDependencies {
	ids: { next(): string };
	getObject(bucket: string, key: string, signal?: AbortSignal): Promise<Readable>;
	createWriteStream(path: string): Writable;
	rename(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
	logCleanupError(error: unknown, path: string): void;
}

/** Write to a unique sibling temp file and publish with an atomic rename. */
export function createExportFileWriter(deps: ExportFileWriterDependencies) {
	return {
		async saveObject(
			bucket: string,
			key: string,
			destination: string,
			signal?: AbortSignal,
		): Promise<void> {
			const temporaryPath = `${destination}.${deps.ids.next()}.tmp`;
			try {
				const body = await deps.getObject(bucket, key, signal);
				await pipeline(body, deps.createWriteStream(temporaryPath), { signal });
				await deps.rename(temporaryPath, destination);
			} catch (error) {
				await deps.remove(temporaryPath).catch((cleanupError) => {
					deps.logCleanupError(cleanupError, temporaryPath);
				});
				throw error;
			}
		},
	};
}
