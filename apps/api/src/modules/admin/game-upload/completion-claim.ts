const COMPLETION_CLAIM_LEASE_MS = 2 * 60 * 1000;
const COMPLETION_CLAIM_HEARTBEAT_MS = 30 * 1000;

export class CompletionClaimLostError extends Error {
	constructor(sessionId: string, options?: { cause?: unknown }) {
		super(`Completion claim was lost for upload session ${sessionId}`, options);
		this.name = 'CompletionClaimLostError';
	}
}

/**
 * Keep a completion lease alive and turn either a failed renewal or an outer
 * shutdown into an AbortSignal that storage/deployment code can observe.
 * assertOwned() also performs an immediate DB renewal at commit boundaries so
 * correctness never depends on waiting for the next heartbeat tick.
 */
export function createCompletionClaimGuard(input: {
	sessionId: string;
	token: string;
	clock: { now(): Date };
	renew?: (
		sessionId: string,
		token: string,
		now: Date,
		leaseUntil: Date,
	) => Promise<{ count: number }>;
	outerSignal?: AbortSignal;
	logHeartbeatFailure(error: unknown): void;
}) {
	const claimAbort = new AbortController();
	const signal = input.outerSignal
		? AbortSignal.any([input.outerSignal, claimAbort.signal])
		: claimAbort.signal;
	let active = true;
	let lost: CompletionClaimLostError | undefined;
	let heartbeat: NodeJS.Timeout | undefined;

	function loseClaim(cause?: unknown): CompletionClaimLostError {
		lost ??= new CompletionClaimLostError(input.sessionId, { cause });
		if (active && !claimAbort.signal.aborted) claimAbort.abort(lost);
		return lost;
	}

	async function renew(): Promise<void> {
		if (!active) return;
		if (signal.aborted) {
			throw signal.reason ?? new Error('Upload completion was aborted');
		}
		if (lost) throw lost;
		if (!input.renew) return;

		const now = input.clock.now();
		let result: { count: number };
		try {
			result = await input.renew(
				input.sessionId,
				input.token,
				now,
				new Date(now.getTime() + COMPLETION_CLAIM_LEASE_MS),
			);
		} catch (error) {
			throw loseClaim(error);
		}
		if (result.count !== 1) throw loseClaim();
	}

	if (input.renew) {
		heartbeat = setInterval(() => {
			void renew().catch((error) => {
				if (active) input.logHeartbeatFailure(error);
			});
		}, COMPLETION_CLAIM_HEARTBEAT_MS);
		heartbeat.unref();
	}

	return {
		signal,
		assertOwned: renew,
		isLost: () => lost !== undefined,
		loseClaim,
		stop() {
			active = false;
			if (heartbeat) clearInterval(heartbeat);
		},
	};
}
