import Fastify, { type FastifyInstance } from 'fastify';
import { get } from 'node:http';
import { createLifecycle } from '../lib/lifecycle.js';
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

	it.each([15_000, 60_000])('finishes an active HTTP response and cleanup within the shared %i ms budget', async (budget) => {
		const { createServerRuntime } = await import('../server.js');
		const { context } = contextHarness([]);
		const lifecycle = createLifecycle();
		context.lifecycle = {
			...lifecycle,
			state: lifecycle.getState,
			inFlight: lifecycle.getInFlight,
		};
		const entered = deferred();
		const releaseRequest = deferred();
		const cleanupStarted = deferred();
		const releaseCleanup = deferred();
		let closePromise: Promise<void> | undefined;
		const cleanup = vi.fn(async () => {
			cleanupStarted.resolve();
			await releaseCleanup.promise;
		});
		context.close = () => closePromise ??= cleanup();
		const app = Fastify();
		app.addHook('onRequest', async () => { lifecycle.requestStarted(); });
		app.addHook('onResponse', async () => { lifecycle.requestFinished(); });
		app.addHook('onClose', () => context.close());
		app.get('/shutdown-fixture', async () => {
			entered.resolve();
			await releaseRequest.promise;
			return { completed: true };
		});
		const signals = signalHarness();
		const forceExit = vi.fn();
		const setExitCode = vi.fn();
		const runtime = createServerRuntime({
			config: { ...config, PORT: 0, SHUTDOWN_DRAIN_MS: budget },
			context, app, signals: signals.boundary, forceExit, setExitCode,
		});
		try {
			await runtime.start();
			const address = app.server.address();
			if (!address || typeof address === 'string') throw new Error('missing test listener');
			const response = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
				get(`http://127.0.0.1:${address.port}/shutdown-fixture`, { agent: false }, (reply) => {
					let body = '';
					reply.setEncoding('utf8');
					reply.on('data', (chunk: string) => { body += chunk; });
					reply.on('end', () => resolve({ status: reply.statusCode, body }));
				}).on('error', reject);
			});
			await entered.promise;
			vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
			const started = Date.now();
			signals.emit('SIGTERM');
			const shutdown = runtime.shutdown('duplicate');
			expect(lifecycle.getState()).toBe('draining');
			await vi.advanceTimersByTimeAsync(budget - 6000);
			expect(cleanup).not.toHaveBeenCalled();
			releaseRequest.resolve();
			expect(await response).toEqual({ status: 200, body: '{"completed":true}' });
			await vi.advanceTimersByTimeAsync(200);
			await cleanupStarted.promise;
			await vi.advanceTimersByTimeAsync(4000);
			expect(setExitCode).not.toHaveBeenCalled();
			releaseCleanup.resolve();
			await expect(shutdown).resolves.toBe(0);
			expect(cleanup).toHaveBeenCalledOnce();
			expect(setExitCode).toHaveBeenCalledWith(0);
			expect(forceExit).not.toHaveBeenCalled();
			expect(Date.now() - started).toBeLessThan(budget);
			expect(Date.now() - started).toBeGreaterThan(10_000);
		} finally {
			releaseRequest.resolve();
			releaseCleanup.resolve();
			vi.useRealTimers();
			await app.close();
		}
	});

	it('does not restart the total deadline after request drain consumes its share', async () => {
		const { createServerRuntime } = await import('../server.js');
		const { context } = contextHarness([]);
		context.lifecycle.waitForDrain = async () => {
			await new Promise((resolve) => setTimeout(resolve, 9000));
			return 'drained';
		};
		context.close = vi.fn(() => new Promise<void>(() => {}));
		const app = {
			close: vi.fn(() => context.close()),
		} as unknown as FastifyInstance;
		const forceExit = vi.fn();
		vi.useFakeTimers();
		try {
			const runtime = createServerRuntime({ config, context, app, forceExit });
			const result = runtime.shutdown('shared-deadline');
			await vi.advanceTimersByTimeAsync(14_999);
			expect(app.close).toHaveBeenCalledOnce();
			expect(forceExit).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			await expect(result).resolves.toBe(1);
			expect(forceExit).toHaveBeenCalledWith(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('force-closes connections and invokes the injected exit boundary at the absolute deadline', async () => {
		const { createServerRuntime } = await import('../server.js');
		const events: string[] = [];
		const { context } = contextHarness(events);
		const closeIdleConnections = vi.fn();
		const closeAllConnections = vi.fn();
		const app = {
			listen: vi.fn(async () => 'http://127.0.0.1'),
			close: vi.fn(() => new Promise<void>(() => {})),
			closeIdleConnections,
			closeAllConnections,
		} as unknown as FastifyInstance;
		const forceExit = vi.fn();
		const runtime = createServerRuntime({
			config: { ...config, SHUTDOWN_DRAIN_MS: 25 },
			context,
			app,
			signals: signalHarness().boundary,
			forceExit,
		});
		await runtime.start();

		await expect(runtime.shutdown('deadline-test')).resolves.toBe(1);
		expect(closeIdleConnections).toHaveBeenCalledOnce();
		expect(closeAllConnections).toHaveBeenCalledOnce();
		expect(forceExit).toHaveBeenCalledWith(1);
	});

	it('applies the same absolute deadline when backend resource close hangs', async () => {
		const { createServerRuntime } = await import('../server.js');
		const events: string[] = [];
		const { context } = contextHarness(events);
		context.close = vi.fn(() => new Promise<void>(() => {}));
		const closeAllConnections = vi.fn();
		const app = {
			listen: vi.fn(async () => 'http://127.0.0.1'),
			close: vi.fn(async () => {}),
			closeAllConnections,
		} as unknown as FastifyInstance;
		const forceExit = vi.fn();
		const runtime = createServerRuntime({
			config: { ...config, SHUTDOWN_DRAIN_MS: 25 },
			context,
			app,
			signals: signalHarness().boundary,
			forceExit,
		});
		await runtime.start();

		await expect(runtime.shutdown('resource-hang-test')).resolves.toBe(1);
		expect(closeAllConnections).toHaveBeenCalledOnce();
		expect(forceExit).toHaveBeenCalledWith(1);
	});

	it.each([
		['context start', 1, 0],
		['listen', 1, 1],
	] as const)(
		'converges a signal during deferred %s on the same close boundary',
		async (stage, expectedStarts, expectedListens) => {
			const { createServerRuntime } = await import('../server.js');
			const events: string[] = [];
			const gate = deferred();
			const entered = deferred();
			const startContext = async () => {
				if (stage !== 'context start') return;
				entered.resolve();
				await gate.promise;
			};
			const { context, start, closeS3, closePrisma } = contextHarness(events, {
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
