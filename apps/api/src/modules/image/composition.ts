import { createBoundedImageCommandRunner } from './command-runner.js';
import { createImageOperations } from './operations.js';
import { DEFAULT_IMAGE_WORKER_LIMITS, type ImageWorkerLimits } from './policy.js';
import { createImageProcessor } from './processor.js';
import type { ImageWorkerRepository, ImageWorkerStorage } from './ports.js';
import { createImageWorker } from './worker.js';
import { cleanupStaleWorkerDirectories } from '../upload-lifecycle/worker-workspace.js';

/** Worker-only composition; the future Prisma adapter is injected after owner/session schema expansion. */
export function createImageWorkerComposition(input: {
	repository: ImageWorkerRepository;
	storage: ImageWorkerStorage;
	tempRoot: string;
	protectedBucket: string;
	publicBucket: string;
	ids: { next(): string };
	clock: { now(): Date };
	logger: {
		info(value: Record<string, unknown>, message: string): void;
		warn(value: Record<string, unknown>, message: string): void;
		error(value: Record<string, unknown>, message: string): void;
	};
	limits?: Partial<ImageWorkerLimits>;
}) {
	const limits = { ...DEFAULT_IMAGE_WORKER_LIMITS, ...input.limits };
	const operations = createImageOperations(createBoundedImageCommandRunner(), limits);
	const processor = createImageProcessor({ ...input, operations, limits });
	const worker = createImageWorker({ repository: input.repository, processor, ids: input.ids, logger: input.logger });
	return {
		operations,
		processor,
		worker,
		cleanupStaleWorkspaces: (cutoff: Date) => cleanupStaleWorkerDirectories({
			tempRoot: input.tempRoot, prefix: 'pcu-image-worker-', cutoff,
		}),
	};
}
