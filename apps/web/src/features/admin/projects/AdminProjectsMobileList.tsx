import { Link } from 'react-router-dom';
import type { AdminProjectItem, ProjectStatus } from '../../../contracts';

const STATUS_LABELS: Record<ProjectStatus, string> = {
	PUBLISHED: '공개',
	ARCHIVED: '보관',
};

const STATUS_COLORS: Record<ProjectStatus, string> = {
	PUBLISHED: 'badge--published',
	ARCHIVED: 'badge--archived',
};

interface AdminProjectsMobileListProps {
	projects: AdminProjectItem[];
	isPrivileged: boolean;
	mobileSelectMode: boolean;
	selected: Set<number>;
	selectedCount: number;
	allSelected: boolean;
	onToggleAll: () => void;
	onToggleOne: (id: number) => void;
	onCardTouchStart: (id: number) => void;
	onCardTouchEnd: () => void;
	onExitMobileSelectMode: () => void;
}

export function AdminProjectsMobileList({
	projects,
	isPrivileged,
	mobileSelectMode,
	selected,
	selectedCount,
	allSelected,
	onToggleAll,
	onToggleOne,
	onCardTouchStart,
	onCardTouchEnd,
	onExitMobileSelectMode,
}: AdminProjectsMobileListProps) {
	return (
		<div className={`admin-mobile-cards ${mobileSelectMode ? 'admin-mobile-cards--selecting' : ''}`}>
			{isPrivileged && mobileSelectMode && (
				<div className="admin-mobile-select-bar">
					<button className="admin-mobile-select-bar__all" onClick={onToggleAll}>
						{allSelected ? '전체 해제' : '전체 선택'}
					</button>
					<span className="admin-mobile-select-bar__count">{selectedCount}개 선택됨</span>
					<button className="admin-mobile-select-bar__cancel" onClick={onExitMobileSelectMode}>
						취소
					</button>
				</div>
			)}
			{projects.map((p) => (
				<div
					key={p.id}
					className={`admin-pcard ${selected.has(p.id) ? 'admin-pcard--selected' : ''}`}
					onTouchStart={isPrivileged ? () => onCardTouchStart(p.id) : undefined}
					onTouchEnd={isPrivileged ? onCardTouchEnd : undefined}
					onTouchMove={isPrivileged ? onCardTouchEnd : undefined}
					onMouseDown={isPrivileged ? () => onCardTouchStart(p.id) : undefined}
					onMouseUp={isPrivileged ? onCardTouchEnd : undefined}
					onMouseLeave={isPrivileged ? onCardTouchEnd : undefined}
					onClick={isPrivileged && mobileSelectMode ? () => onToggleOne(p.id) : undefined}
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
	);
}
