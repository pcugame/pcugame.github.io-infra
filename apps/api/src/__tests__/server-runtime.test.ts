import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.js';
import type { AppLogger } from '../application/ports.js';
import type { BackendContext } from '../backend-context.js';
import type { SignalBoundary } from '../server.js';
import { defaultTestEnv } from './helpers/app-mocks.js';

const config: Env = {
	...defaultTestEnv,
	LOG_LEVEL: 'info',
	GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS],
	CORS_ALLOWED_ORIGINS: [...defaultTestEnv.CORS_ALLOWED_ORIGINS],
};
const testLogger: AppLogger = {
	child: () => testLogger,
	trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
};

function signalHarness() {
	const listeners = new Map<'SIGTERM' | 'SIGINT', () => void>();
	const once = vi.fn((signal: 'SIGTERM' | 'SIGINT', listener: () => void) => {
		listeners.set(signal, listener);
	});
	const off = vi.fn((signal: 'SIGTERM' | 'SIGINT', listener: () => void) => {
		if (listeners.get(signal) === listener) listeners.delete(signal);
	});
	return {
		boundary: { once, off } as SignalBoundary,
		once,
		off,
		emit(signal: 'SIGTERM' | 'SIGINT') {
			listeners.get(signal)?.();
		},
	};
}

function contextHarness(
	events: string[],
	options: {
		recover?: () => Promise<void>;
		start?: () => Promise<void>;
	} = {},
) {
	let state: ReturnType<BackendContext['lifecycle']['state']> = 'starting';
	let closePromise: Promise<void> | undefined;
	const recover = vi.fn(options.recover ?? (async () => {}));
	const start = vi.fn(options.start ?? (async () => {}));
	const closeS3 = vi.fn(() => { events.push('s3'); });
	const closePrisma = vi.fn(() => { events.push('prisma'); });
	const close = vi.fn(() => {
		closePromise ??= Promise.resolve().then(() => {
			closeS3();
			closePrisma();
		});
		return closePromise;
	});
	const context = {
		config,
		logger: testLogger,
		maintenance: {
			recoverStaleUploads: recover,
			purgeExpiredSessions: async () => 0,
			reapOrphans: async () => {},
		},
		lifecycle: {
			state: () => state,
			setState: (next: typeof state) => { state = next; },
			isAcceptingNewWork: () => state === 'starting' || state === 'ready',
			requestStarted: () => {},
			requestFinished: () => {},
			inFlight: () => 0,
			waitForDrain: async () => 'drained' as const,
		},
		start,
		close,
	} as unknown as BackendContext;
	return { context, recover, start, close, closeS3, closePrisma };
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((next) => { resolve = next; });
	return { promise, resolve };
}

