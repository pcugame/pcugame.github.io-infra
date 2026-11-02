import { createUnrealInspector } from '../build-package/unreal.js';
import { createBoundedCommandRunner } from '../process/command-runner.js';
import type { BuildReviewWorkerPort } from '../build-review/ports.js';
import type { ObjectStorage } from '../../application/ports.js';
import { createGameUploadValidationWorker } from './validation-worker.service.js';
import { createGameUploadValidationLoop } from './validation-worker.loop.js';
import type { AssetUploadRepository } from './ports.js';
import { WorkerSourceObjectMissingError } from '../upload-lifecycle/worker-errors.js';
import { cleanupStaleGameWorkspaces } from '../admin/game-upload/validation-worker.game-processor.js';

/**
 * Separate process composition contract. Do not import this module from the
 * HTTP control graph: it grants a protected Garage object-body read capability.
 */
export function createAssetUploadValidationGraph(deps: {
	reviews?: BuildReviewWorkerPort;
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
		unrealInspector: createUnrealInspector(createBoundedCommandRunner()),
		storage: {
			async stream(bucket, key, request) {
				const object = await deps.storage.stream(bucket, key, undefined, request);
				if (!object || 'kind' in object) {
					throw new WorkerSourceObjectMissingError('Completed direct GAME source object does not exist');
				}
				return { body: object.body, size: object.size };
			},
		},
	});
	return {
		worker,
		loop: createGameUploadValidationLoop(worker),
		cleanupStaleWorkspaces: (cutoff: Date) => cleanupStaleGameWorkspaces(deps.tempRoot, cutoff),
	};
}
