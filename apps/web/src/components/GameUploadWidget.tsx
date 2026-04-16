/**
 * Chunked game-file upload widget with progress, retry, and resume.
 * Used in both project creation and project edit pages.
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
	projectId: number;
	/** Pre-selected file (e.g. from the creation form) */
	initialFile?: File | null;
	/** Auto-start upload on mount when initialFile is provided */
	autoStart?: boolean;
	/** Called when upload completes */
	onComplete?: () => void;
	/** Called when the user skips / aborts */
	onSkip?: () => void;
}

export default function GameUploadWidget({ projectId, initialFile, autoStart, onComplete, onSkip }: Props) {
	const qc = useQueryClient();

	const [file, setFile] = useState<File | null>(initialFile ?? null);
	const [state, setState] = useState<UploadState>('idle');
	const [progress, setProgress] = useState<GameUploadProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [session, setSession] = useState<GameUploadSession | null>(null);
	const [resumeSession, setResumeSession] = useState<GameUploadStatus | null>(null);
	const controllerRef = useRef<GameUploadController | null>(null);
	const autoStartedRef = useRef(false);

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
			qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
			onComplete?.();
		} catch (err) {
			if ((err as Error).message === 'Upload aborted') {
				setState('cancelled');
			} else {
				setError(getApiErrorMessage(err));
				setState('error');
			}
		}
	}, [projectId, qc, onComplete]);

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

	// Auto-start on mount when initialFile + autoStart are provided
	useEffect(() => {
		if (autoStart && initialFile && !autoStartedRef.current) {
			autoStartedRef.current = true;
			// Defer to avoid synchronous setState within effect body
			const id = setTimeout(() => handleStart(), 0);
			return () => clearTimeout(id);
		}
	}, [autoStart, initialFile, handleStart]);

	const handleResume = useCallback(async () => {
		if (!resumeSession) return;

		if (!file) {
			setError('이전 업로드를 재개하려면 동일한 파일을 다시 선택하세요.');
			return;
		}
		if (file.size !== resumeSession.totalBytes) {
			setError(`파일 크기 불일치: 선택한 파일 ${file.size}B vs 세션 ${resumeSession.totalBytes}B. 동일한 파일을 선택하세요.`);
			return;
		}

		try {
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
		<div className="game-upload">
			<h3 className="game-upload__title">게임 파일 업로드 (ZIP 파일)</h3>

			{/* Resume banner */}
			{resumeSession && state === 'idle' && (
				<div className="game-upload__resume-banner">
					<p className="game-upload__resume-text">
						미완료 업로드가 있습니다: <strong>{resumeSession.originalName}</strong>
						{' '}({resumeSession.uploadedCount}/{resumeSession.totalChunks} 청크 완료)
					</p>
					<p className="game-upload__resume-hint">
						재개하려면 동일한 파일을 선택 후 "이어올리기" 버튼을 누르세요.
					</p>
				</div>
			)}

			{/* File input */}
			{(state === 'idle' || state === 'error' || state === 'cancelled') && (
				<div className="game-upload__file-input">
					<input
						type="file"
						accept=".zip,application/zip,application/x-zip-compressed"
						onChange={handleFileChange}
					/>
					{file && (
						<p className="file-info">
							{file.name} — {fileSizeMB}MB
						</p>
					)}
				</div>
			)}

			{/* Progress bar */}
			{progress && (state === 'uploading' || state === 'completing' || state === 'completed') && (
				<div className="game-upload__progress-wrap">
					<div className="game-upload__progress-track">
						<div
							className={`game-upload__progress-bar ${state === 'completed' ? 'game-upload__progress-bar--done' : ''}`}
							style={{ width: `${progress.percent}%` }}
						/>
						<span className="game-upload__progress-label">
							{progress.percent}% ({progress.uploadedChunks}/{progress.totalChunks})
						</span>
					</div>
					<p className="game-upload__progress-status">
						{state === 'completing' && '파일 조립 중…'}
						{state === 'completed' && '업로드 완료!'}
						{state === 'uploading' && `${(progress.uploadedBytes / 1024 / 1024).toFixed(0)}MB / ${(progress.totalBytes / 1024 / 1024).toFixed(0)}MB`}
					</p>
				</div>
			)}

			{/* Error */}
			{error && (
				<div className="game-upload__error">
					{error}
				</div>
			)}

			{/* Action buttons */}
			<div className="game-upload__actions">
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
					<span className="game-upload__complete-text">업로드 완료</span>
				)}

				{onSkip && state !== 'completed' && (
					<button className="btn btn--secondary" onClick={onSkip}>
						건너뛰기
					</button>
				)}
			</div>
		</div>
	);
}
