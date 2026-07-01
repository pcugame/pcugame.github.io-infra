import type { AdminProjectListResponse } from '../../../contracts';

interface AdminProjectsPaginationProps {
	pagination: AdminProjectListResponse['pagination'];
	onPageChange: (page: number) => void;
}

export function AdminProjectsPagination({
	pagination,
	onPageChange,
}: AdminProjectsPaginationProps) {
	return (
		<div className="admin-pagination">
			<span className="admin-pagination__summary">
				총 {pagination.totalItems.toLocaleString('ko-KR')}개
			</span>
			<div className="admin-pagination__controls">
				<button
					type="button"
					className="btn btn--small btn--secondary"
					disabled={!pagination.hasPreviousPage}
					onClick={() => onPageChange(pagination.page - 1)}
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
					onClick={() => onPageChange(pagination.page + 1)}
				>
					다음
				</button>
			</div>
		</div>
	);
}
