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
	uploadDirectAssetFile,
	waitForDirectAssetReady,
	cancelDirectAssetUploadSession,
	getDirectAssetUploadStatus,
	type GameUploadSession,
	type GameUploadProgress,
	type GameUploadController,
	type GameUploadStatus,
	type DirectAssetUploadSession,
} from '../lib/api/game-upload';
import type { UploadKind } from '../contracts';

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
	/** GAME and WEBGL use fully independent server-side sessions. */
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
	const [session, setSession] = useState<GameUploadSession | null>(null);
	const [directSession, setDirectSession] = useState<DirectAssetUploadSession | null>(null);
	const [directSessionRestored, setDirectSessionRestored] = useState(false);
	const [resumeSession, setResumeSession] = useState<GameUploadStatus | null>(null);
	const controllerRef = useRef<GameUploadController | null>(null);
	const autoStartedRef = useRef(false);
	const submittingRef = useRef(false);
	const mountedRef = useRef(true);
	const directSessionRef = useRef<DirectAssetUploadSession | null>(null);
	const directRunTokenRef = useRef(0);
	const directRunRef = useRef<{ token: number; controller: AbortController } | null>(null);
	const directRestoreControllerRef = useRef<AbortController | null>(null);
	const directPausedRunTokenRef = useRef<number | null>(null);
	const directCancelIntentTokenRef = useRef<number | null>(null);
	const directCancelSessionIdsRef = useRef(new Set<string>());
	const directSessionStorageKey = `pcu.direct-asset-upload:${projectId}:${uploadKind}`;
	const rememberDirectSession = useCallback((next: DirectAssetUploadSession, updateUi = true) => {
		directSessionRef.current = next;
		window.sessionStorage.setItem(directSessionStorageKey, JSON.stringify(next));
		if (updateUi && mountedRef.current) setDirectSession(next);
	}, [directSessionStorageKey]);
	const forgetDirectSession = useCallback((expectedSessionId?: string) => {
		if (expectedSessionId && directSessionRef.current?.sessionId !== expectedSessionId) return false;
		directSessionRef.current = null;
		window.sessionStorage.removeItem(directSessionStorageKey);
		if (mountedRef.current) setDirectSession(null);
		return true;
	}, [directSessionStorageKey]);
	const isCurrentDirectRun = useCallback((token: number) => (
		mountedRef.current && directRunRef.current?.token === token
	), []);
	const abortDirectRun = useCallback(() => {
		const active = directRunRef.current;
		if (active) {
			directRunTokenRef.current += 1;
			directRunRef.current = null;
			submittingRef.current = false;
			active.controller.abort();
		}
		directRestoreControllerRef.current?.abort();
		directRestoreControllerRef.current = null;
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			abortDirectRun();
		};
	}, [abortDirectRun]);

	// Check for existing resumable session on mount
	useEffect(() => {
		let cancelled = false;
		async function check() {
			try {
				const res = await listGameUploadSessions(projectId, uploadKind);
				if (!cancelled && res.items.length > 0) {
					setResumeSession(res.items[0]);
				}
			} catch { /* ignore */ }
		}
		check();
		return () => { cancelled = true; };
	}, [projectId, uploadKind]);

	// Only a non-secret session locator is retained.  A resumed request still
	// recomputes the full source identity before it can obtain another part URL.
	useEffect(() => {
		let cancelled = false;
		const controller = new AbortController();
		directRestoreControllerRef.current = controller;
		async function restoreDirectSession() {
			const raw = window.sessionStorage.getItem(directSessionStorageKey);
			if (!raw) return;
			let verifying = false;
			try {
				const candidate = JSON.parse(raw) as DirectAssetUploadSession;
				if (candidate.kind !== uploadKind) throw new Error('direct upload kind mismatch');
				rememberDirectSession(candidate);
				const status = await getDirectAssetUploadStatus(candidate.sessionId, controller.signal);
				if (!cancelled && status.state === 'UPLOADING' && status.generation === candidate.generation) {
					rememberDirectSession(candidate);
					return;
				}
				if (!cancelled && ['COMPLETING', 'VERIFYING'].includes(status.state) && status.generation === candidate.generation) {
					verifying = true;
					setState('completing');
					await waitForDirectAssetReady(candidate.sessionId, { signal: controller.signal });
					if (!cancelled) {
						forgetDirectSession(candidate.sessionId);
						setState('completed');
						qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
						onComplete?.();
					}
					return;
				}
				if (!cancelled && status.state === 'READY' && status.generation === candidate.generation) {
					forgetDirectSession(candidate.sessionId);
					setState('completed');
					qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
					onComplete?.();
					return;
				}
				if (!cancelled && status.state === 'CANCELLED') {
					forgetDirectSession(candidate.sessionId);
					autoStartedRef.current = true;
					setProgress(null);
					setError(null);
				}
			} catch (restoreError) {
				if (cancelled || controller.signal.aborted) return;
				if (verifying) {
					setError(getApiErrorMessage(restoreError));
					setState('error');
					return;
				}
				// Preserve the opaque locator while status is temporarily unavailable.
			}
		}
		void restoreDirectSession().finally(() => {
			if (!cancelled) {
				setDirectSessionRestored(true);
				if (directRestoreControllerRef.current === controller) directRestoreControllerRef.current = null;
			}
		});
		return () => {
			cancelled = true;
			controller.abort();
			if (directRestoreControllerRef.current === controller) directRestoreControllerRef.current = null;
		};
	}, [directSessionStorageKey, forgetDirectSession, onComplete, projectId, qc, rememberDirectSession, uploadKind]);

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

		const ctrl = uploadGameFile(uploadFile, sess, {
			title: labels.uploadTitle,
			startFrom: uploadedChunks,
			onProgress: (p) => {
				setProgress(p);
				if (p.percent >= 100) setState('completing');
			},
		});
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
	}, [labels.uploadTitle, projectId, qc, onComplete]);

	const pollDirectSession = useCallback(async (candidate: DirectAssetUploadSession) => {
		if (submittingRef.current) return;
		const controller = new AbortController();
		const token = ++directRunTokenRef.current;
		directRunRef.current = { token, controller };
		submittingRef.current = true;
		setState('completing');
		setError(null);
		try {
			await waitForDirectAssetReady(candidate.sessionId, { signal: controller.signal });
			if (!isCurrentDirectRun(token)) return;
			forgetDirectSession(candidate.sessionId);
			setState('completed');
			qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
			onComplete?.();
		} catch (pollError) {
			if (!isCurrentDirectRun(token) || controller.signal.aborted) return;
			setError(getApiErrorMessage(pollError));
			setState('error');
		} finally {
			if (directRunRef.current?.token === token) {
				directRunRef.current = null;
				submittingRef.current = false;
			}
		}
	}, [forgetDirectSession, isCurrentDirectRun, onComplete, projectId, qc]);

	const cancelLateDirectSession = useCallback(async (candidate: DirectAssetUploadSession, sourceToken: number) => {
		if (directCancelSessionIdsRef.current.has(candidate.sessionId)) return;
		directCancelSessionIdsRef.current.add(candidate.sessionId);
		let verificationCandidate: DirectAssetUploadSession | null = null;
		try {
			await cancelDirectAssetUploadSession(candidate.sessionId);
			forgetDirectSession(candidate.sessionId);
			if (mountedRef.current) {
				setProgress(null);
				setError(null);
				setState('idle');
			}
		} catch (cancelError) {
			try {
				const status = await getDirectAssetUploadStatus(candidate.sessionId);
				if (status.state === 'CANCELLED') {
					forgetDirectSession(candidate.sessionId);
					if (mountedRef.current) {
						setProgress(null);
						setError(null);
						setState('idle');
					}
				} else if (status.state === 'READY' && mountedRef.current) {
					forgetDirectSession(candidate.sessionId);
					setState('completed');
					qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
					onComplete?.();
				} else if ((status.state === 'COMPLETING' || status.state === 'VERIFYING') && mountedRef.current) {
					rememberDirectSession(candidate);
					verificationCandidate = candidate;
				} else if (mountedRef.current) {
					setError(getApiErrorMessage(cancelError));
					setState('error');
				}
			} catch {
				if (mountedRef.current) {
					setError(getApiErrorMessage(cancelError));
					setState('error');
				}
			}
		} finally {
			directCancelSessionIdsRef.current.delete(candidate.sessionId);
			if (directCancelIntentTokenRef.current === sourceToken) directCancelIntentTokenRef.current = null;
			if (verificationCandidate && mountedRef.current) void pollDirectSession(verificationCandidate);
		}
	}, [forgetDirectSession, onComplete, pollDirectSession, projectId, qc, rememberDirectSession]);

	const runDirectUpload = useCallback(async (uploadFile: File, resume?: DirectAssetUploadSession) => {
		if (submittingRef.current) return;
		const controller = new AbortController();
		const token = ++directRunTokenRef.current;
		directPausedRunTokenRef.current = null;
		directRunRef.current = { token, controller };
		submittingRef.current = true;
		setState('uploading');
		setError(null);
		try {
			const completion = await uploadDirectAssetFile(projectId, uploadFile, uploadKind, (next) => {
				if (!isCurrentDirectRun(token)) return;
				setProgress(next);
				if (next.percent >= 100) setState('completing');
			}, {
				...(resume ? { resume } : {}),
				onSession: (next) => {
					const current = isCurrentDirectRun(token);
					const paused = directPausedRunTokenRef.current === token && !directRunRef.current && mountedRef.current;
					const cancelPending = directCancelIntentTokenRef.current === token;
					if (cancelPending) {
						rememberDirectSession(next, mountedRef.current);
						void cancelLateDirectSession(next, token);
					} else if (current || paused) rememberDirectSession(next, true);
					else if (directSessionRef.current === null) rememberDirectSession(next, false);
				},
				signal: controller.signal,
			});
			if (!isCurrentDirectRun(token)) return;
			if (completion.status === 'VERIFYING') {
				setState('completing');
				await waitForDirectAssetReady(completion.sessionId, { signal: controller.signal });
			}
			if (!isCurrentDirectRun(token)) return;
			forgetDirectSession(completion.sessionId);
			setState('completed');
			qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
			onComplete?.();
		} catch (uploadError) {
			if (!isCurrentDirectRun(token) || controller.signal.aborted) return;
			setError(getApiErrorMessage(uploadError));
			setState('error');
		} finally {
			if (directRunRef.current?.token === token) {
				directRunRef.current = null;
				submittingRef.current = false;
			}
		}
	}, [cancelLateDirectSession, forgetDirectSession, isCurrentDirectRun, onComplete, projectId, qc, rememberDirectSession, uploadKind]);

	const resumeDirectUpload = useCallback(async (uploadFile: File, candidate: DirectAssetUploadSession) => {
		if (submittingRef.current) return;
		const controller = new AbortController();
		const token = ++directRunTokenRef.current;
		directRunRef.current = { token, controller };
		submittingRef.current = true;
		setError(null);
		try {
			const status = await getDirectAssetUploadStatus(candidate.sessionId, controller.signal);
			if (!isCurrentDirectRun(token)) return;
			if (status.state === 'UPLOADING' && status.generation === candidate.generation) {
				directRunRef.current = null;
				submittingRef.current = false;
				await runDirectUpload(uploadFile, candidate);
				return;
			}
			if ((status.state === 'COMPLETING' || status.state === 'VERIFYING') && status.generation === candidate.generation) {
				directRunRef.current = null;
				submittingRef.current = false;
				await pollDirectSession(candidate);
				return;
			}
			if (status.state === 'READY' && status.generation === candidate.generation) {
				forgetDirectSession(candidate.sessionId);
				setState('completed');
				qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
				onComplete?.();
				return;
			}
			setError(`업로드 세션을 재개할 수 없습니다 (${status.state}).`);
			setState('error');
		} catch (resumeError) {
			if (!isCurrentDirectRun(token) || controller.signal.aborted) return;
			setError(getApiErrorMessage(resumeError));
			setState('error');
		} finally {
			if (directRunRef.current?.token === token) {
				directRunRef.current = null;
				submittingRef.current = false;
			}
		}
	}, [forgetDirectSession, isCurrentDirectRun, onComplete, pollDirectSession, projectId, qc, runDirectUpload]);

	const handleStart = useCallback(async () => {
		if (!file) return;
		if (uploadKind === 'GAME' || uploadKind === 'WEBGL') {
			await runDirectUpload(file);
			return;
		}
		if (submittingRef.current) return;
		submittingRef.current = true;
		try {
			const sess = await createGameUploadSession(projectId, file, uploadKind);
			setSession(sess);
			await doUpload(file, sess);
		} catch (err) {
			setError(getApiErrorMessage(err));
			setState('error');
		} finally {
			submittingRef.current = false;
		}
	}, [doUpload, file, projectId, runDirectUpload, uploadKind]);

	// Auto-start on mount when initialFile + autoStart are provided
	useEffect(() => {
		if ((uploadKind !== 'GAME' && uploadKind !== 'WEBGL') || directSessionRestored) {
			if (!autoStart || !initialFile || autoStartedRef.current) return;
			autoStartedRef.current = true;
			// Defer to avoid synchronous setState within effect body
			const id = setTimeout(() => {
				if (directSession) void resumeDirectUpload(initialFile, directSession);
				else void handleStart();
			}, 0);
			return () => clearTimeout(id);
		}
	}, [autoStart, directSession, directSessionRestored, handleStart, initialFile, resumeDirectUpload, uploadKind]);

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
		if (submittingRef.current) return;
		submittingRef.current = true;

		try {
			const status = await getGameUploadStatus(resumeSession.sessionId);
			const sess: GameUploadSession = {
				sessionId: status.sessionId,
				chunkSizeBytes: status.chunkSizeBytes,
				totalChunks: status.totalChunks,
				expiresAt: status.expiresAt,
				uploadKind: status.uploadKind,
			};
			setSession(sess);
			await doUpload(file, sess, status.uploadedChunks);
		} catch (err) {
			setError(getApiErrorMessage(err));
			setState('error');
		} finally {
			submittingRef.current = false;
		}
	}, [file, resumeSession, doUpload]);

	const handleRetry = useCallback(async () => {
		if (!file) return;
		try {
			if (directSession) {
				await resumeDirectUpload(file, directSession);
				return;
			}
			if (!session) return;
			const status = await getGameUploadStatus(session.sessionId);
			if (status.status === 'PENDING') {
				await doUpload(file, session, status.uploadedChunks);
			} else {
				const replacement = await createGameUploadSession(projectId, file, uploadKind);
				setSession(replacement);
				await doUpload(file, replacement);
			}
		} catch (err) {
			setError(getApiErrorMessage(err));
			setState('error');
		}
	}, [directSession, doUpload, file, projectId, resumeDirectUpload, session, uploadKind]);

	const handleAbort = useCallback(() => {
		if (directRunRef.current || directRestoreControllerRef.current) {
			directPausedRunTokenRef.current = directRunRef.current?.token ?? null;
			abortDirectRun();
			setError(null);
			setState('idle');
			return;
		}
		controllerRef.current?.abort();
	}, [abortDirectRun]);

	const handleCancel = useCallback(async () => {
		directPausedRunTokenRef.current = null;
		const activeDirectToken = directRunRef.current?.token ?? null;
		const directCandidate = directSessionRef.current;
		if (activeDirectToken !== null || directCandidate) {
			if (activeDirectToken !== null && !directCandidate) {
				directCancelIntentTokenRef.current = activeDirectToken;
			}
			abortDirectRun();
			setState('idle');
			if (!directCandidate) return;
			if (directCancelSessionIdsRef.current.has(directCandidate.sessionId)) return;
			directCancelSessionIdsRef.current.add(directCandidate.sessionId);
			let verificationCandidate: DirectAssetUploadSession | null = null;
			try {
				await cancelDirectAssetUploadSession(directCandidate.sessionId);
				forgetDirectSession(directCandidate.sessionId);
				setProgress(null);
				setError(null);
			} catch (cancelError) {
				try {
					const status = await getDirectAssetUploadStatus(directCandidate.sessionId);
					if (status.state === 'CANCELLED') {
						forgetDirectSession(directCandidate.sessionId);
						setProgress(null);
						setError(null);
					} else if (status.state === 'READY') {
						forgetDirectSession(directCandidate.sessionId);
						setState('completed');
						qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
						onComplete?.();
					} else if (status.state === 'COMPLETING' || status.state === 'VERIFYING') {
						rememberDirectSession(directCandidate);
						verificationCandidate = directCandidate;
					} else {
						setError(getApiErrorMessage(cancelError));
						setState('error');
					}
				} catch {
					setError(getApiErrorMessage(cancelError));
					setState('error');
				}
			} finally {
				directCancelSessionIdsRef.current.delete(directCandidate.sessionId);
				if (verificationCandidate && mountedRef.current) void pollDirectSession(verificationCandidate);
			}
			return;
		}
		const sid = directSession?.sessionId ?? session?.sessionId ?? resumeSession?.sessionId;
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
	}, [abortDirectRun, directSession, forgetDirectSession, onComplete, pollDirectSession, projectId, qc, rememberDirectSession, resumeSession, session]);

	const fileSizeMB = file ? (file.size / 1024 / 1024).toFixed(1) : '0';

	return (
		<div className="game-upload">
			<h3 className="game-upload__title">{labels.title}</h3>

			{/* Resume banner */}
			{resumeSession && state === 'idle' && (
				<div className="game-upload__resume-banner">
					<p className="game-upload__resume-text">
						미완료 업로드가 있습니다: <strong>{resumeSession.originalName}</strong>
						{' '}({resumeSession.uploadedCount}/{resumeSession.totalChunks} 청크 완료)
					</p>
					<p className="game-upload__resume-hint">
						재개하려면 동일한 {labels.noun}을 선택 후 "이어올리기" 버튼을 누르세요.
					</p>
				</div>
			)}
			{directSession && !resumeSession && state === 'idle' && (
				<div className="game-upload__resume-banner">
					<p className="game-upload__resume-text">직접 업로드가 중단되었습니다. 동일한 {labels.noun}을 선택해 재개하세요.</p>
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
				{(state === 'idle' || state === 'error' || state === 'cancelled') && file && !resumeSession && !session && !directSession && (
					<button className="btn btn--primary" onClick={handleStart}>
						업로드 시작
					</button>
				)}

				{state === 'idle' && file && resumeSession && (
					<>
						<button className="btn btn--primary" onClick={handleResume} disabled={state !== 'idle'}>
							이어올리기
						</button>
						<button className="btn btn--secondary" onClick={handleStart} disabled={state !== 'idle'}>
							새로 시작
						</button>
					</>
				)}

				{state === 'idle' && file && directSession && !resumeSession && (
					<>
						<button className="btn btn--primary" onClick={handleRetry}>이어올리기</button>
						<button className="btn btn--danger btn--small" onClick={handleCancel}>취소 (세션 삭제)</button>
					</>
				)}

				{(state === 'uploading' || state === 'completing') && (directRunRef.current || directRestoreControllerRef.current) && (
					<button className="btn btn--danger" onClick={handleAbort}>
						일시 정지
					</button>
				)}

				{(state === 'uploading' || state === 'completing') && (directRunRef.current || directRestoreControllerRef.current) && (
					<button className="btn btn--danger btn--small" onClick={() => void handleCancel()}>
						취소 (세션 삭제)
					</button>
				)}

				{(state === 'error' || state === 'cancelled') && (session || directSession) && (
					<button className="btn btn--primary" onClick={handleRetry}>
						재시도
					</button>
				)}

				{(state === 'error' || state === 'cancelled') && (session || directSession || resumeSession) && (
					<button className="btn btn--danger btn--small" onClick={handleCancel}>
						취소 (세션 삭제)
					</button>
				)}

				{state === 'completed' && (
					<span className="game-upload__complete-text">업로드 완료</span>
				)}

				{onSkip && state !== 'uploading' && state !== 'completing' && state !== 'completed' && (
					<button className="btn btn--secondary" onClick={onSkip}>
						건너뛰기
					</button>
				)}
			</div>
		</div>
	);
}
