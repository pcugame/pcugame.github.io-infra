/**
 * Chunked game-file upload widget with progress, retry, and resume.
 * Functional, not pretty — designed for reliability.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/query';
import { getApiErrorMessage } from '../lib/api';
import {
	createGameUploadSession,
	getGameUploadStatus,
	listGameUploadSessions,
	cancelGameUploadSession,
	uploadGameFile,
	type GameUploadSession,
	type GameUploadProgress,
	type GameUploadController,
	type GameUploadStatus,
} from '../lib/api/game-upload';

type UploadState = 'idle' | 'uploading' | 'completing' | 'completed' | 'error' | 'cancelled';

interface Props {
	projectId: string;
}

export default function GameUploadWidget({ projectId }: Props) {
	const qc = useQueryClient();

	const [file, setFile] = useState<File | null>(null);
	const [state, setState] = useState<UploadState>('idle');
	const [progress, setProgress] = useState<GameUploadProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [session, setSession] = useState<GameUploadSession | null>(null);
	const [resumeSession, setResumeSession] = useState<GameUploadStatus | null>(null);
	const controllerRef = useRef<GameUploadController | null>(null);

	// Check for existing resumable session on mount
	useEffect(() => {
		let cancelled = false;
		async function check() {
			try {
				const res = await listGameUploadSessions(projectId);
				if (!cancelled && res.items.length > 0) {
					setResumeSession(res.items[0]);
				}
			} catch { /* ignore */ }
		}
		check();
		return () => { cancelled = true; };
	}, [projectId]);

	const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		const f = e.target.files?.[0] ?? null;
		setFile(f);
		setError(null);
		setResumeSession(null);
	}, []);

	const doUpload = useCallback(async (
		uploadFile: File,
		sess: GameUploadSession,
		uploadedChunks: number[] = [],
	) => {
		setState('uploading');
		setError(null);

		const ctrl = uploadGameFile(uploadFile, sess, (p) => {
			setProgress(p);
			if (p.percent >= 100) setState('completing');
		}, uploadedChunks);
		controllerRef.current = ctrl;

		try {
			await ctrl.start();
			setState('completed');
			// Refresh project detail to show new GAME asset
			qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
		} catch (err) {
			if ((err as Error).message === 'Upload aborted') {
				setState('cancelled');
			} else {
				setError(getApiErrorMessage(err));
				setState('error');
			}
		}
	}, [projectId, qc]);

	const handleStart = useCallback(async () => {
		if (!file) return;
		try {
			const sess = await createGameUploadSession(projectId, file);
			setSession(sess);
			await doUpload(file, sess);
		} catch (err) {
			setError(getApiErrorMessage(err));
			setState('error');
		}
	}, [file, projectId, doUpload]);

	const handleResume = useCallback(async () => {
		if (!resumeSession) return;

		// Need the file to resume — user must re-select the same file
		if (!file) {
			setError('이전 업로드를 재개하려면 동일한 파일을 다시 선택하세요.');
			return;
		}
		if (file.size !== resumeSession.totalBytes) {
			setError(`파일 크기 불일치: 선택한 파일 ${file.size}B vs 세션 ${resumeSession.totalBytes}B. 동일한 파일을 선택하세요.`);
			return;
		}

		try {
			// Fetch latest status to get up-to-date uploaded chunks
			const status = await getGameUploadStatus(resumeSession.sessionId);
			const sess: GameUploadSession = {
				sessionId: status.sessionId,
				chunkSizeBytes: status.chunkSizeBytes,
				totalChunks: status.totalChunks,
				expiresAt: status.expiresAt,
			};
			setSession(sess);
			await doUpload(file, sess, status.uploadedChunks);
		} catch (err) {
			setError(getApiErrorMessage(err));
			setState('error');
		}
	}, [file, resumeSession, doUpload]);

	const handleRetry = useCallback(async () => {
		if (!file || !session) return;
		try {
			// Get current status to know which chunks are done
			const status = await getGameUploadStatus(session.sessionId);
			await doUpload(file, session, status.uploadedChunks);
		} catch (err) {
			setError(getApiErrorMessage(err));
			setState('error');
		}
	}, [file, session, doUpload]);

	const handleAbort = useCallback(() => {
		controllerRef.current?.abort();
	}, []);

	const handleCancel = useCallback(async () => {
		const sid = session?.sessionId ?? resumeSession?.sessionId;
		if (!sid) return;
		try {
			await cancelGameUploadSession(sid);
			setState('cancelled');
			setSession(null);
			setResumeSession(null);
			setProgress(null);
		} catch (err) {
			setError(getApiErrorMessage(err));
		}
	}, [session, resumeSession]);

	const fileSizeMB = file ? (file.size / 1024 / 1024).toFixed(1) : '0';

	return (
		<div style={{ border: '1px solid #444', padding: '16px', borderRadius: '8px', marginTop: '16px' }}>
			<h3 style={{ margin: '0 0 12px' }}>게임 파일 업로드 (대용량 ZIP)</h3>

			{/* Resume banner */}
			{resumeSession && state === 'idle' && (
				<div style={{ background: '#2a2a3a', padding: '12px', borderRadius: '6px', marginBottom: '12px' }}>
					<p style={{ margin: '0 0 8px' }}>
						미완료 업로드가 있습니다: <strong>{resumeSession.originalName}</strong>
						{' '}({resumeSession.uploadedCount}/{resumeSession.totalChunks} 청크 완료)
					</p>
					<p style={{ margin: '0 0 8px', fontSize: '0.85em', opacity: 0.7 }}>
						재개하려면 동일한 파일을 선택 후 "이어올리기" 버튼을 누르세요.
					</p>
				</div>
			)}

			{/* File input */}
			{(state === 'idle' || state === 'error' || state === 'cancelled') && (
				<div style={{ marginBottom: '12px' }}>
					<input
						type="file"
						accept=".zip,application/zip,application/x-zip-compressed"
						onChange={handleFileChange}
					/>
					{file && (
						<p style={{ margin: '4px 0 0', fontSize: '0.9em' }}>
							{file.name} — {fileSizeMB}MB
						</p>
					)}
				</div>
			)}

			{/* Progress bar */}
			{progress && (state === 'uploading' || state === 'completing' || state === 'completed') && (
				<div style={{ marginBottom: '12px' }}>
					<div style={{
						background: '#333',
						borderRadius: '4px',
						overflow: 'hidden',
						height: '24px',
						position: 'relative',
					}}>
						<div style={{
							background: state === 'completed' ? '#4caf50' : '#2196f3',
							height: '100%',
							width: `${progress.percent}%`,
							transition: 'width 0.3s',
						}} />
						<span style={{
							position: 'absolute',
							top: '50%',
							left: '50%',
							transform: 'translate(-50%, -50%)',
							fontSize: '0.8em',
							fontWeight: 'bold',
						}}>
							{progress.percent}% ({progress.uploadedChunks}/{progress.totalChunks})
						</span>
					</div>
					<p style={{ margin: '4px 0 0', fontSize: '0.85em', opacity: 0.7 }}>
						{state === 'completing' && '파일 조립 중…'}
						{state === 'completed' && '업로드 완료!'}
						{state === 'uploading' && `${(progress.uploadedBytes / 1024 / 1024).toFixed(0)}MB / ${(progress.totalBytes / 1024 / 1024).toFixed(0)}MB`}
					</p>
				</div>
			)}

			{/* Error */}
			{error && (
				<div style={{ background: '#3a2020', padding: '8px 12px', borderRadius: '6px', marginBottom: '12px', color: '#f88' }}>
					{error}
				</div>
			)}

			{/* Action buttons */}
			<div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
				{state === 'idle' && file && !resumeSession && (
					<button className="btn btn--primary" onClick={handleStart}>
						업로드 시작
					</button>
				)}

				{state === 'idle' && file && resumeSession && (
					<>
						<button className="btn btn--primary" onClick={handleResume}>
							이어올리기
						</button>
						<button className="btn btn--secondary" onClick={handleStart}>
							새로 시작
						</button>
					</>
				)}

				{state === 'uploading' && (
					<button className="btn btn--danger" onClick={handleAbort}>
						일시정지
					</button>
				)}

				{(state === 'error' || state === 'cancelled') && session && (
					<button className="btn btn--primary" onClick={handleRetry}>
						재시도
					</button>
				)}

				{(state === 'error' || state === 'cancelled') && (session || resumeSession) && (
					<button className="btn btn--danger btn--small" onClick={handleCancel}>
						취소 (세션 삭제)
					</button>
				)}

				{state === 'completed' && (
					<span style={{ color: '#4caf50', fontWeight: 'bold' }}>업로드 완료</span>
				)}
			</div>
		</div>
	);
}
