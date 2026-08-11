/** Process lifecycle state + in-flight request counter. */

export type LifecycleState = 'starting' | 'ready' | 'draining' | 'shutting_down';

export interface LifecycleClock {
	now(): Date;
}

export interface LifecycleScheduler {
	delay(ms: number): Promise<void>;
}

export interface LifecycleResource {
	getState(): LifecycleState;
	setState(next: LifecycleState): void;
	isAcceptingNewWork(): boolean;
	getInFlight(): number;
	requestStarted(): void;
	requestFinished(): void;
	waitForDrain(timeoutMs: number, pollMs?: number): Promise<'drained' | 'timeout'>;
	close(): void;
}

export function createLifecycle(deps: {
	clock?: LifecycleClock;
	scheduler?: LifecycleScheduler;
} = {}): LifecycleResource {
	const clock = deps.clock ?? { now: () => new Date() };
	const scheduler = deps.scheduler ?? {
		delay: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
	};
	let state: LifecycleState = 'starting';
	let inFlight = 0;
	let closed = false;

	return {
		getState: (): LifecycleState => state,
		setState(next: LifecycleState): void {
			if (closed) return;
			state = next;
		},
		isAcceptingNewWork: (): boolean => state === 'starting' || state === 'ready',
		getInFlight: (): number => inFlight,
		requestStarted(): void {
			if (closed) return;
			inFlight++;
		},
		requestFinished(): void {
			if (inFlight > 0) inFlight--;
		},
		async waitForDrain(timeoutMs: number, pollMs = 200): Promise<'drained' | 'timeout'> {
			const deadline = clock.now().getTime() + timeoutMs;
			while (inFlight > 0) {
				if (clock.now().getTime() >= deadline) return 'timeout';
				await scheduler.delay(pollMs);
			}
			return 'drained';
		},
		close(): void {
			if (closed) return;
			closed = true;
			state = 'shutting_down';
		},
	};
}
