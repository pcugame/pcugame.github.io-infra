import Fastify from 'fastify';
import { get } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
		const closed = deferred();
		app.server.once('request', (_req, response) => { response.once('close', closed.resolve); });
		const request = get(origin + '/long');
		request.on('error', () => undefined);
		await entered.promise;
		request.destroy();
		try {
			await closed.promise;
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
