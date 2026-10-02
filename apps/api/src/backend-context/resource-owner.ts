

export type ResourceOwnership = 'owned' | 'borrowed';

/**
 * An externally supplied resource must declare who owns its lifetime. Borrowed
 * resources are observable through the context but are never started or closed
 * by it; owned resources join the same reverse-order lifecycle as factory output.
 */
export type ResourceLease<T> =
	| {
		value: T;
		ownership: 'borrowed';
	}
	| {
		value: T;
		ownership: 'owned';
		start?: () => void | Promise<void>;
		close: () => void | Promise<void>;
	};

export interface BackendResourceOwnership {
	name: string;
	ownership: ResourceOwnership;
}

interface RegisteredResource extends BackendResourceOwnership {
	start?: () => void | Promise<void>;
	close?: () => void | Promise<void>;
}

export class BackendResourceOwner {
	private readonly registered: RegisteredResource[] = [];
	private closingRequested = false;
	private startWork: Promise<void> | undefined;
	private startPromise: Promise<void> | undefined;
	private closePromise: Promise<void> | undefined;

	register<T>(name: string, lease: ResourceLease<T>): T {
		if (this.startPromise || this.closePromise) {
			throw new Error(`Cannot register ${name} after the BackendContext lifecycle began`);
		}
		this.registered.push({
			name,
			ownership: lease.ownership,
			start: lease.ownership === 'owned' ? lease.start : undefined,
			close: lease.ownership === 'owned' ? lease.close : undefined,
		});
		return lease.value;
	}

	ownership(): readonly BackendResourceOwnership[] {
		return this.registered.map(({ name, ownership }) => ({ name, ownership }));
	}

	start(): Promise<void> {
		if (this.closePromise) return Promise.reject(new Error('BackendContext is closed'));
		this.startWork ??= (async () => {
			for (const resource of this.registered) {
				if (this.closingRequested) throw new Error('BackendContext start aborted by close');
				if (resource.ownership === 'owned') await resource.start?.();
				if (this.closingRequested) throw new Error('BackendContext start aborted by close');
			}
		})();
		this.startPromise ??= this.startWork.catch(async (error) => {
			await this.close().catch(() => undefined);
			throw error;
		});
		return this.startPromise;
	}

	close(): Promise<void> {
		this.closingRequested = true;
		this.closePromise ??= (async () => {
			const closeTimeoutMs = 5_000;
			async function settleWithin(work: Promise<unknown>, label: string): Promise<void> {
				let timer: NodeJS.Timeout | undefined;
				try {
					await Promise.race([
						work,
						new Promise<never>((_resolve, reject) => {
							timer = setTimeout(
								() => reject(new Error(`Timed out closing ${label}`)),
								closeTimeoutMs,
							);
							timer.unref();
						}),
					]);
				} finally {
					if (timer) clearTimeout(timer);
				}
			}

			let firstError: unknown;
			if (this.startWork) {
				try {
					await settleWithin(this.startWork.catch(() => undefined), 'context startup');
				} catch (error) {
					firstError ??= error;
				}
			}
			for (const resource of [...this.registered].reverse()) {
				if (resource.ownership !== 'owned') continue;
				try {
					await settleWithin(Promise.resolve().then(() => resource.close?.()), resource.name);
				} catch (error) {
					firstError ??= error;
				}
			}
			if (firstError !== undefined) throw firstError;
		})();
		return this.closePromise;
	}
}

export function owned<T>(value: T, close?: () => void | Promise<void>, start?: () => void | Promise<void>): ResourceLease<T> {
	return { value, ownership: 'owned', close: close ?? (() => { }), start };
}

