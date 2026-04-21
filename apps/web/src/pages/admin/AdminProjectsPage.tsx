import { useState, useMemo } from 'react';
import type React from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ProjectStatus } from '../../contracts';
import { adminProjectApi, getApiErrorMessage } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { useMe } from '../../features/auth';
import { LoadingSpinner, ErrorMessage, EmptyState } from '../../components/common';

const STATUS_LABELS: Record<ProjectStatus, string> = {
	DRAFT: '초안',
	PUBLISHED: '공개',
	ARCHIVED: '보관',
};

const STATUS_COLORS: Record<ProjectStatus, string> = {
	DRAFT: 'badge--draft',
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

type SortKey = 'title' | 'year' | 'status' | 'incomplete' | 'updatedAt';
type SortDir = 'asc' | 'desc';

export default function AdminProjectsPage() {
	const qc = useQueryClient();
	const { user } = useMe();
	const isAdmin = user?.role === 'ADMIN';
	const isPrivileged = user?.role === 'ADMIN' || user?.role === 'OPERATOR';

	const { data, isLoading, error, refetch } = useQuery({
		queryKey: queryKeys.adminProjects,
		queryFn: adminProjectApi.list,
	});

	// ── Filters ──────────────────────────────────────────
	const [statusFilter, setStatusFilter] = useState<ProjectStatus | 'ALL'>('ALL');
	const [search, setSearch] = useState('');
	const [sortKey, setSortKey] = useState<SortKey>('year');
	const [sortDir, setSortDir] = useState<SortDir>('desc');

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
	const projects = useMemo(() => data?.items ?? [], [data]);

	const filtered = useMemo(() => {
		let list = statusFilter === 'ALL'
			? projects
			: projects.filter((p) => p.status === statusFilter);

		if (search.trim()) {
			const q = search.trim().toLowerCase();
			list = list.filter((p) =>
				p.title.toLowerCase().includes(q) ||
				String(p.year).includes(q) ||
				(p.createdByUserName ?? '').toLowerCase().includes(q) ||
				p.memberNames.some((name) => name.toLowerCase().includes(q)),
			);
		}

		list = [...list].sort((a, b) => {
			let cmp = 0;
			if (sortKey === 'title') cmp = a.title.localeCompare(b.title, 'ko');
			else if (sortKey === 'year') cmp = a.year - b.year;
			else if (sortKey === 'status') cmp = a.status.localeCompare(b.status);
			else if (sortKey === 'incomplete') cmp = Number(a.isIncomplete) - Number(b.isIncomplete);
			else if (sortKey === 'updatedAt') cmp = a.updatedAt.localeCompare(b.updatedAt);
			return sortDir === 'asc' ? cmp : -cmp;
		});

		return list;
	}, [projects, statusFilter, search, sortKey, sortDir]);

	const statusCounts = {
		ALL: projects.length,
		DRAFT: projects.filter((p) => p.status === 'DRAFT').length,
		PUBLISHED: projects.filter((p) => p.status === 'PUBLISHED').length,
		ARCHIVED: projects.filter((p) => p.status === 'ARCHIVED').length,
	};

	// ── Selection helpers ────────────────────────────────
	const filteredIds = filtered.map((p) => p.id);
	const allSelected = filteredIds.length > 0 && filteredIds.every((id) => selected.has(id));

	function toggleAll() {
		if (allSelected) {
			setSelected(new Set());
		} else {
			setSelected(new Set(filteredIds));
		}
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

	// ── Bulk actions ─────────────────────────────────────
	const selectedIds = [...selected];

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
				{(['ALL', 'DRAFT', 'PUBLISHED', 'ARCHIVED'] as const).map((s) => (
					<button
						key={s}
						className={`admin-filter-tab ${statusFilter === s ? 'admin-filter-tab--active' : ''}`}
						onClick={() => { setStatusFilter(s); setSelected(new Set()); }}
					>
						{s === 'ALL' ? '전체' : STATUS_LABELS[s]}
						<span className="admin-filter-tab__count">{statusCounts[s]}</span>
					</button>
				))}
			</div>

			{/* 검색 + 일괄 작업 바 */}
			<div className="admin-toolbar">
				<input
					type="text"
					className="admin-search"
					placeholder="제목, 연도, 작성자 검색..."
					value={search}
					onChange={(e) => setSearch(e.target.value)}
				/>
				{isPrivileged && selected.size > 0 && (
					<div className="admin-bulk-actions">
						<span className="admin-bulk-actions__count">{selected.size}개 선택</span>
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
							onClick={() => handleBulkStatus('DRAFT')}
						>
							초안
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

			{filtered.length === 0 ? (
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
									<th className="admin-table__sortable" onClick={() => handleSort('incomplete')}>
										누락{sortIndicator('incomplete')}
									</th>
									<th>제작자</th>
									<th>작성자</th>
									<th className="admin-table__sortable" onClick={() => handleSort('updatedAt')}>
										수정일{sortIndicator('updatedAt')}
									</th>
									<th>관리</th>
								</tr>
							</thead>
							<tbody>
								{filtered.map((p) => (
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
										<td>{p.createdByUserName ?? '-'}</td>
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
					<div className="admin-mobile-cards">
						{filtered.map((p) => (
							<div key={p.id} className={`admin-pcard ${selected.has(p.id) ? 'admin-pcard--selected' : ''}`}>
								{isPrivileged && (
									<input
										type="checkbox"
										className="admin-pcard__check"
										checked={selected.has(p.id)}
										onChange={() => toggleOne(p.id)}
									/>
								)}
								<Link
									to={`/admin/projects/${p.id}/edit`}
									className="admin-pcard__link"
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
		</div>
	);
}
