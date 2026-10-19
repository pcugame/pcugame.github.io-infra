import Fastify from 'fastify';
import { get } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { registerCors } from '../plugins/cors.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { createWorkGate } from '../runtime/work-gate.js';
import { listenControl, sendControl } from '../infrastructure/runtime-control.js';
import { httpActivity, trackHttpActivity } from '../runtime/http-activity.js';
import { createClaimHeartbeatGuard } from '../modules/upload-lifecycle/claim-heartbeat.js';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

describe('deployment control', () => {
	it('stops admission without cancelling a claimed job or its heartbeat', async () => {
		const gate = createWorkGate();
		const finish = deferred();
		const renew = vi.fn().mockResolvedValue({ count: 1 });
		let signal: AbortSignal | undefined;
		const job = gate.run(async () => {
			const guard = createClaimHeartbeatGuard({ heartbeatMs: 5, lostMessage: 'lost', renew, logHeartbeatFailure: vi.fn() });
			signal = guard.signal;
			try { await finish.promise; } finally { await guard.stop(); }
			return 1;
		}, 0);
		gate.quiesce();
		const later = vi.fn(async () => 2);
		expect(await gate.run(later, 0)).toBe(0);
		expect(later).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(renew.mock.calls.length).toBeGreaterThan(1));
		expect(signal?.aborted).toBe(false);
		expect(gate.status()).toEqual({ paused: true, active: 1 });
		finish.resolve();
		expect(await job).toBe(1);
		expect(gate.status()).toEqual({ paused: true, active: 0 });
		gate.resume();
		expect(await gate.run(later, 0)).toBe(2);
	});

	it('does not report completion before an in-flight heartbeat settles', async () => {
		const renewal = deferred();
		const guard = createClaimHeartbeatGuard({ heartbeatMs: 60_000, lostMessage: 'lost',
			renew: async () => { await renewal.promise; return { count: 1 }; }, logHeartbeatFailure: vi.fn() });
		const pulse = guard.assertOwned();
		let stopped = false;
		const stop = guard.stop().then(() => { stopped = true; });
		await Promise.resolve();
		expect(stopped).toBe(false);
		renewal.resolve();
		await Promise.all([pulse, stop]);
		expect(stopped).toBe(true);
	});

	it('serves status and reversible admission only over a private Unix socket', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'pcu-control-'));
		const path = join(dir, 'runtime.sock');
		const gate = createWorkGate();
		const close = await listenControl(command => {
			if (command === 'quiesce') gate.quiesce();
			if (command === 'resume') gate.resume();
			return gate.status();
		}, path);
		try {
			expect((await stat(path)).mode & 0o777).toBe(0o600);
			expect(await sendControl('quiesce', 'all', path)).toEqual({ paused: true, active: 0 });
			expect(await sendControl('resume', 'all', path)).toEqual({ paused: false, active: 0 });
		} finally { await close(); await rm(dir, { recursive: true }); }
	});
});

for (const boundary of ['handler', 'preHandler', 'plugin-hook'] as const) {
	it(`tracks a disconnected client until its ${boundary} settles`, async () => {
		const app = Fastify();
		trackHttpActivity(app);
		const entered = deferred();
		const finish = deferred();
		const work = async () => { entered.resolve(); await finish.promise; };
		if (boundary === 'plugin-hook') {
			await app.register(async child => {
				child.addHook('preHandler', work);
				child.get('/long', async () => ({ ok: true }));
			});
		} else {
			app.get('/long', { preHandler: boundary === 'preHandler' ? work : undefined }, async () => {
				if (boundary === 'handler') await work();
				return { ok: true };
			});
		}
		const origin = await app.listen({ host: '127.0.0.1', port: 0 });
		const request = get(origin + '/long');
		request.on('error', () => undefined);
		await entered.promise;
		request.destroy();
		try {
			await new Promise(resolve => setTimeout(resolve, 20));
			expect(httpActivity(app).handlers).toBeGreaterThan(0);
			httpActivity(app).accepting = false;
			expect((await app.inject('/long')).statusCode).toBe(503);
			finish.resolve();
			await vi.waitFor(() => expect(httpActivity(app).handlers).toBe(0));
		} finally { finish.resolve(); await app.close(); }
	});
}

it('keeps response hooks active after the response reaches the client', async () => {
	const app = Fastify();
	trackHttpActivity(app);
	const entered = deferred();
	const finish = deferred();
	app.addHook('onResponse', async () => { entered.resolve(); await finish.promise; });
	app.get('/done', async () => ({ ok: true }));
	const origin = await app.listen({ host: '127.0.0.1', port: 0 });
	try {
		const response = await fetch(origin + '/done');
		expect(await response.json()).toEqual({ ok: true });
		await entered.promise;
		expect(httpActivity(app).handlers).toBe(1);
		finish.resolve();
		await vi.waitFor(() => expect(httpActivity(app).handlers).toBe(0));
	} finally { finish.resolve(); await app.close(); }
});

