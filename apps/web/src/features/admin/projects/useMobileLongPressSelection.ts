import { useCallback, useRef, useState } from 'react';

interface UseMobileLongPressSelectionParams {
	onSelectOnly: (id: number) => void;
	onResetSelection: () => void;
}

export function useMobileLongPressSelection({
	onSelectOnly,
	onResetSelection,
}: UseMobileLongPressSelectionParams) {
	const [mobileSelectMode, setMobileSelectMode] = useState(false);
	const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearLongPressTimer = useCallback(() => {
		if (longPressTimer.current) {
			clearTimeout(longPressTimer.current);
			longPressTimer.current = null;
		}
	}, []);

	const handleCardTouchStart = useCallback((id: number) => {
		longPressTimer.current = setTimeout(() => {
			setMobileSelectMode(true);
			onSelectOnly(id);
			navigator.vibrate?.(40);
		}, 500);
	}, [onSelectOnly]);

	function exitMobileSelectMode() {
		setMobileSelectMode(false);
		onResetSelection();
	}

	return {
		mobileSelectMode,
		handleCardTouchStart,
		handleCardTouchEnd: clearLongPressTimer,
		exitMobileSelectMode,
	};
}
