import { describe, expect, it, vi } from 'vitest';
import { defaultTestEnv } from './helpers/app-mocks.js';

// Stub env so the logger module can boot its pino singleton.
vi.mock('../config/env.js', () => ({
	env: () => ({ ...defaultTestEnv }),
	loadEnv: () => ({ ...defaultTestEnv }),
}));

describe('request context logger', () => {
	it('returns a child logger bound to reqId when inside a context', async () => {
		const { requestContext } = await import('../lib/request-context.js');
		const { logger, rootLogger } = await import('../lib/logger.js');

		const root = rootLogger();
		const child = root.child({ reqId: 'fixed-id' });

		requestContext.run({ reqId: 'fixed-id', log: child }, () => {
			const inside = logger();
			expect(inside).toBe(child);
			expect(inside).not.toBe(root);
		});
	});

	it('falls back to root logger outside a request context', async () => {
		const { logger, rootLogger } = await import('../lib/logger.js');

		// Called synchronously outside any `requestContext.run` — must be root.
		expect(logger()).toBe(rootLogger());
	});

	it('propagates the context across awaited calls', async () => {
		const { requestContext } = await import('../lib/request-context.js');
		const { logger, rootLogger } = await import('../lib/logger.js');

		const child = rootLogger().child({ reqId: 'async-id' });

		const innerLogger = await requestContext.run({ reqId: 'async-id', log: child }, async () => {
			await new Promise((r) => setTimeout(r, 1));
			return logger();
		});

		expect(innerLogger).toBe(child);
	});
});
