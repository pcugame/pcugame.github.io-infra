import type { FastifyInstance, FastifyReply } from 'fastify';

type Callable = (this: unknown, ...args: unknown[]) => unknown;
const trackedHooks = new Set(['onRequest', 'preParsing', 'preValidation', 'preHandler', 'preSerialization', 'onSend', 'onError', 'onResponse', 'onTimeout', 'onRequestAbort']);
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
	function wrap(original: Callable, callback: boolean): Callable {
		if (wrapped.has(original)) return original;
		const tracked: Callable = function (...args) {
			state.handlers++;
			let completed = false, returned = false, pendingPromise = false, calledDone = false;
			const response = callback ? (args[1] as FastifyReply | undefined)?.raw : undefined;
			// onResponse callbacks start after finish and must still call done.
			const responseWasFinished = response?.writableFinished;
			const finish = () => {
				if (completed) return;
				completed = true;
				response?.removeListener('finish', finish);
				state.handlers--;
			};
			if (callback) {
				const done = args.at(-1);
				if (typeof done === 'function') args[args.length - 1] = (...values: unknown[]) => {
					calledDone = true;
					try { return done(...values); } finally {
						if (returned && !pendingPromise) finish();
					}
				};
			}
			try {
				const result = original.apply(this, args);
				pendingPromise = promiseLike(result);
				returned = true;
				// Even a synchronous done/send cannot finish a returned Promise's work.
				if (pendingPromise) return Promise.resolve(result).finally(finish);
				if (!callback || calledDone) finish();
				else if (response && !responseWasFinished) {
					// Callback hooks may send an early response without calling done.
					// A socket close/abort alone is not execution completion.
					if (response.writableFinished) finish();
					else response.once('finish', finish);
				}
				return result;
			} catch (error) { finish(); throw error; }
		};
		Object.defineProperty(tracked, 'length', { value: original.length });
		wrapped.add(tracked);
		return tracked;
	}
	const addHook = app.addHook;
	app.addHook = function (this: FastifyInstance, name: string, hook: Callable) {
		return (addHook as unknown as Callable).call(this, name, trackedHooks.has(name) ? wrap(hook, true) : hook);
	} as FastifyInstance['addHook'];
	app.addHook('onRequest', async (_request, reply) => {
		if (!state.accepting) return reply.code(503).send({ error: 'DRAINING' });
	});
	app.addHook('onRoute', route => {
		route.handler = wrap(route.handler as Callable, false);
		const hooks = route as unknown as Record<string, unknown>;
		for (const name of trackedHooks) {
			const hook = hooks[name];
			if (typeof hook === 'function') hooks[name] = wrap(hook as Callable, true);
			else if (Array.isArray(hook)) hooks[name] = hook.map(value => wrap(value as Callable, true));
		}
	});
}
export function httpActivity(app: FastifyInstance) {
	const state = activity.get(app);
	if (!state) throw new Error('HTTP activity tracking is not installed');
	return state;
}
