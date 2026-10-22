import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AdminProjectDetail } from '@pcu/contracts';
import { adminProjectApi, getApiErrorMessage } from '../../../lib/api';
import { queryKeys } from '../../../lib/query';

export function AdminVideoRetryPanel({ project, disabled }: { project: AdminProjectDetail; disabled: boolean }) {
	const qc = useQueryClient();
	const inFlight = useRef(false);
	const [busy, setBusy] = useState<number | null>(null);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	if (!project.videos.length) return null;
	async function retry(assetId: number) {
		if (inFlight.current || disabled) return;
		inFlight.current = true;
		setBusy(assetId);
		setError('');
		setNotice('');
		try {
			await adminProjectApi.retryVideo(project.id, assetId);
			// Remove the failed state immediately, including when the following read fails.
			qc.setQueriesData<AdminProjectDetail>({ queryKey: queryKeys.adminProject(project.id) }, current => {
				if (!current) return current;
				const pending = (video: AdminProjectDetail['video']) => video?.assetId === assetId
					? { ...video, playbackJob: { id: video.playbackJob?.id ?? 'pending', status: 'PENDING' as const } } : video;
				return { ...current, video: pending(current.video), videos: current.videos.map(video => pending(video)!) };
			});
			setNotice('영상 변환을 다시 요청했습니다. 완료되면 상태가 갱신됩니다.');
			await qc.invalidateQueries({ queryKey: queryKeys.adminProject(project.id) });
		} catch (cause) {
			setError(getApiErrorMessage(cause));
			void qc.invalidateQueries({ queryKey: queryKeys.adminProject(project.id) });
		} finally {
			inFlight.current = false;
			setBusy(null);
		}
	}
	return <section className="admin-card" aria-label="동영상 변환 관리">
		<h3>동영상 변환 관리</h3>
		{project.videos.map((video, index) => <div key={video.assetId}>
			<p>{project.assets.find(asset => asset.id === video.assetId)?.originalName ?? `동영상 ${index + 1}`} · {video.playbackStatus === 'FAILED' ? '변환 실패' : video.playbackStatus === 'READY' ? '재생 가능' : '변환 대기 또는 처리 중'}</p>
			{video.playbackJob && <p>재생본 작업: {video.playbackJob.status}{video.playbackJob.error ? ` · ${video.playbackJob.error}` : ''}</p>}
            {video.playbackStatus !== 'PENDING' && video.playbackJob?.status !== 'PENDING' && video.playbackJob?.status !== 'RUNNING' && <>
				{video.playbackError && <p>{video.playbackError}</p>}
				<button type="button" className="btn btn--secondary" disabled={disabled || busy !== null} onClick={() => void retry(video.assetId)}>
					{busy === video.assetId ? '재시도 요청 중…' : '영상 변환 다시 시도'}
				</button>
			</>}
		</div>)}
		{notice && <p role="status">{notice}</p>}
		{error && <p className="field-error" role="alert">{error}</p>}
	</section>;
}
