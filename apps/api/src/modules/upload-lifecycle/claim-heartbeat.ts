export class ClaimLeaseLostError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'ClaimLeaseLostError';
	}
}

/**
 * Keep a row lease alive without holding a database transaction during I/O.
 * Renewal is single-flight, and losing ownership aborts in-flight storage work.
 * Call assertOwned at I/O/finalization boundaries so correctness is not tied to
 * the interval firing before a short operation completes.
 */
export function createClaimHeartbeatGuard(input: {
	heartbeatMs: number;
	lostMessage: string;
	outerSignal?: AbortSignal;
	renew(): Promise<{ count: number }>;
	logHeartbeatFailure(error: unknown): void;
}) {
	const claimAbort = new AbortController();
	const signal = input.outerSignal
		? AbortSignal.any([input.outerSignal, claimAbort.signal])
		: claimAbort.signal;
	let active = true;
	let lost: ClaimLeaseLostError | undefined;
	let renewalFlight: Promise<void> | undefined;

	function loseClaim(cause?: unknown): ClaimLeaseLostError {
		lost ??= new ClaimLeaseLostError(input.lostMessage, { cause });
		if (active && !claimAbort.signal.aborted) claimAbort.abort(lost);
		return lost;
	}

	async function assertOwned(): Promise<void> {
		if (lost) throw lost;
		if (signal.aborted) {
			throw signal.reason ?? new Error('Claimed operation was aborted');
		}
		renewalFlight ??= (async () => {
			try {
				const renewed = await input.renew();
				if (renewed.count !== 1) throw loseClaim();
			} catch (error) {
				throw loseClaim(error);
			}
		})().finally(() => {
			renewalFlight = undefined;
		});
		return renewalFlight;
	}

	const heartbeat = setInterval(() => {
		void assertOwned().catch((error) => {
			if (active) input.logHeartbeatFailure(error);
		});
	}, input.heartbeatMs);
	heartbeat.unref();

	return {
		signal,
		assertOwned,
		isLost: () => lost !== undefined,
		stop() {
			active = false;
			clearInterval(heartbeat);
		},
	};
}
