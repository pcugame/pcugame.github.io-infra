import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../application/ports.js';
import { currentContext, requestContext } from '../lib/request-context.js';

function fakeLogger(): AppLogger {
	return {
		child: vi.fn(),
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
	};
}

describe('request context logger', () => {
	it('returns a child logger bound to reqId when inside a context', async () => {
		const child = fakeLogger();

		requestContext.run({ reqId: 'fixed-id', log: child }, () => {
			expect(currentContext()?.log).toBe(child);
			expect(currentContext()?.reqId).toBe('fixed-id');
		});
	});

	it('has no ambient logger outside a request context', () => {
		expect(currentContext()).toBeUndefined();
	});

	it('propagates the context across awaited calls', async () => {
		const child = fakeLogger();

		const innerLogger = await requestContext.run({ reqId: 'async-id', log: child }, async () => {
			await new Promise((r) => setTimeout(r, 1));
			return currentContext()?.log;
		});

		expect(innerLogger).toBe(child);
	});
});
