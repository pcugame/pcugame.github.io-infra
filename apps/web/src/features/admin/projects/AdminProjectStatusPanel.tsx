import type { ProjectStatus } from '@pcu/contracts';

import { getApiErrorMessage } from '../../../lib/api';

const STATUS_LABELS: Record<ProjectStatus, string> = {
	PUBLISHED: '공개',
	ARCHIVED: '보관',
};

interface AdminProjectStatusPanelProps {
	status: ProjectStatus;
	isPrivileged: boolean;
	isPending: boolean;
	error: unknown;
	onToggle: (status: ProjectStatus) => void;
}

export function AdminProjectStatusPanel({
	status,
	isPrivileged,
	isPending,
	error,
	onToggle,
}: AdminProjectStatusPanelProps) {
	return (
		<fieldset className="status-section">
			<legend>공개 상태</legend>
			<p>
				현재 상태:{' '}
				<strong>{STATUS_LABELS[status]}</strong>
			</p>
			<div className="form-actions">
				{isPrivileged && status !== 'PUBLISHED' && (
					<button
						className="btn btn--primary btn--small"
						onClick={() => onToggle('PUBLISHED')}
						disabled={isPending}
					>
						공개로 전환
					</button>
				)}
				{status !== 'ARCHIVED' && isPrivileged && (
					<button
						className="btn btn--danger btn--small"
						onClick={() => onToggle('ARCHIVED')}
						disabled={isPending}
					>
						보관
					</button>
				)}
			</div>
			{error != null && (
				<p className="field-error">{getApiErrorMessage(error)}</p>
			)}
		</fieldset>
	);
}
