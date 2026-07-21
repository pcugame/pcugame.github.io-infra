/** Process lifecycle state + in-flight request counter. */

export type LifecycleState = 'starting' | 'ready' | 'draining' | 'shutting_down';

export function createLifecycle(deps: {
	now?: () => number;
	delay?: (ms: number) => Promise<void>;
} = {}) {
	const now = deps.now ?? Date.now;
	const delay = deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	let state: LifecycleState = 'starting';
	let inFlight = 0;

	return {
		getState: (): LifecycleState => state,
		setState(next: LifecycleState): void {
			state = next;
		},
		isAcceptingNewWork: (): boolean => state === 'starting' || state === 'ready',
		getInFlight: (): number => inFlight,
		requestStarted(): void {
			inFlight++;
		},
		requestFinished(): void {
			if (inFlight > 0) inFlight--;
		},
		async waitForDrain(timeoutMs: number, pollMs = 200): Promise<'drained' | 'timeout'> {
			const deadline = now() + timeoutMs;
			while (inFlight > 0) {
				if (now() >= deadline) return 'timeout';
				await delay(pollMs);
			}
			return 'drained';
		},
	};
}

const processLifecycle = createLifecycle();

export const getLifecycleState = processLifecycle.getState;
export const setLifecycleState = processLifecycle.setState;
export const isAcceptingNewWork = processLifecycle.isAcceptingNewWork;
export const getInFlight = processLifecycle.getInFlight;
export const incInFlight = processLifecycle.requestStarted;
export const decInFlight = processLifecycle.requestFinished;
export const waitForDrain = processLifecycle.waitForDrain;
