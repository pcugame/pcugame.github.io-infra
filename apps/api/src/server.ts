import { loadEnv } from './config/env.js';

// Load env first
const config = loadEnv();

import { buildApp } from './app.js';
import { createProductionBackendContext } from './backend-context.js';

async function main(): Promise<void> {
	const context = createProductionBackendContext(config);
	const app = await buildApp({ context });

	// Boot-time recovery: inspect sessions left mid-COMPLETING by a prior crash,
	// finalize objects that reached storage, and fail/clean incomplete attempts.
	// Done before listen() so health isn't OK until recovery has been attempted.
	try {
		await context.maintenance.recoverStaleUploads();
	} catch (err) {
		context.logger.error(err, 'Boot sweep for stale COMPLETING sessions failed — continuing');
	}

	try {
		await app.listen({ port: config.PORT, host: '0.0.0.0' });
		context.logger.info(`Server listening on http://0.0.0.0:${config.PORT}`);
	} catch (err) {
		context.logger.fatal(err, 'Failed to start server');
		process.exit(1);
	}

	context.lifecycle.setState('ready');

	// Purge expired sessions every hour
	const SESSION_PURGE_INTERVAL = 60 * 60 * 1000;
	const purgeTask = context.scheduler.every(SESSION_PURGE_INTERVAL, async () => {
		try {
			const count = await context.maintenance.purgeExpiredSessions(context.clock.now());
			if (count > 0) context.logger.info({ count }, 'Purged expired sessions');
		} catch (err) {
			context.logger.error(err, 'Failed to purge expired sessions');
		}
	});

	// Retry S3 deletes that were queued as orphans. Interval is short enough to
	// keep the pending queue small but respects each row's per-row cooldown.
	const ORPHAN_REAP_INTERVAL = 10 * 60 * 1000;
	const orphanTask = context.scheduler.every(ORPHAN_REAP_INTERVAL, async () => {
		try {
			await context.maintenance.reapOrphans();
		} catch (err) {
			context.logger.error(err, 'Orphan reaper iteration crashed');
		}
	});

	let shuttingDown = false;
	const shutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		context.logger.info(`Received ${signal}, entering drain phase`);

		// Step 1: flip state → draining. /api/health immediately returns 503 so the LB stops
		// routing new traffic, and createSession starts rejecting new upload sessions.
		context.lifecycle.setState('draining');
		purgeTask.cancel();
		orphanTask.cancel();

		// Step 2: wait for in-flight requests to finish (bounded by SHUTDOWN_DRAIN_MS).
		const drainResult = await context.lifecycle.waitForDrain(config.SHUTDOWN_DRAIN_MS);
		context.logger.info({ drainResult, inFlight: context.lifecycle.inFlight() }, 'Drain phase complete');

		// Step 3: close Fastify + Prisma. If drain timed out, exit(1) so the orchestrator
		// knows the shutdown wasn't clean — useful for alerting / deploy retries.
		context.lifecycle.setState('shutting_down');
		try {
			await app.close();
			await context.databaseHealth.close();
		} catch (err) {
			context.logger.fatal(err, 'Error during shutdown close');
			process.exit(1);
		}
		process.exit(drainResult === 'drained' ? 0 : 1);
	};

	process.on('SIGTERM', () => void shutdown('SIGTERM'));
	process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
	console.error('Fatal startup error:', err);
	process.exit(1);
});
