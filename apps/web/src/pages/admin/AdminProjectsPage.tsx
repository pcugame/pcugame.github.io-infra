import { useEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectStatus } from '../../contracts';
import { adminProjectApi, getApiErrorMessage } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { useMe } from '../../features/auth';
import { LoadingSpinner, ErrorMessage, EmptyState } from '../../components/common';
import { AdminProjectsMobileList } from '../../features/admin/projects/AdminProjectsMobileList';
import { AdminProjectsPagination } from '../../features/admin/projects/AdminProjectsPagination';
import { AdminProjectsTable } from '../../features/admin/projects/AdminProjectsTable';
import { AdminProjectsToolbar } from '../../features/admin/projects/AdminProjectsToolbar';
import { useAdminProjectList } from '../../features/admin/projects/useAdminProjectList';
import { useMobileLongPressSelection } from '../../features/admin/projects/useMobileLongPressSelection';
import { usePageSelection } from '../../features/admin/projects/usePageSelection';

export default function AdminProjectsPage() {
	const qc = useQueryClient();
	const { user } = useMe();
	const isAdmin = user?.role === 'ADMIN';
	const isPrivileged = user?.role === 'ADMIN' || user?.role === 'OPERATOR';
	const resetSelectionRef = useRef<() => void>(() => {});

	const projectList = useAdminProjectList(() => resetSelectionRef.current());

	const { data, isLoading, error, refetch } = useQuery({
		queryKey: queryKeys.adminProjectsList(projectList.listQuery),
		queryFn: () => adminProjectApi.getProjects(projectList.listQuery),
	});

	const projects = useMemo(() => data?.items ?? [], [data?.items]);
	const pagination = data?.pagination;
	const projectIds = useMemo(() => projects.map((p) => p.id), [projects]);
	const selection = usePageSelection(projectIds);
	const mobileSelection = useMobileLongPressSelection({
		onSelectOnly: selection.selectOnly,
		onResetSelection: selection.resetSelection,
	});

	useEffect(() => {
		resetSelectionRef.current = selection.resetSelection;
	}, [selection.resetSelection]);

	const bulkStatusMutation = useMutation({
		mutationFn: ({ ids, status }: { ids: number[]; status: ProjectStatus }) =>
			adminProjectApi.bulkStatus(ids, status),
		onSuccess: () => {
			selection.resetSelection();
			qc.invalidateQueries({ queryKey: queryKeys.adminProjects });
			qc.invalidateQueries({ queryKey: queryKeys.publicYears });
		},
	});

	const bulkDeleteMutation = useMutation({
		mutationFn: (ids: number[]) => adminProjectApi.bulkDelete(ids),
		onSuccess: () => {
			selection.resetSelection();
			qc.invalidateQueries({ queryKey: queryKeys.adminProjects });
			qc.invalidateQueries({ queryKey: queryKeys.publicYears });
		},
	});

	const isBusy = bulkStatusMutation.isPending || bulkDeleteMutation.isPending;

	function handleBulkStatus(status: ProjectStatus) {
		if (selection.selectedIds.length === 0) return;
		bulkStatusMutation.mutate({ ids: selection.selectedIds, status });
	}

	function handleBulkDelete() {
		if (selection.selectedIds.length === 0) return;
		if (!window.confirm(
			`${selection.selectedIds.length}개 작품을 삭제하시겠습니까?\n\nS3 파일은 삭제되지만 NAS 원본은 유지됩니다.`,
		)) return;
		bulkDeleteMutation.mutate(selection.selectedIds);
	}

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

			<AdminProjectsToolbar
				statusFilter={projectList.statusFilter}
				search={projectList.search}
				yearFilter={projectList.yearFilter}
				selectedCount={selection.selectedIds.length}
				isPrivileged={isPrivileged}
				isAdmin={isAdmin}
				isBusy={isBusy}
				isDeleting={bulkDeleteMutation.isPending}
				onStatusFilter={projectList.handleStatusFilter}
				onSearchChange={projectList.handleSearchChange}
				onYearFilter={projectList.handleYearFilter}
				onCompositionStart={() => projectList.setIsComposing(true)}
				onCompositionEnd={(value) => {
					projectList.setIsComposing(false);
					projectList.handleSearchChange(value);
				}}
				onBulkStatus={handleBulkStatus}
				onBulkDelete={handleBulkDelete}
			/>

			{(bulkStatusMutation.error || bulkDeleteMutation.error) && (
				<div className="admin-card" style={{ background: 'var(--color-error-bg, #fce4ec)', padding: '1rem', marginBottom: '1rem' }}>
					{getApiErrorMessage(bulkStatusMutation.error ?? bulkDeleteMutation.error)}
				</div>
			)}

			{projects.length === 0 ? (
				<EmptyState message="조건에 맞는 작품이 없습니다." />
			) : (
				<>
					<AdminProjectsTable
						projects={projects}
						isPrivileged={isPrivileged}
						selected={selection.selected}
						allSelected={selection.allSelected}
						onToggleAll={selection.toggleAll}
						onToggleOne={selection.toggleOne}
						onSort={projectList.handleSort}
						sortIndicator={projectList.sortIndicator}
					/>
					<AdminProjectsMobileList
						projects={projects}
						isPrivileged={isPrivileged}
						mobileSelectMode={mobileSelection.mobileSelectMode}
						selected={selection.selected}
						selectedCount={selection.selectedIds.length}
						allSelected={selection.allSelected}
						onToggleAll={selection.toggleAll}
						onToggleOne={selection.toggleOne}
						onCardTouchStart={mobileSelection.handleCardTouchStart}
						onCardTouchEnd={mobileSelection.handleCardTouchEnd}
						onExitMobileSelectMode={mobileSelection.exitMobileSelectMode}
					/>
				</>
			)}
			{pagination && (
				<AdminProjectsPagination
					pagination={pagination}
					onPageChange={(page) => projectList.goToPage(page, pagination.totalPages)}
				/>
			)}
		</div>
	);
}
