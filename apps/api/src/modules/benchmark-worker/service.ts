import { setTimeout as delay } from 'node:timers/promises';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { LabConfig } from './config.js';
import { evaluateCase } from './evaluate.js';
import { claimCase, finishCase, renewLease } from './repository.js';
import { createLabStatus } from './status.js';

const probes = new WeakMap<LabConfig, ReturnType<typeof createLabStatus>>();

export async function processNextCase(
	db: PrismaClient,
	config: LabConfig,
	signal?: AbortSignal,
): Promise<boolean> {
	if (!config.enabled || signal?.aborted) return false;
	let probe = probes.get(config);
	if (!probe) {
		probe = createLabStatus(config);
		probes.set(config, probe);
	}
	// An unavailable tunnel must leave queued work available for recovery.
	if (config.provider === 'transformers-generate' && (await probe()).modelStatus !== 'available') return false;
	const claim = await claimCase(db, config.concurrency);
	if (!claim) return false;
	if (claim === 'reaped') return true;

	const controller = new AbortController();
	const deadline = AbortSignal.timeout(300_000);
	const workSignal = AbortSignal.any([controller.signal, deadline, ...(signal ? [signal] : [])]);
	// Heartbeats also observe cancellation while model requests are in flight.
	const heartbeat = (async () => {
		try {
			while (!workSignal.aborted) {
				await delay(1000, undefined, { signal: workSignal });
				if (!(await renewLease(db, claim))) break;
			}
		} catch {
			/* A lost DB connection invalidates the right to continue. */
		}
		controller.abort();
	})();
	try {
		const { toolSupport } = await probe();
		const outcome = await evaluateCase(config, claim.item, workSignal, toolSupport);
		if (config.provider === 'transformers-generate' && outcome.retryable) probes.delete(config);
		if (signal?.aborted) {
			// Leave the interrupted case recoverable even on graceful shutdown.
			outcome.output = null;
			outcome.error = 'WORKER_STOPPING';
			outcome.retryable = true;
		} else if (deadline.aborted) {
			outcome.output = null;
			outcome.error = 'CASE_TIMEOUT';
			outcome.retryable = false;
		} else if (controller.signal.aborted) {
			return true; // Lost lease; the next holder owns recovery.
		}
		await finishCase(db, claim, outcome);
		return true;
	} finally {
		controller.abort();
		await heartbeat;
	}
}
