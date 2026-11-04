import { ProgressBar } from '../ui';
import { usePreventWindowClose } from './usePreventWindowClose';

interface UploadProgressModalProps {
	open: boolean;
	title: string;
	percent?: number | null;
	loadedBytes?: number;
	totalBytes?: number;
	status?: string;
}

function formatBytes(bytes?: number): string {
	if (!bytes || bytes <= 0) return '';
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
	return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

export function UploadProgressModal({
	open,
	title,
	percent,
	loadedBytes,
	totalBytes,
	status,
}: UploadProgressModalProps) {
	usePreventWindowClose(open);

	if (!open) return null;

	const safePercent = Math.max(0, Math.min(100, percent ?? 0));
	const hasKnownTotal = totalBytes != null && totalBytes > 0;

	return (
		<div className="upload-progress-modal" role="presentation">
			<div className="upload-progress-modal__panel" role="dialog" aria-modal="true" aria-label={title}>
				<div className="upload-progress-modal__head">
					<strong>{title}</strong>
					<span>진행 중</span>
				</div>
				<ProgressBar className="upload-progress-modal__progress" aria-label={title} value={hasKnownTotal ? safePercent : undefined} />
				<div className="upload-progress-modal__meta">
					<span>{hasKnownTotal ? `${safePercent}%` : '전송 준비 중'}</span>
					{hasKnownTotal && (
						<span>
							{formatBytes(loadedBytes)} / {formatBytes(totalBytes)}
						</span>
					)}
				</div>
				<p className="upload-progress-modal__status">
					{status ?? '업로드가 끝날 때까지 이 창을 닫거나 새로고침하지 마세요.'}
				</p>
			</div>
		</div>
	);
}
