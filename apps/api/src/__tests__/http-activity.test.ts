import Fastify, { type FastifyReply, type FastifyRequest, type FastifyInstance, type HookHandlerDoneFunction, type preHandlerHookHandler } from 'fastify';
import { expect, it, vi } from 'vitest';
import { trackHttpActivity, httpActivity } from '../runtime/http-activity.js';
import { registerCors } from '../plugins/cors.js';
import { defaultTestEnv } from './helpers/app-mocks.js';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

it('drains after the actual application CORS registration handles OPTIONS without done', async () => {
	const app = Fastify();
	trackHttpActivity(app);
	await registerCors(app, { ...defaultTestEnv, LOG_LEVEL: 'error', GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS], CORS_ALLOWED_ORIGINS: [...defaultTestEnv.CORS_ALLOWED_ORIGINS] });
	app.get('/resource', async () => ({ ok: true }));
	try {
		const response = await app.inject({ method: 'OPTIONS', url: '/resource', headers: {
			origin: 'http://localhost:5173', 'access-control-request-method': 'GET',
		} });
		expect(response.statusCode).toBe(204);
		expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
		httpActivity(app).accepting = false;
		expect(httpActivity(app).handlers).toBe(0);
	} finally { await app.close(); }
});

for (const hook of ['onRequest', 'preHandler', 'preParsing'] as const) {
	it(`finishes ${hook} early replies without advancing the hook chain`, async () => {
		const app = Fastify(); trackHttpActivity(app);
		const handler = vi.fn(() => 'unreachable');
		if (hook === 'preParsing') app.addHook(hook, function (_req, reply, payload, _done) {
			expect(this).toBe(app); expect(payload).toBeDefined(); reply.send('early');
		});
		else app.addHook(hook, function (this: FastifyInstance, _req: FastifyRequest, reply: FastifyReply, _done: HookHandlerDoneFunction) { expect(this).toBe(app); reply.send('early'); });
		app.post('/', handler);
		try {
			expect((await app.inject({ method: 'POST', url: '/', payload: 'body', headers: { 'content-type': 'text/plain' } })).body).toBe('early');
			expect(handler).not.toHaveBeenCalled(); expect(httpActivity(app).handlers).toBe(0);
		} finally { await app.close(); }
	});
}

it('keeps a returned Promise active even if done and response finish occur first', async () => {
	const app = Fastify(); trackHttpActivity(app);
	const finish = deferred();
	const callback = function (_req: FastifyRequest, _reply: FastifyReply, done: HookHandlerDoneFunction) { done(); return finish.promise; };
	// Exercise Fastify's runtime support for a callback-shaped Promise return.
	app.addHook('preHandler', callback as preHandlerHookHandler);
	app.get('/', () => 'ok');
	try {
		expect((await app.inject('/')).body).toBe('ok');
		expect(httpActivity(app).handlers).toBe(1);
		finish.resolve(); await vi.waitFor(() => expect(httpActivity(app).handlers).toBe(0));
	} finally { finish.resolve(); await app.close(); }
});

for (const boundary of ['hook', 'handler'] as const) {
	it(`retains an async ${boundary} after sending the response until its work settles`, async () => {
		const app = Fastify(); trackHttpActivity(app); const finish = deferred();
		const work = async (_request: unknown, reply: FastifyReply) => { reply.send('early'); await finish.promise; };
		if (boundary === 'hook') { app.addHook('preHandler', work); app.get('/', () => 'unreachable'); }
		else app.get('/', work);
		try {
			expect((await app.inject('/')).body).toBe('early');
			httpActivity(app).accepting = false;
			expect(httpActivity(app).handlers).toBe(1);
			finish.resolve(); await vi.waitFor(() => expect(httpActivity(app).handlers).toBe(0));
		} finally { finish.resolve(); await app.close(); }
	});
}

it('preserves normal callbacks, payload arguments and payload return values', async () => {
	const app = Fastify(); trackHttpActivity(app);
	app.addHook('preParsing', function (_req, _reply, payload, done) { expect(this).toBe(app); done(null, payload); });
	app.addHook('preHandler', function (_req, _reply, done) { done(); });
	app.addHook('preSerialization', function (_req, _reply, payload, done) { done(null, { ...(payload as object), checked: true }); });
	app.addHook('onSend', function (_req, _reply, payload, done) { expect(typeof payload).toBe('string'); done(null, payload); });
	app.post('/', req => ({ body: req.body }));
	try {
		expect((await app.inject({ method: 'POST', url: '/', payload: { x: 1 } })).json()).toEqual({ body: { x: 1 }, checked: true });
		expect(httpActivity(app).handlers).toBe(0);
	} finally { await app.close(); }
});

