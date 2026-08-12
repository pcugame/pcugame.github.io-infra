import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['scripts/**/*.test.ts'],
		exclude: ['dist/**', 'node_modules/**'],
		testTimeout: 30_000,
	},
});
