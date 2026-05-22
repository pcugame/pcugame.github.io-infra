import { useMemo, useSyncExternalStore } from 'react';
import { usePreventWindowClose } from '../../components/common';
import {
	failUpload,
	finishUpload,
	getUploadSnapshot,
	getVisibleUploadTask,
	startUpload,
	subscribeToUploads,
	updateUpload,
} from './store';
import { UploadManagerContext } from './context';
import type { UploadManager } from './context';
import type { UploadTask } from './types';

function formatBytes(bytes?: number): string {
	if (!bytes || bytes <= 0) return '';
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
	return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function phaseLabel(task: UploadTask): string {
	switch (task.phase) {
		case 'preparing':
			return '준비 중';
		case 'uploading':
			return '업로드 중';
		case 'processing':
			return '서버 처리 중';
		case 'completing':
			return '완료 중';
		case 'done':
			return '완료';
		case 'error':
			return '오류';
		default:
			return '진행 중';
	}
}

function statusMessage(task: UploadTask): string {
	if (task.phase === 'error') {
		return task.errorMessage ?? '업로드 중 오류가 발생했습니다.';
	}
	if (task.phase === 'processing') {
		return task.processingMessage ?? '서버 처리 중입니다. 이 창을 닫거나 새로고침하지 마세요.';
	}
	if (task.phase === 'completing' || task.phase === 'done') {
		return '업로드를 마무리하고 있습니다.';
	}
	return '업로드가 끝날 때까지 이 창을 닫거나 새로고침하지 마세요.';
}

function UploadOverlay() {
	useSyncExternalStore(subscribeToUploads, getUploadSnapshot, getUploadSnapshot);
	const task = getVisibleUploadTask();
	const open = task !== null;

	usePreventWindowClose(open);

	if (!task) return null;

	const hasKnownTotal = task.totalBytes > 0;
	const barPercent = hasKnownTotal ? task.percent : 32;

	return (
		<div className="upload-progress-modal" role="presentation">
			<div
				className="upload-progress-modal__panel"
				role="dialog"
				aria-modal="true"
				aria-label={task.title}
			>
				<div className="upload-progress-modal__head">
					<strong>{task.title}</strong>
					<span>{phaseLabel(task)}</span>
				</div>
				<div className="upload-progress-modal__bar-track" aria-hidden="true">
					<div
						className="upload-progress-modal__bar-fill"
						style={{ width: `${barPercent}%` }}
					/>
				</div>
				<div className="upload-progress-modal__meta">
					<span>{hasKnownTotal ? `${task.percent}%` : phaseLabel(task)}</span>
					{hasKnownTotal && (
						<span>
							{formatBytes(task.loadedBytes)} / {formatBytes(task.totalBytes)}
						</span>
					)}
				</div>
				<p className="upload-progress-modal__status">{statusMessage(task)}</p>
			</div>
		</div>
	);
}

export function UploadProvider({ children }: { children: React.ReactNode }) {
	const manager = useMemo<UploadManager>(
		() => ({
			startUpload,
			updateUpload,
			finishUpload,
			failUpload,
		}),
		[],
	);

	return (
		<UploadManagerContext.Provider value={manager}>
			{children}
			<UploadOverlay />
		</UploadManagerContext.Provider>
	);
}