for (const mode of ['throw', 'callback-error', 'reject'] as const) {
	it(`preserves ${mode} delivery to Fastify and releases the activity once`, async () => {
		const app = Fastify(); trackHttpActivity(app); const failure = new Error(mode);
		const errorHandler = vi.fn((error: unknown, _req: unknown, reply: FastifyReply) => { expect(error).toBe(failure); reply.code(500).send(mode); });
		app.setErrorHandler(errorHandler);
		app.addHook('preHandler', function (_req, _reply, done) {
			if (mode === 'throw') throw failure;
			if (mode === 'callback-error') return done(failure);
			return Promise.reject(failure);
		});
		app.get('/', () => 'unreachable');
		try {
			const response = await app.inject('/'); expect(response.statusCode).toBe(500); expect(response.body).toBe(mode);
			expect(errorHandler).toHaveBeenCalledTimes(1); expect(httpActivity(app).handlers).toBe(0);
		} finally { await app.close(); }
	});
}

for (const mode of ['reply-return', 'done-after-send', 'delayed-send'] as const) {
	it(`handles ${mode} without duplicate completion or response listener retention`, async () => {
		const app = Fastify(); trackHttpActivity(app); const entered = deferred(), release = deferred();
		let raw: FastifyReply['raw'] | undefined;
		app.addHook('preHandler', function (_req, reply, done) {
			raw = reply.raw;
			if (mode === 'delayed-send') {
				// Callback-style work intentionally returns no Promise.
				void release.promise.then(() => { reply.send('ok'); }); entered.resolve(); return;
			}
			if (mode === 'reply-return') return reply.send('ok');
			reply.send('ok'); done(); done();
		});
		app.get('/', () => 'unreachable');
		try {
			const response = app.inject('/');
			if (mode === 'delayed-send') { await entered.promise; expect(httpActivity(app).handlers).toBe(1); release.resolve(); }
			expect((await response).body).toBe('ok'); expect(httpActivity(app).handlers).toBe(0);
			for (const event of ['finish', 'close']) expect(raw!.listeners(event).some(fn => fn.name === 'responseEnded')).toBe(false);
		} finally { release.resolve(); await app.close(); }
	});
}

it('keeps callback onResponse work active until done, even though the response is already finished', async () => {
	const app = Fastify(); trackHttpActivity(app); const entered = deferred(), release = deferred();
	app.addHook('onResponse', (_req, _reply, done) => { entered.resolve(); void release.promise.then(() => done()); });
	app.get('/', () => 'ok');
	try {
		expect((await app.inject('/')).body).toBe('ok'); await entered.promise;
		expect(httpActivity(app).handlers).toBe(1);
		release.resolve(); await vi.waitFor(() => expect(httpActivity(app).handlers).toBe(0));
	} finally { release.resolve(); await app.close(); }
});

it('retains Fastify async/callback arity validation at hook registration', async () => {
	const app = Fastify(); trackHttpActivity(app);
	try {
		// @ts-expect-error Intentionally invalid async/callback signature must still fail at runtime.
		expect(() => app.addHook('preHandler', async (_req, _reply, _done) => {})).toThrow(/Async function has too many arguments/);
	} finally { await app.close(); }
});

it('retains a callback-returned rejecting Promise after an early reply without unhandled rejection', async () => {
	const app = Fastify(); trackHttpActivity(app); const finish = deferred();
	const failure = new Error('late hook failure');
	const handled = vi.fn((error: unknown, _req: unknown, reply: FastifyReply) => { expect(error).toBe(failure); reply.send(error); });
	app.setErrorHandler(handled);
	const callback = function (_req: FastifyRequest, reply: FastifyReply, _done: HookHandlerDoneFunction) {
		reply.send('early'); return finish.promise.then(() => { throw failure; });
	};
	// Exercise Fastify's runtime support for a callback-shaped Promise return.
	app.addHook('preHandler', callback as preHandlerHookHandler);
	app.get('/', () => 'unreachable');
	try {
		expect((await app.inject('/')).body).toBe('early'); expect(httpActivity(app).handlers).toBe(1);
		finish.resolve(); await vi.waitFor(() => expect(httpActivity(app).handlers).toBe(0));
		// Fastify ignores reply.send(error) after a sent response, as without the wrapper.
		expect(handled).not.toHaveBeenCalled();
	} finally { finish.resolve(); await app.close(); }
});

it('does not accumulate finish/close listeners through synchronous callback chains', async () => {
	const app = Fastify(); trackHttpActivity(app);
	for (let i = 0; i < 30; i++) app.addHook('preHandler', (_req, reply, done) => {
		expect(reply.raw.listeners('finish').filter(fn => fn.name === 'responseEnded')).toHaveLength(0);
		done();
	});
	app.get('/', () => 'ok');
	try { expect((await app.inject('/')).body).toBe('ok'); expect(httpActivity(app).handlers).toBe(0); }
	finally { await app.close(); }
});
