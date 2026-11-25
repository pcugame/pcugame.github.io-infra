import 'dotenv/config';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createPrismaClientForDatabase } from './lib/prisma-client.js';
import { readLabConfig } from './modules/benchmark-worker/config.js';
import { processNextBertScores } from './modules/benchmark-worker/bertscore.js';
import { processNextCase } from './modules/benchmark-worker/service.js';

export async function runBenchmarkWorker() {
	const config = readLabConfig();
	if (!config.enabled) return;
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl || !config.model || !config.modelUrl)
		throw new Error('Incomplete benchmark worker configuration');
	const db = createPrismaClientForDatabase(databaseUrl);
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once('SIGTERM', stop);
	process.once('SIGINT', stop);
	async function poll(processNext = processNextCase) {
		while (!controller.signal.aborted) {
			let processed = false;
			try {
				processed = await processNext(db, config, controller.signal);
			} catch {
				console.error('Benchmark worker could not update the work queue');
			}
			if (!processed) await delay(1500, undefined, { signal: controller.signal }).catch(() => undefined);
		}
	}
	try {
		await Promise.all([...Array.from({ length: config.concurrency }, () => poll()), poll(processNextBertScores)]);
	} finally {
		process.off('SIGTERM', stop);
		process.off('SIGINT', stop);
		await db.$disconnect();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	void runBenchmarkWorker().catch(() => {
		console.error('Benchmark worker startup failed');
		process.exitCode = 1;
	});
}
