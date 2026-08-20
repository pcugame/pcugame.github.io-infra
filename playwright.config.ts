import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: './e2e',
	fullyParallel: false,
	timeout: 45_000,
	use: {
		baseURL: 'http://127.0.0.1:4173',
		trace: 'retain-on-failure',
	},
	projects: [{
		name: 'chromium',
		use: {
			...devices['Desktop Chrome'],
			launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
				? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
				: undefined,
		},
	}],
	webServer: {
		command: 'npm exec -w apps/web -- vite --host 127.0.0.1 --port 4173',
		url: 'http://127.0.0.1:4173/e2e/',
		reuseExistingServer: !process.env.CI,
		timeout: 30_000,
	},
});
