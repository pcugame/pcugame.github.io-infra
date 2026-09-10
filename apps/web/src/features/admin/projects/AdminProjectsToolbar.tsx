import type { ProjectStatus } from '../../../contracts';
import type { AdminProjectStatusFilter } from './useAdminProjectList';

const STATUS_LABELS: Record<ProjectStatus, string> = {
	DRAFT: '초안',
	PUBLISHED: '공개',
	ARCHIVED: '보관',
};

interface AdminProjectsToolbarProps {
	statusFilter: AdminProjectStatusFilter;
	search: string;
	selectedCount: number;
	isPrivileged: boolean;
	isAdmin: boolean;
	isBusy: boolean;
	isDeleting: boolean;
	onStatusFilter: (status: AdminProjectStatusFilter) => void;
	onSearchChange: (value: string) => void;
	onCompositionStart: () => void;
	onCompositionEnd: (value: string) => void;
	onBulkStatus: (status: Exclude<ProjectStatus, 'DRAFT'>) => void;
	onBulkDelete: () => void;
}

export function AdminProjectsToolbar({
	statusFilter,
	search,
	selectedCount,
	isPrivileged,
	isAdmin,
	isBusy,
	isDeleting,
	onStatusFilter,
	onSearchChange,
	onCompositionStart,
	onCompositionEnd,
	onBulkStatus,
	onBulkDelete,
}: AdminProjectsToolbarProps) {
	return (
		<>
			<div className="admin-filter-tabs">
				{(['ALL', 'PUBLISHED', 'ARCHIVED'] as const).map((s) => (
					<button
						key={s}
						className={`admin-filter-tab ${statusFilter === s ? 'admin-filter-tab--active' : ''}`}
						onClick={() => onStatusFilter(s)}
					>
						{s === 'ALL' ? '전체' : STATUS_LABELS[s]}
					</button>
				))}
			</div>

			<div className="admin-toolbar">
				<input
					type="text"
					className="admin-search"
					placeholder="작품 제목, 요약, 이름, 학번, 전시회명, 연도 검색..."
					value={search}
					onChange={(e) => onSearchChange(e.target.value)}
					onCompositionStart={onCompositionStart}
					onCompositionEnd={(e) => onCompositionEnd((e.target as HTMLInputElement).value)}
				/>
				{isPrivileged && selectedCount > 0 && (
					<div className="admin-bulk-actions">
						<span className="admin-bulk-actions__count">{selectedCount}개 선택</span>
						<button
							className="btn btn--small btn--secondary"
							disabled={isBusy}
							onClick={() => onBulkStatus('PUBLISHED')}
						>
							공개
						</button>
						<button
							className="btn btn--small btn--secondary"
							disabled={isBusy}
							onClick={() => onBulkStatus('ARCHIVED')}
						>
							보관
						</button>
						{isAdmin && (
							<button
								className="btn btn--small btn--danger"
								disabled={isBusy}
								onClick={onBulkDelete}
							>
								{isDeleting ? '삭제 중...' : '삭제'}
							</button>
						)}
					</div>
				)}
			</div>
		</>
	);
}
