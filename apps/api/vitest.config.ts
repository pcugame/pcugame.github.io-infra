import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		exclude: ['dist/**', 'node_modules/**'],
		// Full route suites cold-import Fastify, Prisma, Sharp, and AWS adapters in
		// parallel. Five seconds was flaky on loaded CI runners despite sub-2s
		// isolated runs; keep failures bounded while avoiding scheduler noise.
		testTimeout: 30_000,
		hookTimeout: 30_000,
		maxWorkers: 2,
	},
});
