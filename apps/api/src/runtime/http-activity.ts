import type { FastifyInstance } from 'fastify';

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
			let completed = false;
			const finish = () => { if (!completed) { completed = true; state.handlers--; } };
			if (callback) {
				const done = args.at(-1);
				if (typeof done === 'function') args[args.length - 1] = (...values: unknown[]) => {
					try { return done(...values); } finally { finish(); }
				};
			}
			try {
				const result = original.apply(this, args);
				if (promiseLike(result)) return Promise.resolve(result).finally(finish);
				if (!callback) finish();
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
