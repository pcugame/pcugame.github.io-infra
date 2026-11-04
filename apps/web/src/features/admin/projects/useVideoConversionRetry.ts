import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AdminProjectDetail } from '@pcu/contracts';
import { adminProjectApi, getApiErrorMessage } from '../../../lib/api';
import { queryKeys } from '../../../lib/query';

export function useVideoConversionRetry(projectId: number, disabled: boolean) {
	const qc = useQueryClient();
	const inFlight = useRef(false);
	const [busy, setBusy] = useState<number | null>(null);
	const [error, setError] = useState<{ assetId: number; message: string } | null>(null);
	const [notice, setNotice] = useState<{ assetId: number; message: string } | null>(null);
	async function retry(assetId: number) {
		if (inFlight.current || disabled) return;
		inFlight.current = true;
		setBusy(assetId);
		setError(null);
		setNotice(null);
		try {
			await adminProjectApi.retryVideo(projectId, assetId);
			// Remove the failed state immediately, including when the following read fails.
			qc.setQueriesData<AdminProjectDetail>({ queryKey: queryKeys.adminProject(projectId) }, current => {
				if (!current) return current;
				const pending = (video: AdminProjectDetail['video']) => video?.assetId === assetId
					? { ...video, playbackJob: { id: video.playbackJob?.id ?? 'pending', status: 'PENDING' as const } } : video;
				return { ...current, video: pending(current.video), videos: current.videos.map(video => pending(video)!) };
			});
			setNotice({ assetId, message: '변환을 다시 요청했습니다.' });
			await qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
		} catch (cause) {
			setError({ assetId, message: getApiErrorMessage(cause) });
			void qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
		} finally {
			inFlight.current = false;
			setBusy(null);
		}
	}
	return { busy, error, notice, retry, disabled };
}
