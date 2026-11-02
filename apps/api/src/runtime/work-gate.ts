/** Admission and completion are separate from cancellation. Claim awaits count too. */
export function createWorkGate(initiallyPaused = false) {
	let paused = initiallyPaused;
	let active = 0;
	return {
		quiesce() { paused = true; },
		resume() { paused = false; },
		status: () => ({ paused, active }),
		async run<T>(work: () => Promise<T>, idle: T): Promise<T> {
			if (paused) return idle;
			active++;
			try { return await work(); } finally { active--; }
		},
	};
}
export type WorkGate = ReturnType<typeof createWorkGate>;
