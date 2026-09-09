/** Direct Garage multipart uploader for project GAME and WEBGL sources. */

import { useState, useCallback, useEffect, useId, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/query';
import { getApiErrorMessage } from '../lib/api';
import {
	cancelDirectAssetUploadSession,
	getDirectAssetUploadStatus,
	uploadDirectAssetFile,
	waitForDirectAssetReady,
	type DirectAssetUploadProgress,
	type DirectAssetUploadSession,
} from '../lib/api/game-upload';
import type { UploadKind } from '../contracts';

type UploadState = 'idle' | 'uploading' | 'verifying' | 'completed' | 'error';

interface Props {
	projectId: number;
	initialFile?: File | null;
	autoStart?: boolean;
	onComplete?: () => void;
	onSkip?: () => void;
	uploadKind?: UploadKind;
	submissionItem?: { id: string; clientToken: string };
}

export default function GameUploadWidget({
	projectId,
	initialFile,
	autoStart,
	onComplete,
	onSkip,
	uploadKind = 'GAME',
	submissionItem,
}: Props) {
	const qc = useQueryClient();
	const fileInputId = useId();
	const isWebgl = uploadKind === 'WEBGL';
	const labels = isWebgl
		? { title: 'WebGL 빌드 업로드 (ZIP 파일)', noun: 'WebGL 빌드' }
		: { title: '게임 파일 업로드 (ZIP 파일)', noun: '게임 파일' };
	const [file, setFile] = useState<File | null>(initialFile ?? null);
	const [state, setState] = useState<UploadState>('idle');
	const [progress, setProgress] = useState<DirectAssetUploadProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [session, setSession] = useState<DirectAssetUploadSession | null>(null);
	const [terminalSessionConfirmation, setTerminalSessionConfirmation] = useState<{
		sessionId: string;
		generation: number;
	} | null>(null);
	const [sessionRestored, setSessionRestored] = useState(false);
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
		if (mountedRef.current) {
			setSession(null);
			setTerminalSessionConfirmation((current) => (
				!expectedSessionId || current?.sessionId === expectedSessionId ? null : current
			));
		}
		return true;
	}, [directSessionStorageKey]);
	const markTerminalSession = useCallback((candidate: DirectAssetUploadSession, status: {
		sessionId: string;
		generation: number;
		state: string;
	}) => {
		if (!mountedRef.current
			|| sessionRef.current?.sessionId !== candidate.sessionId
			|| sessionRef.current.generation !== candidate.generation
			|| status.sessionId !== candidate.sessionId
			|| status.generation !== candidate.generation
			|| !['REJECTED', 'EXPIRED'].includes(status.state)) return false;
		autoStartedRef.current = true;
		setTerminalSessionConfirmation({ sessionId: candidate.sessionId, generation: candidate.generation });
		setError('업로드 세션을 다시 이어올릴 수 없습니다. 원본 ZIP 파일을 선택한 뒤 새 업로드 시작을 눌러 다시 올리세요.');
		setState('idle');
		return true;
	}, []);
	const isCurrentRun = useCallback((token: number) => (
		mountedRef.current && runRef.current?.token === token
	), []);
	const beginRun = useCallback(() => {
		if (submittingRef.current || cancellingRef.current || !mountedRef.current) return null;
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
		const polling = new AbortController();
		restoreControllerRef.current = polling;
		const isCurrentRestoredSession = (candidate: DirectAssetUploadSession | null) => (
			!cancelled
			&& !polling.signal.aborted
			&& candidate !== null
			&& sessionRef.current?.sessionId === candidate.sessionId
			&& sessionRef.current.generation === candidate.generation
		);
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
				if (!isCurrentRestoredSession(candidate)) return;
				if (status.state === 'UPLOADING' && status.generation === candidate.generation) {
					rememberSession(candidate);
					return;
				}
				if (['COMPLETING', 'VERIFYING'].includes(status.state) && status.generation === candidate.generation) {
					keepForBackgroundVerification = true;
					rememberSession(candidate);
					setState('verifying');
					await waitForDirectAssetReady(candidate.sessionId, { signal: polling.signal });
					if (isCurrentRestoredSession(candidate)) {
						forgetSession(candidate.sessionId);
						setState('completed');
						qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
						onComplete?.();
					}
					return;
				}
				if (status.state === 'READY' && status.generation === candidate.generation) {
					forgetSession();
					setState('completed');
					qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
					onComplete?.();
					return;
				}
				if (status.state === 'CANCELLED') {
					forgetSession(candidate.sessionId);
					autoStartedRef.current = true;
					setProgress(null);
					setError(null);
					setState('idle');
					return;
				}
				if (status.state === 'REJECTED' || status.state === 'EXPIRED') {
					markTerminalSession(candidate, status);
				}
			} catch (cause) {
				if (cancelled || polling.signal.aborted) return;
				if (!isCurrentRestoredSession(candidate)) return;
				if (keepForBackgroundVerification) {
					if (candidate) {
						try {
							const status = await getDirectAssetUploadStatus(candidate.sessionId, polling.signal);
							if (!isCurrentRestoredSession(candidate)) return;
							if (markTerminalSession(candidate, status)) return;
						} catch {
							if (!isCurrentRestoredSession(candidate)) return;
						}
					}
					if (!isCurrentRestoredSession(candidate)) return;
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
	}, [directSessionStorageKey, forgetSession, markTerminalSession, onComplete, projectId, qc, rememberSession, uploadKind]);

	const handleFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
		setFile(event.target.files?.[0] ?? null);
		if (!terminalSessionConfirmation) setError(null);
	}, [terminalSessionConfirmation]);

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
			try {
				const status = await getDirectAssetUploadStatus(candidate.sessionId, controller.signal);
				if (!isCurrentRun(token) || controller.signal.aborted) return;
				if (markTerminalSession(candidate, status)) return;
			} catch {
				if (!isCurrentRun(token) || controller.signal.aborted) return;
			}
			setError(getApiErrorMessage(cause));
			setState('error');
		} finally {
			if (runRef.current?.token === token) {
				runRef.current = null;
				submittingRef.current = false;
			}
		}
	}, [beginRun, forgetSession, isCurrentRun, markTerminalSession, onComplete, projectId, qc]);

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
					if (!markTerminalSession(candidate, status)) setState('idle');
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
	}, [forgetSession, markTerminalSession, onComplete, projectId, qc, rememberSession, waitForSessionReady]);

	const runUpload = useCallback(async (
		uploadFile: File,
		resume?: DirectAssetUploadSession,
		activeRun = beginRun(),
	) => {
		if (!activeRun) return;
		const { token, controller } = activeRun;
		let verificationSession = resume;
		setState('uploading');
		setError(null);
		try {
			const completion = await uploadDirectAssetFile(projectId, uploadFile, uploadKind, (next) => {
				if (!isCurrentRun(token)) return;
				setProgress(next);
				if (next.percent >= 100) setState('verifying');
			}, {
				...(resume ? { resume } : {}),
				...(submissionItem ? { submissionItem } : {}),
				onSession: (next) => {
					const current = isCurrentRun(token);
					const paused = pausedRunTokenRef.current === token && !runRef.current && mountedRef.current;
				const cancelPending = cancelIntentRunTokenRef.current === token;
				if (cancelPending) {
					verificationSession = next;
					rememberSession(next, mountedRef.current);
					void cancelLateCreatedSession(next, token);
				} else if (current || paused) {
					verificationSession = next;
					rememberSession(next, true);
				} else if (sessionRef.current === null) {
					verificationSession = next;
					rememberSession(next, false);
				}
			},
			signal: controller.signal,
			});
			if (!isCurrentRun(token)) return;
			if (completion.status === 'VERIFYING') {
				if (!verificationSession || verificationSession.sessionId !== completion.sessionId) {
					setError('업로드 세션 정보를 확인할 수 없습니다. 네트워크 연결을 확인한 뒤 다시 시도하세요.');
					setState('error');
					return;
				}
				await waitForSessionReady(verificationSession, activeRun);
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
	}, [beginRun, cancelLateCreatedSession, forgetSession, isCurrentRun, onComplete, projectId, qc, rememberSession, submissionItem, uploadKind, waitForSessionReady]);

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
			if (markTerminalSession(candidate, status)) return;
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
	}, [beginRun, forgetSession, isCurrentRun, markTerminalSession, onComplete, projectId, qc, runUpload, waitForSessionReady]);

	useEffect(() => {
		if (!autoStart || !initialFile || !sessionRestored || autoStartedRef.current) return;
		autoStartedRef.current = true;
		if (!autoPausedRef.current && state !== 'completed') {
			if (session) void resumeUpload(initialFile, session);
			else void runUpload(initialFile);
		}
	// Auto-start belongs to this concrete file/session pair, not later file input changes.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [autoStart, initialFile, sessionRestored, state]);

	const handleStart = useCallback(() => {
		if (file) void runUpload(file);
	}, [file, runUpload]);
	const handleTerminalRetry = useCallback(() => {
		const candidate = sessionRef.current;
		const confirmation = terminalSessionConfirmation;
		if (!file || !candidate || !confirmation
			|| candidate.sessionId !== confirmation.sessionId
			|| candidate.generation !== confirmation.generation
			|| submittingRef.current || cancellingRef.current) return;
		if (!forgetSession(candidate.sessionId)) return;
		setProgress(null);
		setError(null);
		void runUpload(file);
	}, [file, forgetSession, runUpload, terminalSessionConfirmation]);
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
					if (!markTerminalSession(candidate, status)) setState('idle');
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
	}, [abortActiveRun, forgetSession, markTerminalSession, onComplete, projectId, qc, rememberSession, waitForSessionReady]);

	const fileSizeMB = file ? (file.size / 1024 / 1024).toFixed(1) : '0';
	const terminalSession = session !== null
		&& terminalSessionConfirmation?.sessionId === session.sessionId
		&& terminalSessionConfirmation.generation === session.generation;
	return (
		<div className="game-upload">
			<h3 className="game-upload__title">{labels.title}</h3>
			{session && state === 'idle' && (
				<div className="game-upload__resume-banner">
					<p className="game-upload__resume-text">직접 업로드가 중단되었습니다. 동일한 {labels.noun}을 선택해 재개하세요.</p>
				</div>
			)}
			{(state === 'idle' || state === 'error') && (
				<div className="game-upload__file-input">
					<label className="sr-only" htmlFor={fileInputId}>{labels.noun} ZIP 파일 선택</label>
					<input id={fileInputId} type="file" accept=".zip,application/zip,application/x-zip-compressed" onChange={handleFileChange} />
					{file && <p className="game-upload__file-summary">{file.name} — {fileSizeMB}MB</p>}
				</div>
			)}
			{progress && (state === 'uploading' || state === 'verifying' || state === 'completed') && (
				<div className="game-upload__progress-wrap" role="status" aria-live="polite">
					<div className="game-upload__progress-track" role="progressbar" aria-label={`${labels.noun} 업로드 진행률`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
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
			{error && <div className="game-upload__error" role="alert">{error}</div>}
			<div className="game-upload__actions">
				{state === 'idle' && file && !session && <button className="btn btn--primary" type="button" onClick={handleStart}>업로드 시작</button>}
				{state === 'idle' && file && terminalSession && (
					<button className="btn btn--primary" type="button" onClick={handleTerminalRetry}>새 업로드 시작</button>
				)}
				{state === 'idle' && file && session && !terminalSession && <>
					<button className="btn btn--primary" type="button" onClick={handleResume}>이어올리기</button>
					<button className="btn btn--danger btn--small" type="button" onClick={() => void handleCancel()}>취소 (세션 삭제)</button>
				</>}
				{state === 'error' && file && <button className="btn btn--primary" type="button" onClick={session ? handleResume : handleStart}>재시도</button>}
				{(state === 'uploading' || state === 'verifying') && <button className="btn btn--secondary btn--small" type="button" onClick={handlePause}>일시 정지</button>}
				{(state === 'uploading' || state === 'verifying' || (state === 'error' && session)) && <button className="btn btn--danger btn--small" type="button" onClick={() => void handleCancel()}>취소 (세션 삭제)</button>}
				{state === 'completed' && <span className="game-upload__complete-text">업로드 완료</span>}
				{onSkip && state !== 'uploading' && state !== 'verifying' && state !== 'completed' && <button className="btn btn--secondary" type="button" onClick={onSkip}>건너뛰기</button>}
			</div>
		</div>
	);
}
