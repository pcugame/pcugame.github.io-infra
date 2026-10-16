import type { FastifyInstance, FastifyReply } from 'fastify';

type Callable = (this: unknown, ...args: unknown[]) => unknown;
const trackedHooks = new Set(['onRequest', 'preParsing', 'preValidation', 'preHandler', 'preSerialization', 'onSend', 'onError', 'onResponse', 'onTimeout', 'onRequestAbort']);
const earlyReplyHooks = new Set(['onRequest', 'preParsing', 'preValidation', 'preHandler', 'preSerialization', 'onSend']);
const activity = new WeakMap<FastifyInstance, { handlers: number; accepting: boolean }>();
function promiseLike(value: unknown): value is PromiseLike<unknown> {
	return value !== null && (typeof value === 'object' || typeof value === 'function')
		&& 'then' in value && typeof value.then === 'function';
}
/** Count actual hook/handler execution, including after response close or abort. */
export function trackHttpActivity(app: FastifyInstance) {
	const state = { handlers: 0, accepting: true };
	activity.set(app, state);
	const wrapped = new WeakSet<Callable>();
	function wrap(original: Callable, callback: boolean, earlyReply = false): Callable {
		if (wrapped.has(original)) return original;
		const tracked: Callable = function (...args) {
			state.handlers++;
			let completed = false;
			let returned = false;
			let pendingPromise = false;
			let callbackDone = false;
			const reply = earlyReply ? args[1] as FastifyReply : undefined;
			const detach = () => {
				reply?.raw.removeListener('finish', responseEnded);
				reply?.raw.removeListener('close', responseEnded);
			};
			const finish = () => {
				if (!completed) { completed = true; detach(); state.handlers--; }
			};
			const finishCallback = () => {
				if (returned && !pendingPromise && (callbackDone || reply?.sent)) finish();
			};
			function responseEnded() {
				// Close alone is not completion of callback work. A sent reply is
				// the callback early-return contract; returned Promises take priority.
				detach();
				finishCallback();
			}
			if (callback) {
				const done = args.at(-1);
				if (typeof done === 'function') args[args.length - 1] = function (this: unknown, ...values: unknown[]) {
					try { return done.apply(this, values); } finally { callbackDone = true; finishCallback(); }
				};
			}
			try {
				const result = original.apply(this, args);
				// FastifyReply is a response thenable, not a work-completion Promise.
				pendingPromise = result !== args[1] && promiseLike(result);
				returned = true;
				if (pendingPromise) {
					detach();
					// Observe both outcomes without replacing Fastify's return value or
					// introducing a rejecting finally-chain that nobody consumes.
					(result as PromiseLike<unknown>).then(finish, finish);
				} else if (!callback) finish();
				else {
					finishCallback();
					if (!completed && reply && !reply.raw.destroyed) {
						reply.raw.once('finish', responseEnded);
						reply.raw.once('close', responseEnded);
					}
				}
				return result;
			} catch (error) { finish(); throw error; }
		};
		Object.defineProperty(tracked, 'length', { value: original.length });
		Object.defineProperty(tracked, 'constructor', { value: original.constructor });
		wrapped.add(tracked);
		return tracked;
	}
	const addHook = app.addHook;
	app.addHook = function (this: FastifyInstance, name: string, hook: Callable) {
		return (addHook as unknown as Callable).call(this, name, trackedHooks.has(name) ? wrap(hook, true, earlyReplyHooks.has(name)) : hook);
	} as FastifyInstance['addHook'];
	app.addHook('onRequest', async (_request, reply) => {
		if (!state.accepting) return reply.code(503).send({ error: 'DRAINING' });
	});
	app.addHook('onRoute', route => {
		route.handler = wrap(route.handler as Callable, false);
		const hooks = route as unknown as Record<string, unknown>;
		for (const name of trackedHooks) {
			const hook = hooks[name];
			if (typeof hook === 'function') hooks[name] = wrap(hook as Callable, true, earlyReplyHooks.has(name));
			else if (Array.isArray(hook)) hooks[name] = hook.map(value => wrap(value as Callable, true, earlyReplyHooks.has(name)));
		}
	});
}
export function httpActivity(app: FastifyInstance) {
	const state = activity.get(app);
	if (!state) throw new Error('HTTP activity tracking is not installed');
	return state;
}
