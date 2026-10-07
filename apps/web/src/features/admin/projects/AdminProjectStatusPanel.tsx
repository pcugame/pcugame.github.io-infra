import type { ProjectStatus } from '@pcu/contracts';

import { getApiErrorMessage } from '../../../lib/api';

interface AdminProjectStatusPanelProps {
	status: ProjectStatus;
	isPrivileged: boolean;
	isPending: boolean;
	error: unknown;
	onToggle: (status: Exclude<ProjectStatus, 'DRAFT'>) => void;
}

export function AdminProjectStatusPanel({
	status,
	isPrivileged,
	isPending,
	error,
	onToggle,
}: AdminProjectStatusPanelProps) {
	const archived = status === 'ARCHIVED';
	return (
		<div className="project-archive">
			<button
				type="button"
				role="switch"
				aria-label="작품 보관"
				aria-describedby="project-archive-help"
				aria-checked={archived}
				aria-busy={isPending}
				className={`project-archive__switch${!archived ? ' is-active' : ''}${status === 'DRAFT' ? ' is-draft' : ''}`}
				disabled={!isPrivileged || isPending || status === 'DRAFT'}
				onClick={() => onToggle(archived ? 'PUBLISHED' : 'ARCHIVED')}
			>
				{status === 'DRAFT' ? (
					<span className="project-archive__draft">제출 중</span>
				) : (
					<>
						<span className="project-archive__thumb" aria-hidden="true" />
						<span className="project-archive__label project-archive__label--active">일반</span>
						<span className="project-archive__label project-archive__label--archived">보관</span>
					</>
				)}
			</button>
			<p id="project-archive-help" className="field-hint">보관해도 공개 범위는 유지됩니다. 변경사항은 적용 후 반영됩니다.</p>
			{isPending && (
				<span className="field-hint" role="status">
					저장 중…
				</span>
			)}
			{error != null && (
				<p className="field-error" role="alert">
					{getApiErrorMessage(error)}
				</p>
			)}
		</div>
	);
}