describe('server startup and shutdown ownership boundary', () => {
	it('has no timer or signal-registration side effect when server is imported', async () => {
		const once = vi.spyOn(process, 'once');
		const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
		try {
			await import('../server.js');
			expect(once).not.toHaveBeenCalled();
			expect(setIntervalSpy).not.toHaveBeenCalled();
		} finally {
			once.mockRestore();
			setIntervalSpy.mockRestore();
		}
	});

	it('registers signals once and app-close plus signal close underlying resources once', async () => {
		const { createServerRuntime } = await import('../server.js');
		const events: string[] = [];
		const { context } = contextHarness(events);
		const listen = vi.fn(async () => 'http://127.0.0.1');
		const close = vi.fn(() => context.close());
		const app = { listen, close } as unknown as FastifyInstance;
		const signals = signalHarness();
		const exitCodes: number[] = [];
		const runtime = createServerRuntime({
			config,
			context,
			app,
			signals: signals.boundary,
			setExitCode: (code) => { exitCodes.push(code); },
		});

		const starting = runtime.start();
		// No microtask/await is allowed before both startup signal listeners exist.
		expect(signals.once).toHaveBeenCalledTimes(2);
		await starting;
		await runtime.start();
		expect(listen).toHaveBeenCalledOnce();
		expect(signals.once).toHaveBeenCalledTimes(2);

		const appClosing = app.close();
		signals.emit('SIGTERM');
		await appClosing;
		await vi.waitFor(() => expect(exitCodes).toEqual([0]));
		expect(events).toEqual(['s3', 'prisma']);
		expect(signals.off).toHaveBeenCalledTimes(2);
		await context.close();
		expect(events).toEqual(['s3', 'prisma']);
	});

	it('preserves listen failure while concurrent app close shares the same cleanup', async () => {
		const { createServerRuntime } = await import('../server.js');
		const events: string[] = [];
		const { context } = contextHarness(events);
		const original = new Error('listen failed');
		let rejectListen!: (error: unknown) => void;
		let enteredListen!: () => void;
		const entered = new Promise<void>((resolve) => { enteredListen = resolve; });
		const listen = vi.fn(() => {
			enteredListen();
			return new Promise<string>((_resolve, reject) => { rejectListen = reject; });
		});
		const close = vi.fn(() => context.close());
		const app = { listen, close } as unknown as FastifyInstance;
		const signals = signalHarness();
		const runtime = createServerRuntime({ config, context, app, signals: signals.boundary });

		const starting = runtime.start();
		await entered;
		const appClosing = app.close();
		rejectListen(original);
		await appClosing;
		await expect(starting).rejects.toBe(original);
		expect(events).toEqual(['s3', 'prisma']);
		expect(signals.once).toHaveBeenCalledTimes(2);
		expect(signals.off).toHaveBeenCalledTimes(2);
	});

	it('deduplicates concurrent signal-style shutdown calls', async () => {
		const { createServerRuntime } = await import('../server.js');
		const events: string[] = [];
		const { context } = contextHarness(events);
		const app = {
			listen: vi.fn(async () => 'http://127.0.0.1'),
			close: vi.fn(() => context.close()),
		} as unknown as FastifyInstance;
		const runtime = createServerRuntime({ config, context, app, signals: signalHarness().boundary });
		await runtime.start();

		const first = runtime.shutdown('SIGTERM');
		const second = runtime.shutdown('SIGINT');
		expect(first).toBe(second);
		await expect(first).resolves.toBe(0);
		expect(app.close).toHaveBeenCalledOnce();
		expect(events).toEqual(['s3', 'prisma']);
	});

	it.each([
		['recovery', 0, 0],
		['context start', 1, 0],
		['listen', 1, 1],
	] as const)(
		'converges a signal during deferred %s on the same close boundary',
		async (stage, expectedStarts, expectedListens) => {
			const { createServerRuntime } = await import('../server.js');
			const events: string[] = [];
			const gate = deferred();
			const entered = deferred();
			const recovery = async () => {
				if (stage !== 'recovery') return;
				entered.resolve();
				await gate.promise;
			};
			const startContext = async () => {
				if (stage !== 'context start') return;
				entered.resolve();
				await gate.promise;
			};
			const { context, start, closeS3, closePrisma } = contextHarness(events, {
				recover: recovery,
				start: startContext,
			});
			const listen = vi.fn(async () => {
				if (stage === 'listen') {
					entered.resolve();
					await gate.promise;
				}
				return 'http://127.0.0.1';
			});
			const app = {
				listen,
				close: vi.fn(() => context.close()),
			} as unknown as FastifyInstance;
			const signals = signalHarness();
			const exitCodes: number[] = [];
			const runtime = createServerRuntime({
				config,
				context,
				app,
				signals: signals.boundary,
				setExitCode: (code) => { exitCodes.push(code); },
			});

			const starting = runtime.start();
			await entered.promise;
			expect(signals.once).toHaveBeenCalledTimes(2);
			signals.emit('SIGTERM');
			await vi.waitFor(() => expect(exitCodes).toEqual([0]));
			gate.resolve();
			await expect(starting).resolves.toBeUndefined();

			expect(start).toHaveBeenCalledTimes(expectedStarts);
			expect(listen).toHaveBeenCalledTimes(expectedListens);
			expect(app.close).toHaveBeenCalledOnce();
			expect(closeS3).toHaveBeenCalledOnce();
			expect(closePrisma).toHaveBeenCalledOnce();
			expect(events).toEqual(['s3', 'prisma']);
			expect(signals.off).toHaveBeenCalledTimes(2);
		},
	);
});
