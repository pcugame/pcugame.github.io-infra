import { useCallback, useSyncExternalStore } from 'react';

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'pcu-theme';

function getSystemTheme(): Theme {
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getStoredTheme(): Theme | null {
	try {
		const v = localStorage.getItem(STORAGE_KEY);
		if (v === 'light' || v === 'dark') return v;
	} catch { /* noop */ }
	return null;
}

function resolveTheme(): Theme {
	return getStoredTheme() ?? getSystemTheme();
}

/* ── tiny pub/sub so every useTheme() re-renders together ── */

let listeners: Array<() => void> = [];

function subscribe(cb: () => void) {
	listeners = [...listeners, cb];
	return () => { listeners = listeners.filter(l => l !== cb); };
}

let snapshot = resolveTheme();

function getSnapshot() { return snapshot; }

function apply(theme: Theme) {
	document.documentElement.setAttribute('data-theme', theme);
	snapshot = theme;
	listeners.forEach(l => l());
}

/* apply on first load */
apply(resolveTheme());

/* react to OS preference changes when no explicit choice is stored */
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
	if (!getStoredTheme()) apply(getSystemTheme());
});

/* ── hook ── */

export function useTheme() {
	const theme = useSyncExternalStore(subscribe, getSnapshot);

	const toggle = useCallback(() => {
		const next: Theme = snapshot === 'dark' ? 'light' : 'dark';
		localStorage.setItem(STORAGE_KEY, next);
		apply(next);
	}, []);

	return { theme, toggle } as const;
}
