type Resolve<T> = [T] extends [void]
	? (value?: T | PromiseLike<T>) => void
	: (value: T | PromiseLike<T>) => void;

export function deferred<T = void>() {
	let resolve!: Resolve<T>;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise as Resolve<T>;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}
