import { useState, useMemo, useRef, useCallback } from 'react';
import type React from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AdminProjectListSort, ProjectStatus, SortOrder } from '../../contracts';
import { adminProjectApi, getApiErrorMessage } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { useMe } from '../../features/auth';
import { useDebouncedValue } from '../../lib/useDebouncedValue';
import { LoadingSpinner, ErrorMessage, EmptyState } from '../../components/common';

const STATUS_LABELS: Record<ProjectStatus, string> = {
	PUBLISHED: '공개',
	ARCHIVED: '보관',
};

const STATUS_COLORS: Record<ProjectStatus, string> = {
	PUBLISHED: 'badge--published',
	ARCHIVED: 'badge--archived',
};

function titleStyle(title: string): React.CSSProperties {
	const len = title.length;
	if (len <= 16) return { fontSize: '0.9rem', lineHeight: '1.5' };
	if (len <= 24) return { fontSize: '0.82rem', lineHeight: '1.4' };
	if (len <= 36) return { fontSize: '0.74rem', lineHeight: '1.3' };
	return { fontSize: '0.66rem', lineHeight: '1.2', letterSpacing: '-0.02em' };
}

const DEFAULT_PAGE_LIMIT = 20;

type SortKey = AdminProjectListSort;
type SortDir = SortOrder;

