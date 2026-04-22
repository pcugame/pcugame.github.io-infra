import { useEffect, useState } from 'react';

/**
 * Returns `value` debounced by `delayMs`.
 *
 * `freeze` short-circuits the debounce entirely while true — useful for Korean
 * IME composition: bind `freeze` to the input's `isComposing` state so
 * intermediate hangul syllables (ㄱ → 가 → 간) don't trigger filter recomputes
 * mid-composition. When composition ends, `freeze` flips to false and the hook
 * reverts to normal debounce semantics.
 */
export function useDebouncedValue<T>(value: T, delayMs: number, freeze = false): T {
	const [debounced, setDebounced] = useState(value);

	useEffect(() => {
		if (freeze) return;
		const id = setTimeout(() => setDebounced(value), delayMs);
		return () => clearTimeout(id);
	}, [value, delayMs, freeze]);

	return debounced;
}