// Use the application's registration function and the installed @fastify/cors.
it('drains HTTP activity after a valid CORS preflight short-circuits without done', async () => {
	const app = Fastify();
	trackHttpActivity(app);
	await registerCors(app, { ...defaultTestEnv, LOG_LEVEL: 'error',
		GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS],
		CORS_ALLOWED_ORIGINS: [...defaultTestEnv.CORS_ALLOWED_ORIGINS] });
	app.get('/resource', async () => ({ ok: true }));
	const origin = await app.listen({ host: '127.0.0.1', port: 0 });
	try {
		const response = await fetch(origin + '/resource', { method: 'OPTIONS', headers: {
			Origin: defaultTestEnv.CORS_ALLOWED_ORIGINS[0],
			'Access-Control-Request-Method': 'GET',
			'Access-Control-Request-Headers': 'Authorization',
		} });
		expect(response.status).toBe(204);
		expect(response.headers.get('access-control-allow-origin')).toBe(defaultTestEnv.CORS_ALLOWED_ORIGINS[0]);
		await response.arrayBuffer();
		httpActivity(app).accepting = false;
		await vi.waitFor(() => expect(httpActivity(app).handlers).toBe(0));
	} finally { await app.close(); }
});

for (const outcome of ['done', 'early-send', 'late-done', 'done-error', 'throw'] as const) {
	it(`releases callback ${outcome} exactly once while another handler remains active`, async () => {
		const app = Fastify();
		trackHttpActivity(app);
		const entered = deferred(), finish = deferred();
		let lateDone: (() => void) | undefined;
		app.get('/blocked', async () => { entered.resolve(); await finish.promise; return 'finished'; });
		app.get('/callback', { preHandler: (_request, reply, done) => {
			if (outcome === 'throw') throw new Error('hook failed');
			if (outcome === 'done-error') { done(new Error('hook failed')); return; }
			if (outcome === 'done') { done(); return; }
			if (outcome === 'late-done') lateDone = done;
			reply.send('early');
		} }, async () => 'normal');
		const origin = await app.listen({ host: '127.0.0.1', port: 0 });
		const blocked = fetch(origin + '/blocked');
		try {
			await entered.promise;
			const response = await fetch(origin + '/callback');
			expect(response.status).toBe(outcome === 'throw' || outcome === 'done-error' ? 500 : 200);
			await response.text();
			await vi.waitFor(() => expect(httpActivity(app).handlers).toBe(1));
			lateDone?.();
			await new Promise(resolve => setImmediate(resolve));
			expect(httpActivity(app).handlers).toBe(1);
			finish.resolve(); await (await blocked).text();
			await vi.waitFor(() => expect(httpActivity(app).handlers).toBe(0));
		} finally { finish.resolve(); await blocked; await app.close(); }
	});
}

for (const boundary of ['preHandler', 'handler'] as const) {
	for (const rejects of [false, true]) {
		it(`waits for ${boundary} Promise ${rejects ? 'rejection' : 'fulfilment'} after an early response`, async () => {
			const app = Fastify();
			trackHttpActivity(app);
			const finish = deferred();
			const work = async (_request: unknown, reply: import('fastify').FastifyReply) => {
				reply.send('early');
				await finish.promise;
				if (rejects) throw new Error('late failure');
			};
			app.get('/early', { preHandler: boundary === 'preHandler' ? work : undefined },
				boundary === 'handler' ? work : async () => 'unexpected');
			const origin = await app.listen({ host: '127.0.0.1', port: 0 });
			try {
				const response = await fetch(origin + '/early');
				expect(await response.text()).toBe('early');
				expect(httpActivity(app).handlers).toBe(1);
				finish.resolve();
				await vi.waitFor(() => expect(httpActivity(app).handlers).toBe(0));
			} finally { finish.resolve(); await app.close(); }
		});
	}
}

it('keeps a callback hook active after disconnect until done', async () => {
	const app = Fastify();
	trackHttpActivity(app);
	const entered = deferred(), closed = deferred();
	let done!: () => void;
	app.get('/callback', { preHandler: (_request, reply, next) => {
		done = next; reply.raw.once('close', closed.resolve); entered.resolve();
	} }, async () => 'finished');
	const origin = await app.listen({ host: '127.0.0.1', port: 0 });
	const request = get(origin + '/callback');
	request.on('error', () => undefined);
	try {
		await entered.promise; request.destroy(); await closed.promise;
		expect(httpActivity(app).handlers).toBe(1);
		done();
		await vi.waitFor(() => expect(httpActivity(app).handlers).toBe(0));
	} finally { request.destroy(); await app.close(); }
});

it('waits for an onResponse callback even though the response already finished', async () => {
	const app = Fastify();
	trackHttpActivity(app);
	let done!: () => void;
	app.addHook('onResponse', (_request, _reply, next) => { done = next; });
	app.get('/', async () => 'finished');
	const origin = await app.listen({ host: '127.0.0.1', port: 0 });
	try {
		await (await fetch(origin)).text();
		expect(httpActivity(app).handlers).toBe(1);
		done();
		expect(httpActivity(app).handlers).toBe(0);
	} finally { await app.close(); }
});

it('defers a synchronous done/response signal to a returned Promise', async () => {
	const app = Fastify();
	trackHttpActivity(app);
	const finish = deferred();
	app.get('/', { preHandler: (_request, reply, done) => {
		reply.send('early'); done();
		return finish.promise;
	} }, async () => 'unexpected');
	const origin = await app.listen({ host: '127.0.0.1', port: 0 });
	try {
		expect(await (await fetch(origin)).text()).toBe('early');
		expect(httpActivity(app).handlers).toBe(1);
		finish.resolve();
		await vi.waitFor(() => expect(httpActivity(app).handlers).toBe(0));
	} finally { finish.resolve(); await app.close(); }
});
