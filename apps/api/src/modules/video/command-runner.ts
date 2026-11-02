import { createBoundedCommandRunner as createProcessRunner, CommandInfrastructureError, CommandLimitError } from '../process/command-runner.js';
import { VideoInfrastructureError, VideoRejectedError } from './errors.js';
import type { BoundedCommandRunner } from './ports.js';

/** Video policy maps resource failures; the process runner has no media policy. */
export function createBoundedCommandRunner(
	...args: Parameters<typeof createProcessRunner>
): BoundedCommandRunner {
	const runner = createProcessRunner(...args);
	return {
		async run(input) {
			try {
				return await runner.run(input);
			} catch (error) {
				if (input.signal?.aborted) throw input.signal.reason ?? error;
				if (error instanceof CommandLimitError)
					throw new VideoRejectedError(error.message, error.code, { cause: error });
				if (error instanceof CommandInfrastructureError)
					throw new VideoInfrastructureError(error.message, { cause: error });
				throw error;
			}
		},
	};
}
