export interface OrphanClaimLeaseGuard {
	readonly signal: AbortSignal;
	assertLeaseUsable(): void;
	assertOperationActive(): void;
	renewAndAssertOwned(): Promise<void>;
	stop(): void;
}

export function createOrphanClaimLeaseGuard(input: {
	outerSignal?: AbortSignal;
	heartbeatMs: number;
	renewalDeadlineMs: number;
	ownershipLostError(): Error;
	renew(signal: AbortSignal): Promise<{ count: number }>;
	logHeartbeatFailure(error: unknown): void;
}): OrphanClaimLeaseGuard {
	const claimAbort = new AbortController();
	const signal = input.outerSignal
		? AbortSignal.any([input.outerSignal, claimAbort.signal])
		: claimAbort.signal;
	let active = true;
	let claimLost: Error | undefined;
	let renewalFlight: Promise<void> | undefined;

	function loseClaim(error: unknown): Error | undefined {
		if (!active || claimLost) return claimLost;
		claimLost = error instanceof Error ? error : new Error(String(error));
		claimAbort.abort(claimLost);
		return claimLost;
	}

	function assertLeaseUsable(): void {
		if (claimLost) throw claimLost;
	}

	function assertOperationActive(): void {
		assertLeaseUsable();
		if (signal.aborted) {
			throw signal.reason ?? new Error('Orphan reaper aborted');
		}
	}

	async function runRenewal(): Promise<void> {
		const renewalDeadline = AbortSignal.timeout(input.renewalDeadlineMs);
		const renewalSignal = AbortSignal.any([signal, renewalDeadline]);
		let removeAbortListener = () => {};
		const aborted = new Promise<never>((_resolve, reject) => {
			const onAbort = () => {
				reject(renewalSignal.reason ?? new Error('Orphan claim renewal aborted'));
			};
			if (renewalSignal.aborted) {
				onAbort();
				return;
			}
			renewalSignal.addEventListener('abort', onAbort, { once: true });
			removeAbortListener = () => renewalSignal.removeEventListener('abort', onAbort);
		});

		// Promise.race observes both outcomes of the database operation. Once the
		// local deadline or outer operation abort wins, a late database result can
		// no longer authorize destructive work or become an unhandled rejection.
		let databaseRenewal: Promise<{ count: number }>;
		try {
			databaseRenewal = Promise.resolve(input.renew(renewalSignal));
		} catch (error) {
			databaseRenewal = Promise.reject(error);
		}

		try {
			const result = await Promise.race([databaseRenewal, aborted]);
			if (renewalDeadline.aborted) {
				const error = renewalDeadline.reason ?? new Error('Orphan claim renewal timed out');
				throw loseClaim(error) ?? error;
			}
			if (signal.aborted) {
				throw signal.reason ?? new Error('Orphan reaper aborted');
			}
			if (result.count !== 1) {
				const error = input.ownershipLostError();
				throw loseClaim(error) ?? error;
			}
		} catch (error) {
			if (renewalDeadline.aborted) {
				throw loseClaim(renewalDeadline.reason ?? error) ?? error;
			}
			if (signal.aborted) {
				throw signal.reason ?? error;
			}
			throw loseClaim(error) ?? error;
		} finally {
			removeAbortListener();
		}
	}

	async function renewAndAssertOwned(): Promise<void> {
		assertOperationActive();
		renewalFlight ??= runRenewal().finally(() => {
			renewalFlight = undefined;
		});
		await renewalFlight;
	}

	const heartbeat = setInterval(() => {
		void renewAndAssertOwned().catch((error) => {
			input.logHeartbeatFailure(error);
		});
	}, input.heartbeatMs);
	heartbeat.unref();

	return {
		signal,
		assertLeaseUsable,
		assertOperationActive,
		renewAndAssertOwned,
		stop() {
			if (!active) return;
			active = false;
			clearInterval(heartbeat);
		},
	};
}
