/**
 * Process lifecycle state + in-flight request counter.
 *
 * State transitions:
 *   starting → ready      (after buildApp + boot sweep)
 *   ready    → draining   (SIGTERM/SIGINT received)
 *   draining → shutting_down (after drain window elapses or in-flight hits 0)
 *
 * During `draining`, /api/health flips to 503 so load balancers stop routing new traffic,
 * and the upload-session creation endpoint refuses new work. In-flight requests — including
 * game-upload `complete` calls that have already written bytes — keep running until they
 * finish or the drain timeout expires.
 */

export type LifecycleState = 'starting' | 'ready' | 'draining' | 'shutting_down';

let state: LifecycleState = 'starting';
let inFlight = 0;

export function getLifecycleState(): LifecycleState {
	return state;
}

export function setLifecycleState(next: LifecycleState): void {
	state = next;
}

export function isAcceptingNewWork(): boolean {
	return state === 'starting' || state === 'ready';
}

export function getInFlight(): number {
	return inFlight;
}

export function incInFlight(): void {
	inFlight++;
}

export function decInFlight(): void {
	if (inFlight > 0) inFlight--;
}

/**
 * Poll until inFlight reaches 0 or the timeout expires.
 * Returns 'drained' on clean exit, 'timeout' if some requests are still running.
 */
export async function waitForDrain(timeoutMs: number, pollMs = 200): Promise<'drained' | 'timeout'> {
	const deadline = Date.now() + timeoutMs;
	while (inFlight > 0) {
		if (Date.now() >= deadline) return 'timeout';
		await new Promise((r) => setTimeout(r, pollMs));
	}
	return 'drained';
}
