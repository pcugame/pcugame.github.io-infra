/** Direct Garage multipart uploader for project GAME and WEBGL sources. */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/query';
import { getApiErrorMessage } from '../lib/api';
import {
	cancelGameUploadSession,
	cancelDirectAssetUploadSession,
	createGameUploadSession,
	getGameUploadStatus,
	getDirectAssetUploadStatus,
	listGameUploadSessions,
	uploadGameFile,
	uploadDirectAssetFile,
	waitForDirectAssetReady,
	type GameUploadController,
	type GameUploadProgress,
	type GameUploadSession,
	type GameUploadStatus,
	type DirectAssetUploadSession,
} from '../lib/api/game-upload';
import type { UploadKind } from '../contracts';

type UploadState = 'idle' | 'uploading' | 'verifying' | 'completed' | 'error';
type LegacyUploadState = 'idle' | 'uploading' | 'completing' | 'completed' | 'error' | 'cancelled';

interface Props {
	projectId: number;
	initialFile?: File | null;
	autoStart?: boolean;
	onComplete?: () => void;
	onSkip?: () => void;
	uploadKind?: UploadKind;
}

export default function GameUploadWidget({
	projectId,
	initialFile,
	autoStart,
	onComplete,
	onSkip,
	uploadKind = 'GAME',
}: Props) {
	const qc = useQueryClient();
	const isWebgl = uploadKind === 'WEBGL';
	const labels = isWebgl
		? { title: 'WebGL 빌드 업로드 (ZIP 파일)', uploadTitle: 'WebGL 빌드 업로드', noun: 'WebGL 빌드' }
		: { title: '게임 파일 업로드 (ZIP 파일)', uploadTitle: '게임 파일 업로드', noun: '게임 파일' };
	const [file, setFile] = useState<File | null>(initialFile ?? null);
	const [state, setState] = useState<UploadState>('idle');
	const [progress, setProgress] = useState<GameUploadProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [session, setSession] = useState<DirectAssetUploadSession | null>(null);
	const [sessionRestored, setSessionRestored] = useState(false);
	const [legacyState, setLegacyState] = useState<LegacyUploadState>('idle');
	const [legacyProgress, setLegacyProgress] = useState<GameUploadProgress | null>(null);
	const [legacyError, setLegacyError] = useState<string | null>(null);
	const [legacySession, setLegacySession] = useState<GameUploadSession | null>(null);
	const [legacyResumeSession, setLegacyResumeSession] = useState<GameUploadStatus | null>(null);
	const legacyControllerRef = useRef<GameUploadController | null>(null);
	const legacySubmittingRef = useRef(false);
	const mountedRef = useRef(true);
	const sessionRef = useRef<DirectAssetUploadSession | null>(null);
	const submittingRef = useRef(false);
	const cancellingRef = useRef(false);
	const runTokenRef = useRef(0);
	const runRef = useRef<{ token: number; controller: AbortController } | null>(null);
	const restoreControllerRef = useRef<AbortController | null>(null);
	const autoStartedRef = useRef(false);
	const autoPausedRef = useRef(false);
	const pausedRunTokenRef = useRef<number | null>(null);
	const cancelIntentRunTokenRef = useRef<number | null>(null);
	const lateCancelSessionIdRef = useRef<string | null>(null);
	const directSessionStorageKey = `pcu.direct-asset-upload:${projectId}:${uploadKind}`;

	const rememberSession = useCallback((next: DirectAssetUploadSession, updateUi = true) => {
		sessionRef.current = next;
		window.sessionStorage.setItem(directSessionStorageKey, JSON.stringify(next));
		if (updateUi && mountedRef.current) setSession(next);
	}, [directSessionStorageKey]);
	const forgetSession = useCallback((expectedSessionId?: string) => {
		if (expectedSessionId && sessionRef.current?.sessionId !== expectedSessionId) return false;
		sessionRef.current = null;
		window.sessionStorage.removeItem(directSessionStorageKey);
		if (mountedRef.current) setSession(null);
		return true;
	}, [directSessionStorageKey]);
	const isCurrentRun = useCallback((token: number) => (
		mountedRef.current && runRef.current?.token === token
	), []);
	const beginRun = useCallback(() => {
		if (submittingRef.current || legacySubmittingRef.current || cancellingRef.current || !mountedRef.current) return null;
		const controller = new AbortController();
		const token = ++runTokenRef.current;
		pausedRunTokenRef.current = null;
		runRef.current = { token, controller };
		submittingRef.current = true;
		return { token, controller };
	}, []);
	const abortActiveRun = useCallback(() => {
		const active = runRef.current;
		if (active) {
			runTokenRef.current += 1;
			runRef.current = null;
			submittingRef.current = false;
			active.controller.abort();
		}
		restoreControllerRef.current?.abort();
		restoreControllerRef.current = null;
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			abortActiveRun();
		};
	}, [abortActiveRun]);

	useEffect(() => {
		let cancelled = false;
		async function restoreLegacySession() {
			try {
				const response = await listGameUploadSessions(projectId, uploadKind);
				if (!cancelled && response.items.length > 0) setLegacyResumeSession(response.items[0]);
			} catch { /* Legacy discovery must not block the direct uploader. */ }
		}
		void restoreLegacySession();
		return () => { cancelled = true; };
	}, [projectId, uploadKind]);

	useEffect(() => {
		let cancelled = false;
		const polling = new AbortController();
		restoreControllerRef.current = polling;
		async function restoreSession() {
			const raw = window.sessionStorage.getItem(directSessionStorageKey);
			if (!raw) return;
			let keepForBackgroundVerification = false;
			let candidate: DirectAssetUploadSession | null = null;
			try {
				candidate = JSON.parse(raw) as DirectAssetUploadSession;
				if (candidate.kind !== uploadKind) throw new Error('asset upload kind mismatch');
				rememberSession(candidate);
				const status = await getDirectAssetUploadStatus(candidate.sessionId, polling.signal);
				if (!cancelled && status.state === 'UPLOADING' && status.generation === candidate.generation) {
					rememberSession(candidate);
					return;
				}
				if (!cancelled && ['COMPLETING', 'VERIFYING'].includes(status.state) && status.generation === candidate.generation) {
					keepForBackgroundVerification = true;
					rememberSession(candidate);
					setState('verifying');
					await waitForDirectAssetReady(candidate.sessionId, { signal: polling.signal });
					if (!cancelled) {
						forgetSession(candidate.sessionId);
						setState('completed');
						qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
						onComplete?.();
					}
					return;
				}
				if (!cancelled && status.state === 'READY' && status.generation === candidate.generation) {
					forgetSession();
					setState('completed');
					qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
					onComplete?.();
					return;
				}
				if (!cancelled && status.state === 'CANCELLED') {
					forgetSession(candidate.sessionId);
					autoStartedRef.current = true;
					setProgress(null);
					setError(null);
					setState('idle');
					return;
				}
				if (!cancelled && (status.state === 'REJECTED' || status.state === 'EXPIRED')) {
					rememberSession(candidate);
					setError(`업로드 세션이 ${status.state.toLowerCase()} 상태입니다.`);
					setState('idle');
				}
			} catch (cause) {
				if (cancelled || polling.signal.aborted) return;
				if (keepForBackgroundVerification) {
					setError(getApiErrorMessage(cause));
					setState('error');
					return;
				}
				// Keep the opaque locator when status is unavailable; only cancellation
				// confirmation or a known successful completion may remove it.
			}
		}
		void restoreSession().finally(() => {
			if (!cancelled) setSessionRestored(true);
		});
		return () => {
			cancelled = true;
			polling.abort();
			if (restoreControllerRef.current === polling) restoreControllerRef.current = null;
		};
	}, [directSessionStorageKey, forgetSession, onComplete, projectId, qc, rememberSession, uploadKind]);

	const handleFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
		setFile(event.target.files?.[0] ?? null);
		setError(null);
		setLegacyError(null);
	}, []);

	const runLegacyUpload = useCallback(async (
		uploadFile: File,
		candidate: GameUploadSession,
		uploadedChunks: number[] = [],
	) => {
		setLegacyState('uploading');
		setLegacyError(null);
		const controller = uploadGameFile(uploadFile, candidate, {
			title: labels.uploadTitle,
			startFrom: uploadedChunks,
			onProgress: (next) => {
				setLegacyProgress(next);
				if (next.percent >= 100) setLegacyState('completing');
			},
		});
		legacyControllerRef.current = controller;
		try {
			await controller.start();
			setLegacyState('completed');
			qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
			onComplete?.();
		} catch (cause) {
			if ((cause as Error).message === 'Upload aborted') setLegacyState('cancelled');
			else {
				setLegacyError(getApiErrorMessage(cause));
				setLegacyState('error');
			}
		} finally {
			if (legacyControllerRef.current === controller) legacyControllerRef.current = null;
		}
	}, [labels.uploadTitle, onComplete, projectId, qc]);

	const waitForSessionReady = useCallback(async (
		candidate: DirectAssetUploadSession,
		activeRun = beginRun(),
	) => {
		if (!activeRun) return;
		const { token, controller } = activeRun;
		setState('verifying');
		setError(null);
		try {
			await waitForDirectAssetReady(candidate.sessionId, { signal: controller.signal });
			if (!isCurrentRun(token)) return;
			forgetSession(candidate.sessionId);
			setState('completed');
			qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
			onComplete?.();
		} catch (cause) {
			if (!isCurrentRun(token) || controller.signal.aborted) return;
			setError(getApiErrorMessage(cause));
			setState('error');
		} finally {
			if (runRef.current?.token === token) {
				runRef.current = null;
				submittingRef.current = false;
			}
		}
	}, [beginRun, forgetSession, isCurrentRun, onComplete, projectId, qc]);

	const cancelLateCreatedSession = useCallback(async (candidate: DirectAssetUploadSession, sourceToken: number) => {
		if (lateCancelSessionIdRef.current === candidate.sessionId) return;
		lateCancelSessionIdRef.current = candidate.sessionId;
		cancellingRef.current = true;
		let verificationCandidate: DirectAssetUploadSession | null = null;
		try {
			await cancelDirectAssetUploadSession(candidate.sessionId);
			forgetSession(candidate.sessionId);
			if (mountedRef.current) {
				setProgress(null);
				setError(null);
				setState('idle');
			}
		} catch (cause) {
			try {
				const status = await getDirectAssetUploadStatus(candidate.sessionId);
				if (!mountedRef.current) return;
				if (status.state === 'CANCELLED') {
					forgetSession(candidate.sessionId);
					setProgress(null);
					setError(null);
					setState('idle');
				} else if (status.state === 'READY') {
					forgetSession(candidate.sessionId);
					setState('completed');
					qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
					onComplete?.();
				} else if (status.state === 'COMPLETING' || status.state === 'VERIFYING') {
					rememberSession(candidate);
					verificationCandidate = candidate;
				} else {
					rememberSession(candidate);
					if (status.state === 'REJECTED' || status.state === 'EXPIRED') setError(`업로드 세션이 ${status.state.toLowerCase()} 상태입니다.`);
					setState('idle');
				}
			} catch {
				if (mountedRef.current) {
					setError(getApiErrorMessage(cause));
					setState('idle');
				}
			}
		} finally {
			cancellingRef.current = false;
			if (cancelIntentRunTokenRef.current === sourceToken) cancelIntentRunTokenRef.current = null;
			if (verificationCandidate && mountedRef.current) void waitForSessionReady(verificationCandidate);
		}
	}, [forgetSession, onComplete, projectId, qc, rememberSession, waitForSessionReady]);

	const runUpload = useCallback(async (
		uploadFile: File,
		resume?: DirectAssetUploadSession,
		activeRun = beginRun(),
	) => {
		if (!activeRun) return;
		const { token, controller } = activeRun;
		setState('uploading');
		setError(null);
		try {
			const completion = await uploadDirectAssetFile(projectId, uploadFile, uploadKind, (next) => {
				if (!isCurrentRun(token)) return;
				setProgress(next);
				if (next.percent >= 100) setState('verifying');
			}, {
				...(resume ? { resume } : {}),
				onSession: (next) => {
					const current = isCurrentRun(token);
					const paused = pausedRunTokenRef.current === token && !runRef.current && mountedRef.current;
					const cancelPending = cancelIntentRunTokenRef.current === token;
					if (cancelPending) {
						rememberSession(next, mountedRef.current);
						void cancelLateCreatedSession(next, token);
					} else if (current || paused) rememberSession(next, true);
					else if (sessionRef.current === null) rememberSession(next, false);
				},
				signal: controller.signal,
			});
			if (!isCurrentRun(token)) return;
			if (completion.status === 'VERIFYING') {
				await waitForSessionReady({ ...resume, sessionId: completion.sessionId } as DirectAssetUploadSession, activeRun);
				return;
			}
			if (!isCurrentRun(token)) return;
			forgetSession(completion.sessionId);
			setState('completed');
			qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
			onComplete?.();
		} catch (cause) {
			if (!isCurrentRun(token) || controller.signal.aborted) return;
			setError(getApiErrorMessage(cause));
			setState('error');
		} finally {
			if (runRef.current?.token === token) {
				runRef.current = null;
				submittingRef.current = false;
			}
		}
	}, [beginRun, cancelLateCreatedSession, forgetSession, isCurrentRun, onComplete, projectId, qc, rememberSession, uploadKind, waitForSessionReady]);

	const resumeUpload = useCallback(async (uploadFile: File, candidate: DirectAssetUploadSession) => {
		const activeRun = beginRun();
		if (!activeRun) return;
		const { token, controller } = activeRun;
		try {
			const status = await getDirectAssetUploadStatus(candidate.sessionId, controller.signal);
			if (!isCurrentRun(token)) return;
			if (status.state === 'UPLOADING' && status.generation === candidate.generation) {
				await runUpload(uploadFile, candidate, activeRun);
				return;
			}
			if ((status.state === 'COMPLETING' || status.state === 'VERIFYING') && status.generation === candidate.generation) {
				await waitForSessionReady(candidate, activeRun);
				return;
			}
			if (status.state === 'READY' && status.generation === candidate.generation) {
				forgetSession(candidate.sessionId);
				setState('completed');
				qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
				onComplete?.();
				return;
			}
			setError(`업로드 세션을 재개할 수 없습니다 (${status.state}).`);
			setState('error');
		} catch (cause) {
			if (!isCurrentRun(token) || controller.signal.aborted) return;
			setError(getApiErrorMessage(cause));
			setState('error');
		} finally {
			if (runRef.current?.token === token) {
				runRef.current = null;
				submittingRef.current = false;
			}
		}
	}, [beginRun, forgetSession, isCurrentRun, onComplete, projectId, qc, runUpload, waitForSessionReady]);

	useEffect(() => {
		if (!autoStart || !initialFile || !sessionRestored || autoStartedRef.current || legacySubmittingRef.current) return;
		autoStartedRef.current = true;
		if (!autoPausedRef.current && state !== 'completed') {
			if (session) void resumeUpload(initialFile, session);
			else void runUpload(initialFile);
		}
	// Auto-start belongs to this concrete file/session pair, not later file input changes.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [autoStart, initialFile, sessionRestored, state]);

	const handleStart = useCallback(() => {
		if (file && !legacySubmittingRef.current) void runUpload(file);
	}, [file, runUpload]);
	const handleResume = useCallback(() => {
		if (file && session) void resumeUpload(file, session);
	}, [file, resumeUpload, session]);
	const handlePause = useCallback(() => {
		if (!runRef.current && !restoreControllerRef.current) return;
		autoPausedRef.current = true;
		pausedRunTokenRef.current = runRef.current?.token ?? null;
		abortActiveRun();
		setError(null);
		setState('idle');
	}, [abortActiveRun]);
	const handleCancel = useCallback(async () => {
		if (cancellingRef.current) return;
		pausedRunTokenRef.current = null;
		const activeToken = runRef.current?.token ?? null;
		if (activeToken !== null && !sessionRef.current) cancelIntentRunTokenRef.current = activeToken;
		abortActiveRun();
		const candidate = sessionRef.current;
		if (!candidate) {
			setState('idle');
			return;
		}
		cancellingRef.current = true;
		setState('idle');
		const cancelToken = ++runTokenRef.current;
		let verificationCandidate: DirectAssetUploadSession | null = null;
		try {
			await cancelDirectAssetUploadSession(candidate.sessionId);
			forgetSession(candidate.sessionId);
			if (mountedRef.current && runTokenRef.current === cancelToken) {
				setState('idle');
				setProgress(null);
				setError(null);
			}
		} catch (cause) {
			if (!mountedRef.current || runTokenRef.current !== cancelToken) return;
			try {
				const status = await getDirectAssetUploadStatus(candidate.sessionId);
				if (!mountedRef.current || runTokenRef.current !== cancelToken) return;
				if (status.state === 'CANCELLED') {
					forgetSession(candidate.sessionId);
					setProgress(null);
					setError(null);
					setState('idle');
				} else if (status.state === 'READY') {
					forgetSession(candidate.sessionId);
					setState('completed');
					qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
					onComplete?.();
				} else if (status.state === 'COMPLETING' || status.state === 'VERIFYING') {
					rememberSession(candidate);
					verificationCandidate = candidate;
				} else {
					rememberSession(candidate);
					if (status.state === 'REJECTED' || status.state === 'EXPIRED') setError(`업로드 세션이 ${status.state.toLowerCase()} 상태입니다.`);
					setState('idle');
				}
			} catch {
				if (mountedRef.current && runTokenRef.current === cancelToken) {
					setError(getApiErrorMessage(cause));
					setState('idle');
				}
			}
		} finally {
			cancellingRef.current = false;
			if (verificationCandidate && mountedRef.current && runTokenRef.current === cancelToken) {
				void waitForSessionReady(verificationCandidate);
			}
		}
	}, [abortActiveRun, forgetSession, onComplete, projectId, qc, rememberSession, waitForSessionReady]);

	const handleLegacyResume = useCallback(async () => {
		if (!legacyResumeSession || state !== 'idle' || submittingRef.current || legacySubmittingRef.current) return;
		if (!file) {
			setLegacyError('이전 업로드를 재개하려면 동일한 파일을 다시 선택하세요.');
			return;
		}
		if (file.size !== legacyResumeSession.totalBytes) {
			setLegacyError(`파일 크기 불일치: 선택한 파일 ${file.size}B vs 세션 ${legacyResumeSession.totalBytes}B. 동일한 파일을 선택하세요.`);
			return;
		}
		legacySubmittingRef.current = true;
		autoStartedRef.current = true;
		try {
			const status = await getGameUploadStatus(legacySession?.sessionId ?? legacyResumeSession.sessionId);
			const candidate: GameUploadSession = status.status === 'PENDING'
				? {
					sessionId: status.sessionId,
					chunkSizeBytes: status.chunkSizeBytes,
					totalChunks: status.totalChunks,
					expiresAt: status.expiresAt,
					uploadKind: status.uploadKind,
				}
				: await createGameUploadSession(projectId, file, uploadKind);
			setLegacySession(candidate);
			await runLegacyUpload(file, candidate, status.status === 'PENDING' ? status.uploadedChunks : []);
		} catch (cause) {
			setLegacyError(getApiErrorMessage(cause));
			setLegacyState('error');
		} finally {
			legacySubmittingRef.current = false;
		}
	}, [file, legacyResumeSession, legacySession, projectId, runLegacyUpload, state, uploadKind]);

	const handleLegacyPause = useCallback(() => {
		legacyControllerRef.current?.abort();
	}, []);

	const handleLegacyCancel = useCallback(async () => {
		if (state !== 'idle' || submittingRef.current) return;
		const sessionId = legacySession?.sessionId ?? legacyResumeSession?.sessionId;
		if (!sessionId) return;
		try {
			await cancelGameUploadSession(sessionId);
			setLegacyState('cancelled');
			setLegacySession(null);
			setLegacyResumeSession(null);
			setLegacyProgress(null);
			setLegacyError(null);
		} catch (cause) {
			setLegacyError(getApiErrorMessage(cause));
			setLegacyState('error');
		}
	}, [legacyResumeSession, legacySession, state]);

	const fileSizeMB = file ? (file.size / 1024 / 1024).toFixed(1) : '0';
	const directOwnsUi = state !== 'idle' || session !== null || pausedRunTokenRef.current !== null;
	const directUiAvailable = directOwnsUi || (!legacyResumeSession && !legacySession
		&& (legacyState === 'idle' || legacyState === 'error' || legacyState === 'cancelled'));
	return (
		<div className="game-upload">
			<h3 className="game-upload__title">{labels.title}</h3>
			{legacyResumeSession && legacyState === 'idle' && state === 'idle' && !directOwnsUi && (
				<div className="game-upload__resume-banner">
					<p className="game-upload__resume-text">
						미완료 업로드가 있습니다: <strong>{legacyResumeSession.originalName}</strong>
						{' '}({legacyResumeSession.uploadedCount}/{legacyResumeSession.totalChunks} 청크 완료)
					</p>
					<p className="game-upload__resume-hint">
						재개하려면 동일한 {labels.noun}을 선택 후 "이어올리기" 버튼을 누르세요.
					</p>
				</div>
			)}
			{session && !legacyResumeSession && state === 'idle' && (
				<div className="game-upload__resume-banner">
					<p className="game-upload__resume-text">직접 업로드가 중단되었습니다. 동일한 {labels.noun}을 선택해 재개하세요.</p>
				</div>
			)}
			{(state === 'idle' || state === 'error') && (legacyState === 'idle' || legacyState === 'error' || legacyState === 'cancelled') && (
				<div className="game-upload__file-input">
					<input type="file" accept=".zip,application/zip,application/x-zip-compressed" onChange={handleFileChange} />
					{file && <p className="file-info">{file.name} — {fileSizeMB}MB</p>}
				</div>
			)}
			{legacyProgress && (legacyState === 'uploading' || legacyState === 'completing' || legacyState === 'completed') && (
				<div className="game-upload__progress-wrap">
					<div className="game-upload__progress-track">
						<div className={`game-upload__progress-bar ${legacyState === 'completed' ? 'game-upload__progress-bar--done' : ''}`} style={{ width: `${legacyProgress.percent}%` }} />
						<span className="game-upload__progress-label">{legacyProgress.percent}% ({legacyProgress.uploadedChunks}/{legacyProgress.totalChunks})</span>
					</div>
					<p className="game-upload__progress-status">
						{legacyState === 'completing' && '파일 조립 중…'}
						{legacyState === 'completed' && '업로드 완료!'}
						{legacyState === 'uploading' && `${(legacyProgress.uploadedBytes / 1024 / 1024).toFixed(0)}MB / ${(legacyProgress.totalBytes / 1024 / 1024).toFixed(0)}MB`}
					</p>
				</div>
			)}
			{progress && (state === 'uploading' || state === 'verifying' || state === 'completed') && (
				<div className="game-upload__progress-wrap">
					<div className="game-upload__progress-track">
						<div className={`game-upload__progress-bar ${state === 'completed' ? 'game-upload__progress-bar--done' : ''}`} style={{ width: `${progress.percent}%` }} />
						<span className="game-upload__progress-label">{progress.percent}% ({progress.uploadedChunks}/{progress.totalChunks})</span>
					</div>
					<p className="game-upload__progress-status">
						{state === 'verifying' && '백그라운드 검증 중… 이 페이지를 닫아도 다음 방문 때 상태를 이어서 확인합니다.'}
						{state === 'completed' && '업로드 완료!'}
						{state === 'uploading' && `${(progress.uploadedBytes / 1024 / 1024).toFixed(0)}MB / ${(progress.totalBytes / 1024 / 1024).toFixed(0)}MB`}
					</p>
				</div>
			)}
			{error && <div className="game-upload__error">{error}</div>}
			{legacyError && <div className="game-upload__error">{legacyError}</div>}
			<div className="game-upload__actions">
				{legacyState === 'idle' && state === 'idle' && !directOwnsUi && file && legacyResumeSession && <>
					<button className="btn btn--primary" onClick={() => void handleLegacyResume()}>이어올리기</button>
					<button className="btn btn--secondary" onClick={handleStart}>새로 시작</button>
				</>}
				{state === 'idle' && !directOwnsUi && legacyState === 'uploading' && <>
					<button className="btn btn--danger" onClick={handleLegacyPause}>일시 정지</button>
				</>}
				{state === 'idle' && !directOwnsUi && (legacyState === 'error' || legacyState === 'cancelled') && (legacySession || legacyResumeSession) && <>
					{file && <button className="btn btn--primary" onClick={() => void handleLegacyResume()}>재시도</button>}
					<button className="btn btn--danger btn--small" onClick={() => void handleLegacyCancel()}>취소 (세션 삭제)</button>
				</>}
				{legacyState === 'completed' && <span className="game-upload__complete-text">업로드 완료</span>}
				{directUiAvailable && state === 'idle' && file && !session && <button className="btn btn--primary" onClick={handleStart}>업로드 시작</button>}
				{directUiAvailable && state === 'idle' && file && session && <>
					<button className="btn btn--primary" onClick={handleResume}>이어올리기</button>
					<button className="btn btn--danger btn--small" onClick={() => void handleCancel()}>취소 (세션 삭제)</button>
				</>}
				{directUiAvailable && state === 'error' && file && <button className="btn btn--primary" onClick={session ? handleResume : handleStart}>재시도</button>}
				{directUiAvailable && (state === 'uploading' || state === 'verifying') && <button className="btn btn--secondary btn--small" onClick={handlePause}>일시 정지</button>}
				{directUiAvailable && (state === 'uploading' || state === 'verifying' || (state === 'error' && session)) && <button className="btn btn--danger btn--small" onClick={() => void handleCancel()}>취소 (세션 삭제)</button>}
				{directUiAvailable && state === 'completed' && <span className="game-upload__complete-text">업로드 완료</span>}
				{onSkip && state !== 'uploading' && state !== 'verifying' && state !== 'completed' && legacyState !== 'uploading' && legacyState !== 'completing' && legacyState !== 'completed' && <button className="btn btn--secondary" onClick={onSkip}>건너뛰기</button>}
			</div>
		</div>
	);
}
