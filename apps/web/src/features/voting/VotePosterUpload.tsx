import { useEffect, useRef, useState } from 'react';
import {
	getDirectAssetUploadStatus,
	uploadDirectAssetFile,
	waitForDirectAssetReady,
	type DirectAssetUploadSession,
} from '../../lib/api/game-upload';
import { getApiErrorMessage } from '../../lib/api';
export function VotePosterUpload({
	voteId,
	exhibitionId,
	onReady,
}: {
	voteId: string;
	exhibitionId: number;
	onReady: (id: string) => void;
}) {
	const key = `pcu.vote-poster:${voteId}`;
	const uploadController = useRef<AbortController | null>(null);
	useEffect(() => () => uploadController.current?.abort(), []);
	const [session, setSession] = useState<DirectAssetUploadSession | null>(() => {
		try {
			const s = sessionStorage.getItem(key);
			return s ? JSON.parse(s) : null;
		} catch {
			return null;
		}
	});
	const [busy, setBusy] = useState(false),
		[error, setError] = useState(''),
		[status, setStatus] = useState('');
	useEffect(() => {
		if (!session) return;
		const controller = new AbortController();
		void getDirectAssetUploadStatus(session.sessionId)
			.then(async (s) => {
				if (s.state === 'VERIFYING' || s.state === 'COMPLETING') {
					setStatus('포스터 처리 중…');
					await waitForDirectAssetReady(s.sessionId, { signal: controller.signal });
				} else if (s.state !== 'READY') {
					setStatus('이전 업로드를 이어가려면 같은 파일을 선택해 주세요.');
					return;
				}
				if (!controller.signal.aborted) {
					onReady(s.sessionId);
					setStatus('포스터가 준비되었습니다.');
					setSession(null);
					sessionStorage.removeItem(key);
				}
			})
			.catch((e) => {
				if (!controller.signal.aborted) setError(getApiErrorMessage(e));
			});
		return () => controller.abort();
	}, [session, onReady, key]);
	async function upload(file: File) {
		setBusy(true);
		setError('');
		const controller = new AbortController();
		uploadController.current = controller;
		try {
			const result = await uploadDirectAssetFile(
				{ type: 'EXHIBITION', id: exhibitionId },
				file,
				'POSTER',
				(p) => setStatus(`업로드 ${Math.round(p.percent)}%`),
				{
					voteId,
					signal: controller.signal,
					resume: session ?? undefined,
					onSession: (s) => {
						sessionStorage.setItem(key, JSON.stringify(s));
						setSession(s);
					},
				},
			);
			await waitForDirectAssetReady(result.sessionId, { signal: controller.signal });
			if (controller.signal.aborted) return;
			onReady(result.sessionId);
			setSession(null);
			sessionStorage.removeItem(key);
			setStatus('포스터가 준비되었습니다.');
		} catch (e) {
			if (!controller.signal.aborted) setError(getApiErrorMessage(e));
		} finally {
			setBusy(false);
		}
	}
	return (
		<div>
			<label>
				투표 전용 포스터 업로드
				<input
					type="file"
					accept="image/jpeg,image/png,image/webp,application/pdf"
					disabled={busy}
					onChange={(e) => {
						const file = e.target.files?.[0];
						if (file) void upload(file);
					}}
				/>
			</label>
			<p>이 이미지를 투표 화면에 공개합니다. 작품·전시회 원본 포스터는 변경하지 않습니다.</p>
			<p role="status">{status}</p>
			{error && <p role="alert">{error}</p>}
		</div>
	);
}