export default function AdminProjectsPage() {
	const qc = useQueryClient();
	const { user } = useMe();
	const isAdmin = user?.role === 'ADMIN';
	const isPrivileged = user?.role === 'ADMIN' || user?.role === 'OPERATOR';

	// ── Filters ──────────────────────────────────────────
	const [statusFilter, setStatusFilter] = useState<ProjectStatus | 'ALL'>('ALL');
	const [search, setSearch] = useState('');
	const [yearFilter, setYearFilter] = useState('');
	const [isComposing, setIsComposing] = useState(false);
	const debouncedSearch = useDebouncedValue(search, 250, isComposing);
	const [page, setPage] = useState(1);
	const [limit] = useState(DEFAULT_PAGE_LIMIT);
	const [sortKey, setSortKey] = useState<SortKey>('createdAt');
	const [sortDir, setSortDir] = useState<SortDir>('desc');

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

	const { data, isLoading, error, refetch } = useQuery({
		queryKey: queryKeys.adminProjectsList(listQuery),
		queryFn: () => adminProjectApi.getProjects(listQuery),
	});

	// ── Selection ────────────────────────────────────────
	const [selected, setSelected] = useState<Set<number>>(new Set());

	// ── Bulk mutations ───────────────────────────────────
	const bulkStatusMutation = useMutation({
		mutationFn: ({ ids, status }: { ids: number[]; status: string }) =>
			adminProjectApi.bulkStatus(ids, status),
		onSuccess: () => {
			setSelected(new Set());
			qc.invalidateQueries({ queryKey: queryKeys.adminProjects });
			qc.invalidateQueries({ queryKey: queryKeys.publicYears });
		},
	});

	const bulkDeleteMutation = useMutation({
		mutationFn: (ids: number[]) => adminProjectApi.bulkDelete(ids),
		onSuccess: () => {
			setSelected(new Set());
			qc.invalidateQueries({ queryKey: queryKeys.adminProjects });
			qc.invalidateQueries({ queryKey: queryKeys.publicYears });
		},
	});

	const isBusy = bulkStatusMutation.isPending || bulkDeleteMutation.isPending;

	// ── Derived data ─────────────────────────────────────
	const projects = useMemo(() => data?.items ?? [], [data?.items]);
	const pagination = data?.pagination;
	const projectIds = useMemo(() => projects.map((p) => p.id), [projects]);
	const selectedIds = useMemo(
		() => projectIds.filter((id) => selected.has(id)),
		[projectIds, selected],
	);

	// ── Mobile long-press selection ──────────────────────
	const [mobileSelectMode, setMobileSelectMode] = useState(false);
	const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const handleCardTouchStart = useCallback((id: number) => {
		longPressTimer.current = setTimeout(() => {
			setMobileSelectMode(true);
			setSelected(new Set([id]));
			navigator.vibrate?.(40);
		}, 500);
	}, []);

	const handleCardTouchEnd = useCallback(() => {
		if (longPressTimer.current) {
			clearTimeout(longPressTimer.current);
			longPressTimer.current = null;
		}
	}, []);

	function exitMobileSelectMode() {
		setMobileSelectMode(false);
		setSelected(new Set());
	}

	// ── Selection helpers ────────────────────────────────
	const allSelected = projectIds.length > 0 && selectedIds.length === projectIds.length;

	function toggleAll() {
		setSelected((prev) => {
			const next = new Set(prev);
			if (allSelected) {
				projectIds.forEach((id) => next.delete(id));
			} else {
				projectIds.forEach((id) => next.add(id));
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

	// ── Sort toggle ──────────────────────────────────────
	function handleSort(key: SortKey) {
		setPage(1);
		setSelected(new Set());
		if (sortKey === key) {
			setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
		} else {
			setSortKey(key);
			setSortDir(key === 'title' ? 'asc' : 'desc');
		}
	}

	function sortIndicator(key: SortKey) {
		if (sortKey !== key) return '';
		return sortDir === 'asc' ? ' \u25B2' : ' \u25BC';
	}

	function goToPage(nextPage: number) {
		if (!pagination) return;
		if (nextPage < 1 || nextPage > pagination.totalPages) return;
		setSelected(new Set());
		setPage(nextPage);
	}

	function handleStatusFilter(nextStatus: ProjectStatus | 'ALL') {
		setStatusFilter(nextStatus);
		setPage(1);
		setSelected(new Set());
	}

	function handleYearFilter(value: string) {
		setYearFilter(value);
		setPage(1);
		setSelected(new Set());
	}

	function handleSearchChange(value: string) {
		setSearch(value);
		setPage(1);
		setSelected(new Set());
	}

	// ── Bulk actions ─────────────────────────────────────
	function handleBulkStatus(status: ProjectStatus) {
		if (selectedIds.length === 0) return;
		bulkStatusMutation.mutate({ ids: selectedIds, status });
	}

	function handleBulkDelete() {
		if (selectedIds.length === 0) return;
		if (!window.confirm(
			`${selectedIds.length}개 작품을 삭제하시겠습니까?\n\nS3 파일은 삭제되지만 NAS 원본은 유지됩니다.`,
		)) return;
		bulkDeleteMutation.mutate(selectedIds);
	}

	// ── Render ────────────────────────────────────────────
	if (isLoading) return <LoadingSpinner />;
	if (error) return <ErrorMessage error={error} onReset={() => refetch()} />;

	return (
		<div className="admin-projects-page">
			<div className="admin-page-header">
				<div className="admin-page-header__text">
					<span className="admin-page-header__eyebrow">Project Management</span>
					<h1>작품 관리</h1>
				</div>
				<Link to="/admin/projects/new" className="btn btn--primary">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '0.4rem' }}>
						<line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
					</svg>
					새 작품 등록
				</Link>
			</div>

			{/* 상태 필터 탭 */}
			<div className="admin-filter-tabs">
				{(['ALL', 'PUBLISHED', 'ARCHIVED'] as const).map((s) => (
					<button
						key={s}
						className={`admin-filter-tab ${statusFilter === s ? 'admin-filter-tab--active' : ''}`}
						onClick={() => handleStatusFilter(s)}
					>
						{s === 'ALL' ? '전체' : STATUS_LABELS[s]}
					</button>
				))}
			</div>

			{/* 검색 + 일괄 작업 바 */}
			<div className="admin-toolbar">
				<input
					type="text"
					className="admin-search"
					placeholder="제목, 요약, 이름, 학번 검색..."
					value={search}
					onChange={(e) => handleSearchChange(e.target.value)}
					onCompositionStart={() => setIsComposing(true)}
					onCompositionEnd={(e) => {
						setIsComposing(false);
						handleSearchChange((e.target as HTMLInputElement).value);
					}}
				/>
				<input
					type="number"
					className="admin-filter-input"
					aria-label="연도 필터"
					placeholder="연도"
					value={yearFilter}
					onChange={(e) => handleYearFilter(e.target.value)}
				/>
				{isPrivileged && selectedIds.length > 0 && (
					<div className="admin-bulk-actions">
						<span className="admin-bulk-actions__count">{selectedIds.length}개 선택</span>
						<button
							className="btn btn--small btn--secondary"
							disabled={isBusy}
							onClick={() => handleBulkStatus('PUBLISHED')}
						>
							공개
						</button>
						<button
							className="btn btn--small btn--secondary"
							disabled={isBusy}
							onClick={() => handleBulkStatus('ARCHIVED')}
						>
							보관
						</button>
						{isAdmin && (
							<button
								className="btn btn--small btn--danger"
								disabled={isBusy}
								onClick={handleBulkDelete}
							>
								{bulkDeleteMutation.isPending ? '삭제 중...' : '삭제'}
							</button>
						)}
					</div>
				)}
			</div>

			{/* 에러 표시 */}
			{(bulkStatusMutation.error || bulkDeleteMutation.error) && (
				<div className="admin-card" style={{ background: 'var(--color-error-bg, #fce4ec)', padding: '1rem', marginBottom: '1rem' }}>
					{getApiErrorMessage(bulkStatusMutation.error ?? bulkDeleteMutation.error)}
				</div>
			)}

			{projects.length === 0 ? (
				<EmptyState message="조건에 맞는 작품이 없습니다." />
			) : (
				<>
					{/* Desktop: table */}
					<div className="admin-card admin-desktop-only">
						<table className="admin-table">
							<thead>
								<tr>
									{isPrivileged && (
										<th style={{ width: '2.5rem' }}>
											<input
												type="checkbox"
												checked={allSelected}
												onChange={toggleAll}
											/>
										</th>
									)}
									<th className="admin-table__sortable" onClick={() => handleSort('title')}>
										제목{sortIndicator('title')}
									</th>
									<th className="admin-table__sortable" onClick={() => handleSort('year')}>
										연도{sortIndicator('year')}
									</th>
									<th className="admin-table__sortable" onClick={() => handleSort('status')}>
										상태{sortIndicator('status')}
									</th>
									<th>누락</th>
									<th>제작자</th>
									<th className="admin-table__col--creator">작성자</th>
									<th>수정일</th>
									<th>관리</th>
								</tr>
							</thead>
							<tbody>
								{projects.map((p) => (
									<tr key={p.id} className={selected.has(p.id) ? 'admin-table__row--selected' : ''}>
										{isPrivileged && (
											<td>
												<input
													type="checkbox"
													checked={selected.has(p.id)}
													onChange={() => toggleOne(p.id)}
												/>
											</td>
										)}
										<td className="admin-table__title-cell"><strong style={titleStyle(p.title)}>{p.title}</strong></td>
										<td><span className="admin-year-badge">{p.year}</span></td>
										<td>
											<span className={`badge ${STATUS_COLORS[p.status]}`}>
												{STATUS_LABELS[p.status]}
											</span>
										</td>
										<td>
											{p.isIncomplete && (
												<span className="incomplete-badge">불완전</span>
											)}
										</td>
										<td>{p.memberNames.length > 0 ? p.memberNames.join(', ') : '-'}</td>
										<td className="admin-table__col--creator">{p.createdByUserName ?? '-'}</td>
										<td className="text-muted">{new Date(p.updatedAt).toLocaleDateString('ko-KR')}</td>
										<td>
											<Link
												to={`/admin/projects/${p.id}/edit`}
												className="btn btn--small btn--secondary"
											>
												수정
											</Link>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>

					{/* Mobile: card list */}
					<div className={`admin-mobile-cards ${mobileSelectMode ? 'admin-mobile-cards--selecting' : ''}`}>
						{isPrivileged && mobileSelectMode && (
							<div className="admin-mobile-select-bar">
								<button className="admin-mobile-select-bar__all" onClick={toggleAll}>
									{allSelected ? '전체 해제' : '전체 선택'}
								</button>
								<span className="admin-mobile-select-bar__count">{selectedIds.length}개 선택됨</span>
								<button className="admin-mobile-select-bar__cancel" onClick={exitMobileSelectMode}>
									취소
								</button>
							</div>
						)}
						{projects.map((p) => (
							<div
								key={p.id}
								className={`admin-pcard ${selected.has(p.id) ? 'admin-pcard--selected' : ''}`}
								onTouchStart={isPrivileged ? () => handleCardTouchStart(p.id) : undefined}
								onTouchEnd={isPrivileged ? handleCardTouchEnd : undefined}
								onTouchMove={isPrivileged ? handleCardTouchEnd : undefined}
								onMouseDown={isPrivileged ? () => handleCardTouchStart(p.id) : undefined}
								onMouseUp={isPrivileged ? handleCardTouchEnd : undefined}
								onMouseLeave={isPrivileged ? handleCardTouchEnd : undefined}
								onClick={isPrivileged && mobileSelectMode ? () => toggleOne(p.id) : undefined}
							>
								{isPrivileged && mobileSelectMode && selected.has(p.id) && (
									<span className="admin-pcard__selected-mark">
										<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
											<polyline points="20 6 9 17 4 12" />
										</svg>
									</span>
								)}
								<Link
									to={`/admin/projects/${p.id}/edit`}
									className="admin-pcard__link"
									onClick={mobileSelectMode ? (e) => e.preventDefault() : undefined}
								>
									<div className="admin-pcard__top">
										<h3 className="admin-pcard__title">{p.title}</h3>
										{p.isIncomplete && (
											<span className="incomplete-badge">불완전</span>
										)}
										<span className={`badge ${STATUS_COLORS[p.status]}`}>
											{STATUS_LABELS[p.status]}
										</span>
									</div>
									<div className="admin-pcard__meta">
										<span className="admin-year-badge">{p.year}</span>
										<span className="admin-pcard__dot">&middot;</span>
										<span>{p.memberNames.length > 0 ? p.memberNames.join(', ') : '-'}</span>
										<span className="admin-pcard__dot">&middot;</span>
										<span>{new Date(p.updatedAt).toLocaleDateString('ko-KR')}</span>
									</div>
								</Link>
							</div>
						))}
					</div>
				</>
			)}
			{pagination && (
				<div className="admin-pagination">
					<span className="admin-pagination__summary">
						총 {pagination.totalItems.toLocaleString('ko-KR')}개
					</span>
					<div className="admin-pagination__controls">
						<button
							type="button"
							className="btn btn--small btn--secondary"
							disabled={!pagination.hasPreviousPage}
							onClick={() => goToPage(pagination.page - 1)}
						>
							이전
						</button>
						<span className="admin-pagination__page">
							{pagination.totalPages === 0 ? '0 / 0' : `${pagination.page} / ${pagination.totalPages}`}
						</span>
						<button
							type="button"
							className="btn btn--small btn--secondary"
							disabled={!pagination.hasNextPage}
							onClick={() => goToPage(pagination.page + 1)}
						>
							다음
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
