import { useMemo, useState } from 'react';

export function usePageSelection(pageIds: number[]) {
	const [selected, setSelected] = useState<Set<number>>(new Set());
	const selectedIds = useMemo(
		() => pageIds.filter((id) => selected.has(id)),
		[pageIds, selected],
	);
	const allSelected = pageIds.length > 0 && selectedIds.length === pageIds.length;

	function resetSelection() {
		setSelected(new Set());
	}

	function selectOnly(id: number) {
		setSelected(new Set([id]));
	}

	function toggleAll() {
		setSelected((prev) => {
			const next = new Set(prev);
			if (allSelected) {
				pageIds.forEach((id) => next.delete(id));
			} else {
				pageIds.forEach((id) => next.add(id));
			}
			return next;
		});
	}

	function toggleOne(id: number) {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	return {
		selected,
		selectedIds,
		allSelected,
		resetSelection,
		selectOnly,
		toggleAll,
		toggleOne,
	};
}
