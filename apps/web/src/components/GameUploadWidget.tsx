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
	/** Advances an enclosing queue only after cancellation leaves no pending session. */
	onCancelled?: () => void;
	/** An enclosing row provides the heading, chooser, and selected file summary. */
	compact?: boolean;
	onSkip?: () => void;
	uploadKind?: UploadKind;
	submissionItem?: { id: string; clientToken: string };
}

export default function GameUploadWidget({
	projectId,
	initialFile,
	autoStart,
	onComplete,
	onCancelled,
	compact = false,
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
	const cancelledRunTokensRef = useRef(new Set<number>());
	const pendingCreateTokensRef = useRef(new Set<number>());
	const cancellationIntentRef = useRef(false);
	const cancellationRequestedSessionIdsRef = useRef(new Set<string>());
	const lateCancelSessionIdRef = useRef<string | null>(null);
	const restoredFileMatchesRef = useRef(true);
	const restoredSessionIdRef = useRef<string | null>(null);
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
	const finishCancellation = useCallback(() => {
		// Aborting a create does not prove that no server session was created.
		cancellingRef.current = cancelledRunTokensRef.current.size > 0 || cancellationRequestedSessionIdsRef.current.size > 0;
		if (!cancellingRef.current && pendingCreateTokensRef.current.size === 0 && !sessionRef.current
			&& cancellationIntentRef.current && mountedRef.current) {
			cancellationIntentRef.current = false;
			onCancelled?.();
		}
	}, [onCancelled]);
	const beginRun = useCallback(() => {
		if (submittingRef.current || cancellingRef.current || !mountedRef.current) return null;
		const controller = new AbortController();
		const token = ++runTokenRef.current;
		cancellationIntentRef.current = false;
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

	const checkRestoredFile = useCallback((
		candidate: DirectAssetUploadSession,
		status: { originalName: string; totalBytes: number },
		selectedFile: File | null | undefined,
	) => {
		if (restoredSessionIdRef.current !== candidate.sessionId) return;
		restoredFileMatchesRef.current = !selectedFile
			|| (selectedFile.name === status.originalName && selectedFile.size === status.totalBytes);
	}, []);

	const reportCompletion = useCallback(() => {
		qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
		if (compact && !restoredFileMatchesRef.current) {
			setError('이전 파일의 업로드가 완료되었습니다. 선택한 파일을 재시도해 주세요.');
			setState('error');
			return;
		}
		setState('completed');
		onComplete?.();
	}, [compact, onComplete, projectId, qc]);

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
				restoredSessionIdRef.current = candidate.sessionId;
				restoredFileMatchesRef.current = !initialFile;
				rememberSession(candidate);
				const status = await getDirectAssetUploadStatus(candidate.sessionId, polling.signal);
				if (!isCurrentRestoredSession(candidate)) return;
				const matchesChosen = !initialFile || (initialFile.name === status.originalName && initialFile.size === status.totalBytes);
				restoredFileMatchesRef.current = matchesChosen;
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
						if (!matchesChosen) {
							setState('idle');
							return;
						}
						reportCompletion();
					}
					return;
				}
				if (status.state === 'READY' && status.generation === candidate.generation) {
					forgetSession();
					if (!matchesChosen) {
						setState('idle');
						return;
					}
					reportCompletion();
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
	}, [directSessionStorageKey, forgetSession, initialFile, markTerminalSession, reportCompletion, projectId, qc, rememberSession, uploadKind]);

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
			reportCompletion();
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
	}, [beginRun, forgetSession, isCurrentRun, markTerminalSession, reportCompletion]);

	const cancelLateCreatedSession = useCallback(async (candidate: DirectAssetUploadSession, sourceToken: number) => {
		if (lateCancelSessionIdRef.current === candidate.sessionId) return;
		lateCancelSessionIdRef.current = candidate.sessionId;
		cancellationRequestedSessionIdsRef.current.add(candidate.sessionId);
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
					cancellationIntentRef.current = false;
					forgetSession(candidate.sessionId);
					reportCompletion();
				} else if (status.state === 'COMPLETING' || status.state === 'VERIFYING') {
					cancellationIntentRef.current = false;
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
			cancellationRequestedSessionIdsRef.current.delete(candidate.sessionId);
			cancelledRunTokensRef.current.delete(sourceToken);
			finishCancellation();
			if (verificationCandidate && mountedRef.current) void waitForSessionReady(verificationCandidate);
		}
	}, [finishCancellation, forgetSession, markTerminalSession, reportCompletion, rememberSession, waitForSessionReady]);

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
			if (!resume) {
				restoredSessionIdRef.current = null;
				restoredFileMatchesRef.current = true;
				pendingCreateTokensRef.current.add(token);
			}
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
				pendingCreateTokensRef.current.delete(token);
				const cancelPending = cancelledRunTokensRef.current.delete(token);
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
			restoredFileMatchesRef.current = true;
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
			reportCompletion();
		} catch (cause) {
			if (!isCurrentRun(token) || controller.signal.aborted) return;
			setError(getApiErrorMessage(cause));
			setState('error');
		} finally {
			pendingCreateTokensRef.current.delete(token);
			cancelledRunTokensRef.current.delete(token);
			finishCancellation();
			if (runRef.current?.token === token) {
				runRef.current = null;
				submittingRef.current = false;
			}
		}
	}, [beginRun, cancelLateCreatedSession, finishCancellation, forgetSession, isCurrentRun, reportCompletion, projectId, rememberSession, submissionItem, uploadKind, waitForSessionReady]);

	const resumeUpload = useCallback(async (uploadFile: File, candidate: DirectAssetUploadSession) => {
		const activeRun = beginRun();
		if (!activeRun) return;
		const { token, controller } = activeRun;
		try {
			const status = await getDirectAssetUploadStatus(candidate.sessionId, controller.signal);
			if (!isCurrentRun(token)) return;
			checkRestoredFile(candidate, status, uploadFile);
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
				reportCompletion();
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
	}, [checkRestoredFile, beginRun, forgetSession, isCurrentRun, markTerminalSession, reportCompletion, runUpload, waitForSessionReady]);

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
		cancellationIntentRef.current = true;
		autoPausedRef.current = true;
		pausedRunTokenRef.current = null;
		for (const token of pendingCreateTokensRef.current) cancelledRunTokensRef.current.add(token);
		abortActiveRun();
		const candidate = sessionRef.current;
		if (!candidate) {
			setState('idle');
			setError(null);
			finishCancellation();
			return;
		}
		cancellingRef.current = true;
		cancellationRequestedSessionIdsRef.current.add(candidate.sessionId);
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
				checkRestoredFile(candidate, status, file);
				if (status.state === 'CANCELLED') {
					forgetSession(candidate.sessionId);
					setProgress(null);
					setError(null);
					setState('idle');
				} else if (status.state === 'READY') {
					cancellationIntentRef.current = false;
					forgetSession(candidate.sessionId);
					reportCompletion();
				} else if (status.state === 'COMPLETING' || status.state === 'VERIFYING') {
					cancellationIntentRef.current = false;
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
			cancellationRequestedSessionIdsRef.current.delete(candidate.sessionId);
			finishCancellation();
			if (verificationCandidate && mountedRef.current && runTokenRef.current === cancelToken) {
				void waitForSessionReady(verificationCandidate);
			}
		}
	}, [checkRestoredFile, file, abortActiveRun, finishCancellation, forgetSession, markTerminalSession, reportCompletion, rememberSession, waitForSessionReady]);

	const fileSizeMB = file ? (file.size / 1024 / 1024).toFixed(1) : '0';
	const terminalSession = session !== null
		&& terminalSessionConfirmation?.sessionId === session.sessionId
		&& terminalSessionConfirmation.generation === session.generation;
	return (
		<div className="game-upload">
			{!compact && <h3 className="game-upload__title">{labels.title}</h3>}
			{session && state === 'idle' && (
				<div className="game-upload__resume-banner">
					<p className="game-upload__resume-text">직접 업로드가 중단되었습니다. 동일한 {labels.noun}을 선택해 재개하세요.</p>
				</div>
			)}
			{!compact && (state === 'idle' || state === 'error') && (
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
				</>}
				{state === 'error' && file && <button className="btn btn--primary" type="button" onClick={session ? handleResume : handleStart}>재시도</button>}
				{(state === 'uploading' || state === 'verifying') && <button className="btn btn--secondary btn--small" type="button" onClick={handlePause}>일시 정지</button>}
				{state !== 'completed' && (file || session || state === 'verifying') && <button className="btn btn--danger btn--small" type="button" onClick={() => void handleCancel()}>취소 (세션 삭제)</button>}
				{state === 'completed' && <span className="game-upload__complete-text">업로드 완료</span>}
				{onSkip && state !== 'uploading' && state !== 'verifying' && state !== 'completed' && <button className="btn btn--secondary" type="button" onClick={onSkip}>건너뛰기</button>}
			</div>
		</div>
	);
}
