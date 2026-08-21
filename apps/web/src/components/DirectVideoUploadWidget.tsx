import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getApiErrorMessage } from '../lib/api';
import {
	cancelDirectAssetUploadSession,
	getDirectAssetUploadStatus,
	uploadDirectAssetFile,
	waitForDirectAssetReady,
	type DirectAssetUploadSession,
	type GameUploadProgress,
} from '../lib/api/game-upload';
import { queryKeys } from '../lib/query';

type Phase = 'idle' | 'uploading' | 'verifying' | 'ready' | 'error' | 'cancelled';

interface SavedVideoSession {
	session: DirectAssetUploadSession;
	originalName: string;
	totalBytes: number;
}

interface Props {
	projectId: number;
	initialFiles?: readonly File[];
	autoStart?: boolean;
	onComplete?: () => void;
	onSkip?: () => void;
}

/**
 * Sequential canonical VIDEO uploader.  The server's active (project, VIDEO)
 * fence permits one live multipart session; multiple user-selected videos are
 * therefore intentionally processed in order rather than raced in parallel.
 */
export default function DirectVideoUploadWidget({
	projectId,
	initialFiles = [],
	autoStart = false,
	onComplete,
	onSkip,
}: Props) {
	const qc = useQueryClient();
	const [files, setFiles] = useState<File[]>([...initialFiles]);
	const [phase, setPhase] = useState<Phase>('idle');
	const [progress, setProgress] = useState<GameUploadProgress | null>(null);
	const [completed, setCompleted] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [resumable, setResumable] = useState<SavedVideoSession | null>(null);
	const autoStarted = useRef(false);
	const submitting = useRef(false);
	const storageKey = `pcu.direct-video-upload:${projectId}`;

	const forget = useCallback(() => {
		window.sessionStorage.removeItem(storageKey);
		setResumable(null);
	}, [storageKey]);
	const remember = useCallback((session: DirectAssetUploadSession, file: File) => {
		const value: SavedVideoSession = { session, originalName: file.name, totalBytes: file.size };
		window.sessionStorage.setItem(storageKey, JSON.stringify(value));
		setResumable(value);
	}, [storageKey]);

	useEffect(() => {
		let cancelled = false;
		async function restore() {
			const raw = window.sessionStorage.getItem(storageKey);
			if (!raw) return;
			try {
				const saved = JSON.parse(raw) as SavedVideoSession;
				if (saved.session.kind !== 'VIDEO') throw new Error('kind');
				const status = await getDirectAssetUploadStatus(saved.session.sessionId);
				if (status.kind !== 'VIDEO' || cancelled) return;
				if (status.state === 'VERIFYING') {
					setPhase('verifying');
					await waitForDirectAssetReady(status.sessionId);
					if (!cancelled) {
						forget();
						setPhase('ready');
						qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
						onComplete?.();
					}
					return;
				}
				if (status.state === 'UPLOADING' && !cancelled) setResumable(saved);
				else if (!cancelled) window.sessionStorage.removeItem(storageKey);
			} catch {
				if (!cancelled) window.sessionStorage.removeItem(storageKey);
			}
		}
		void restore();
		return () => { cancelled = true; };
	}, [forget, onComplete, projectId, qc, storageKey]);

	const uploadQueue = useCallback(async (chosen: readonly File[], resume?: SavedVideoSession) => {
		if (submitting.current || chosen.length === 0) return;
		submitting.current = true;
		setError(null);
		try {
			for (let index = 0; index < chosen.length; index += 1) {
				const file = chosen[index]!;
				setPhase('uploading');
				setProgress(null);
				const matchingResume = index === 0 && resume
					&& resume.originalName === file.name && resume.totalBytes === file.size
					? resume.session
					: undefined;
				const completion = await uploadDirectAssetFile(projectId, file, 'VIDEO', (next) => {
					setProgress(next);
					if (next.percent >= 100) setPhase('verifying');
				}, {
					resume: matchingResume,
					onSession: (session) => remember(session, file),
				});
				if (completion.status === 'VERIFYING') {
					setPhase('verifying');
					await waitForDirectAssetReady(completion.sessionId);
				}
				forget();
				setCompleted(index + 1);
			}
			setPhase('ready');
			qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
			onComplete?.();
		} catch (uploadError) {
			setError(getApiErrorMessage(uploadError));
			setPhase('error');
		} finally {
			submitting.current = false;
		}
	}, [forget, onComplete, projectId, qc, remember]);

	useEffect(() => {
		if (!autoStart || autoStarted.current || initialFiles.length === 0) return;
		autoStarted.current = true;
		void uploadQueue(initialFiles);
	}, [autoStart, initialFiles, uploadQueue]);

	const start = () => { void uploadQueue(files, resumable ?? undefined); };
	const retry = () => { void uploadQueue(files, resumable ?? undefined); };
	const cancel = () => {
		if (!resumable) return;
		void cancelDirectAssetUploadSession(resumable.session.sessionId).then(() => {
			forget();
			setPhase('cancelled');
		}).catch((cancelError) => setError(getApiErrorMessage(cancelError)));
	};

	return (
		<div className="game-upload">
			<h3 className="game-upload__title">동영상 업로드</h3>
			{resumable && phase === 'idle' && (
				<p className="field-hint">중단된 동영상 업로드가 있습니다. 동일한 파일을 다시 선택해 재개하세요.</p>
			)}
			{!autoStart && (phase === 'idle' || phase === 'error' || phase === 'cancelled') && (
				<input
					type="file"
					multiple
					accept="video/mp4,video/x-matroska,video/webm,video/x-msvideo,video/x-ms-wmv,.mp4,.mkv,.webm,.avi,.wmv"
					onChange={(event) => {
						setFiles(Array.from(event.target.files ?? []));
						setError(null);
					}}
				/>
			)}
			{files.length > 0 && <p className="file-info">{files.length}개 동영상 선택됨 ({completed}/{files.length} 완료)</p>}
			{progress && (
				<p className="field-hint">
					{phase === 'verifying' ? '동영상 검증 및 재생본 생성 중…' : `${progress.percent}% 업로드`}
				</p>
			)}
			{error && <p className="field-error">{error}</p>}
			<div className="game-upload__actions">
				{phase === 'idle' && files.length > 0 && <button className="btn btn--primary" type="button" onClick={start}>동영상 업로드 시작</button>}
				{phase === 'error' && files.length > 0 && <button className="btn btn--primary" type="button" onClick={retry}>재시도</button>}
				{(phase === 'uploading' || phase === 'error' || phase === 'idle') && resumable && <button className="btn btn--danger btn--small" type="button" onClick={cancel}>취소</button>}
				{phase === 'ready' && <span className="game-upload__complete-text">동영상 업로드 완료</span>}
				{onSkip && phase !== 'uploading' && phase !== 'verifying' && phase !== 'ready' && <button className="btn btn--secondary" type="button" onClick={onSkip}>건너뛰기</button>}
			</div>
		</div>
	);
}
