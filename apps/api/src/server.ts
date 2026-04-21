import { loadEnv } from './config/env.js';

// Load env first
const config = loadEnv();

import { buildApp } from './app.js';
import { logger } from './lib/logger.js';
import { disconnectPrisma, prisma } from './lib/prisma.js';
import {
	getInFlight,
	setLifecycleState,
	waitForDrain,
} from './lib/lifecycle.js';
import { runOrphanReaper } from './modules/orphan/service.js';
import { sweepStaleCompletingSessions } from './modules/admin/game-upload/service.js';

async function main(): Promise<void> {
	const app = await buildApp();

	// Boot-time recovery: sessions left mid-COMPLETING by a prior crash get reverted
	// so users can retry. Done before listen() so health isn't OK until the DB is tidy.
	try {
		await sweepStaleCompletingSessions();
	} catch (err) {
		logger().error(err, 'Boot sweep for stale COMPLETING sessions failed — continuing');
	}

	try {
		await app.listen({ port: config.PORT, host: '0.0.0.0' });
		logger().info(`Server listening on http://0.0.0.0:${config.PORT}`);
	} catch (err) {
		logger().fatal(err, 'Failed to start server');
		process.exit(1);
	}

	setLifecycleState('ready');

	// Purge expired sessions every hour
	const SESSION_PURGE_INTERVAL = 60 * 60 * 1000;
	const purgeTimer = setInterval(async () => {
		try {
			const { count } = await prisma.authSession.deleteMany({
				where: { expiresAt: { lt: new Date() } },
			});
			if (count > 0) logger().info({ count }, 'Purged expired sessions');
		} catch (err) {
			logger().error(err, 'Failed to purge expired sessions');
		}
	}, SESSION_PURGE_INTERVAL);

	// Retry S3 deletes that were queued as orphans. Interval is short enough to
	// keep the pending queue small but respects each row's per-row cooldown.
	const ORPHAN_REAP_INTERVAL = 10 * 60 * 1000;
	const orphanTimer = setInterval(async () => {
		try {
			await runOrphanReaper();
		} catch (err) {
			logger().error(err, 'Orphan reaper iteration crashed');
		}
	}, ORPHAN_REAP_INTERVAL);

	let shuttingDown = false;
	const shutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger().info(`Received ${signal}, entering drain phase`);

		// Step 1: flip state → draining. /api/health immediately returns 503 so the LB stops
		// routing new traffic, and createSession starts rejecting new upload sessions.
		setLifecycleState('draining');
		clearInterval(purgeTimer);
		clearInterval(orphanTimer);

		// Step 2: wait for in-flight requests to finish (bounded by SHUTDOWN_DRAIN_MS).
		const drainResult = await waitForDrain(config.SHUTDOWN_DRAIN_MS);
		logger().info({ drainResult, inFlight: getInFlight() }, 'Drain phase complete');

		// Step 3: close Fastify + Prisma. If drain timed out, exit(1) so the orchestrator
		// knows the shutdown wasn't clean — useful for alerting / deploy retries.
		setLifecycleState('shutting_down');
		try {
			await app.close();
			await disconnectPrisma();
		} catch (err) {
			logger().fatal(err, 'Error during shutdown close');
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
