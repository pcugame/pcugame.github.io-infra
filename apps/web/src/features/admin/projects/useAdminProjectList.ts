import { useMemo, useState } from 'react';
import type { AdminProjectListSort, ProjectStatus, SortOrder } from '../../../contracts';
import { useDebouncedValue } from '../../../lib/useDebouncedValue';

const DEFAULT_PAGE_LIMIT = 20;

export type AdminProjectStatusFilter = ProjectStatus | 'ALL';
export type AdminProjectSortKey = AdminProjectListSort;
export type AdminProjectSortDir = SortOrder;

export function useAdminProjectList(onListStateChange?: () => void) {
	const [statusFilter, setStatusFilter] = useState<AdminProjectStatusFilter>('ALL');
	const [search, setSearch] = useState('');
	const [yearFilter, setYearFilter] = useState('');
	const [isComposing, setIsComposing] = useState(false);
	const debouncedSearch = useDebouncedValue(search, 250, isComposing);
	const [page, setPage] = useState(1);
	const [limit] = useState(DEFAULT_PAGE_LIMIT);
	const [sortKey, setSortKey] = useState<AdminProjectSortKey>('createdAt');
	const [sortDir, setSortDir] = useState<AdminProjectSortDir>('desc');

	const listQuery = useMemo(() => {
		const term = debouncedSearch.trim();
		const year = yearFilter.trim();
		const parsedYear = Number(year);
		return {
			page,
			limit,
			...(term ? { search: term } : {}),
			...(year && Number.isInteger(parsedYear) ? { year: parsedYear } : {}),
			...(statusFilter === 'ALL' ? {} : { status: statusFilter }),
			sort: sortKey,
			order: sortDir,
		};
	}, [debouncedSearch, limit, page, sortDir, sortKey, statusFilter, yearFilter]);

	function resetPageAndSelection() {
		setPage(1);
		onListStateChange?.();
	}

	function handleSort(key: AdminProjectSortKey) {
		resetPageAndSelection();
		if (sortKey === key) {
			setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
		} else {
			setSortKey(key);
			setSortDir(key === 'title' ? 'asc' : 'desc');
		}
	}

	function sortIndicator(key: AdminProjectSortKey) {
		if (sortKey !== key) return '';
		return sortDir === 'asc' ? ' \u25B2' : ' \u25BC';
	}

	function goToPage(nextPage: number, totalPages: number) {
		if (nextPage < 1 || nextPage > totalPages) return;
		onListStateChange?.();
		setPage(nextPage);
	}

	function handleStatusFilter(nextStatus: AdminProjectStatusFilter) {
		setStatusFilter(nextStatus);
		resetPageAndSelection();
	}

	function handleYearFilter(value: string) {
		setYearFilter(value);
		resetPageAndSelection();
	}

	function handleSearchChange(value: string) {
		setSearch(value);
		resetPageAndSelection();
	}

	return {
		statusFilter,
		search,
		yearFilter,
		isComposing,
		listQuery,
		handleSort,
		sortIndicator,
		goToPage,
		handleStatusFilter,
		handleYearFilter,
		handleSearchChange,
		setIsComposing,
	};
}
