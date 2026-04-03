import { useSyncExternalStore } from 'react';

type Theme = 'light';

/* ── 다크 테마 잠정 폐기 �� 항상 라이트 ── */

let listeners: Array<() => void> = [];

function subscribe(cb: () => void) {
	listeners = [...listeners, cb];
	return () => { listeners = listeners.filter(l => l !== cb); };
}

const snapshot: Theme = 'light';

function getSnapshot() { return snapshot; }

/* apply on first load */
document.documentElement.setAttribute('data-theme', 'light');

/* ── hook ── */

export function useTheme() {
	const theme = useSyncExternalStore(subscribe, getSnapshot);
	const toggle = () => { /* dark theme disabled */ };
	return { theme, toggle } as const;
}
