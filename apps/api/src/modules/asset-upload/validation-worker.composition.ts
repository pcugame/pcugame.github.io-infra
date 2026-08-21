import type { ObjectStorage } from '../../application/ports.js';
import { createGameUploadValidationWorker } from './validation-worker.service.js';
import { createGameUploadValidationLoop } from './validation-worker.loop.js';
import type { AssetUploadRepository } from './ports.js';

/**
 * Separate process composition contract. Do not import this module from the
 * HTTP control graph: it grants a protected Garage object-body read capability.
 */
export function createAssetUploadValidationGraph(deps: {
	repository: AssetUploadRepository;
	storage: Pick<ObjectStorage, 'stream'>;
	ids: { next(): string };
	tempRoot: string;
	tempDiskBudgetBytes: number;
	logger: { error(context: Record<string, unknown>, message: string): void };
	wakeDeletionWorker(): void;
}) {
	const worker = createGameUploadValidationWorker({
		...deps,
		storage: {
			async stream(bucket, key, request) {
				const object = await deps.storage.stream(bucket, key, undefined, request);
				if (!object || 'kind' in object) throw new Error('Completed direct upload object is unavailable');
				return { body: object.body, size: object.size };
			},
		},
	});
	return { worker, loop: createGameUploadValidationLoop(worker) };
}
