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
	const published = status === 'PUBLISHED';
	return (
		<div className="project-visibility">
			<button
				type="button"
				role="switch"
				aria-label="작품 공개"
				aria-checked={published}
				aria-busy={isPending}
				className={`project-visibility__switch${published ? ' is-public' : ''}${status === 'DRAFT' ? ' is-draft' : ''}`}
				disabled={!isPrivileged || isPending || status === 'DRAFT'}
				onClick={() => onToggle(published ? 'ARCHIVED' : 'PUBLISHED')}
			>
				{status === 'DRAFT' ? (
					<span className="project-visibility__draft">제출 중</span>
				) : (
					<>
						<span className="project-visibility__thumb" aria-hidden="true" />
						<span className="project-visibility__label project-visibility__label--public">공개</span>
						<span className="project-visibility__label project-visibility__label--private">비공개</span>
					</>
				)}
			</button>
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
