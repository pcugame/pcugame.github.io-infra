import { MaterialFileRow } from '../../../components/project/editor/MaterialFileRow';
import type { ProjectVideo } from '@pcu/contracts';
import { Button } from '../../../components/ui';
import type { useVideoConversionRetry } from './useVideoConversionRetry';

export function VideoFileRow({ name, assetId, video, conversion, canRetry, canDelete, deleteDisabled, removing, onDelete, material = false, size }: {
	material?: boolean; size?: number; name: string; assetId: number; video?: ProjectVideo;
	conversion: ReturnType<typeof useVideoConversionRetry>;
	canRetry: boolean; canDelete: boolean; deleteDisabled: boolean; removing: boolean; onDelete: () => void;
}) {
	const requesting = conversion.busy === assetId;
	const job = video?.playbackJob;
	const processing = requesting || job?.status === 'PENDING' || job?.status === 'RUNNING' || video?.playbackStatus === 'PENDING';
	const failed = !processing && (job?.status === 'FAILED' || video?.playbackStatus === 'FAILED');
	const ready = !processing && !failed && video?.playbackStatus === 'READY';
	const status = requesting ? '요청 중' : job?.status === 'RUNNING' ? '변환 중' : processing ? '변환 대기' : failed ? '변환 실패' : ready ? '재생 가능' : '상태 확인 중';
	const error = conversion.error?.assetId === assetId ? conversion.error.message : !processing ? job?.error || video?.playbackError : undefined;
	const notice = conversion.notice?.assetId === assetId ? conversion.notice.message : undefined;
 if (material) return <MaterialFileRow name={name} kind="VIDEO" size={size} status={removing ? `${status} · 삭제 예정` : status} error={error} failed={failed || !!error}
  primaryAction={failed && canRetry && video && <Button variant="secondary" size="small" disabled={conversion.disabled || conversion.busy !== null || removing} onClick={() => void conversion.retry(assetId)} aria-label={`${name} 영상 변환 다시 시도`}>재시도</Button>}
  actions={[
   ...(canRetry && video && !processing && !failed ? [{ label: '영상 다시 변환', disabled: conversion.disabled || conversion.busy !== null || removing, onClick: () => { void conversion.retry(assetId); } }] : []),
   ...(canDelete ? [{ label: removing ? '삭제 취소' : '삭제', disabled: deleteDisabled, onClick: onDelete }] : []),
  ]}>{notice && <span role="status">{notice}</span>}</MaterialFileRow>;
	return <li className="studio-video-row" data-video-asset-id={assetId}>
		<p className="studio-video-row__name" title={name}><strong>{name}</strong>{removing && ' · 삭제 예정'}</p>
		<div className="studio-video-row__controls">
			<span className="studio-video-row__status" data-state={processing ? 'processing' : failed ? 'failed' : ready ? 'ready' : 'unknown'} role="status" title={notice}>{status}</span>
			{canRetry && video && !processing && <Button variant="secondary" size="small" disabled={conversion.disabled || conversion.busy !== null || removing}
				onClick={() => void conversion.retry(assetId)} aria-label={`${name} 영상 변환 다시 시도`}>다시 변환</Button>}
		</div>
		{canDelete && <Button variant="secondary" size="small" disabled={deleteDisabled} onClick={onDelete} className="studio-video-row__delete">{removing ? '삭제 취소' : '삭제'}</Button>}
		{error && <details className="studio-video-row__error" open={conversion.error?.assetId === assetId}>
            <summary>실패 이유</summary><p role="alert">{error}</p>
        </details>}
	</li>;
}
