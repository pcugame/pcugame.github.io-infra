import { useEffect } from 'react';

export function usePreventWindowClose(enabled: boolean): void {
	useEffect(() => {
		if (!enabled) return;
		const handleBeforeUnload = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = '';
		};
		window.addEventListener('beforeunload', handleBeforeUnload);
		return () => window.removeEventListener('beforeunload', handleBeforeUnload);
	}, [enabled]);
}
