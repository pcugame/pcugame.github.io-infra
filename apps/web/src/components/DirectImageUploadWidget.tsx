import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { DirectAssetUploadKind, DirectAssetUploadOwner } from '../contracts';
import { getApiErrorMessage } from '../lib/api';
import {
	cancelDirectAssetUploadSession,
	getDirectAssetUploadStatus,
	uploadDirectAssetFile,
	waitForDirectAssetReady,
	type DirectAssetUploadSession,
	type DirectAssetUploadProgress,
} from '../lib/api/game-upload';
import { queryKeys } from '../lib/query';

type Phase = 'idle' | 'uploading' | 'verifying' | 'ready' | 'error';
type ImageKind = Extract<DirectAssetUploadKind, 'IMAGE' | 'POSTER'>;

interface SavedImageSession {
	session: DirectAssetUploadSession;
	originalName: string;
	totalBytes: number;
	/** Number of files already completed before the saved in-flight file. */
	completed?: number;
}

interface Props {
	owner: DirectAssetUploadOwner;
	kind: ImageKind;
	initialFiles?: readonly File[];
	autoStart?: boolean;
	onComplete?: () => void;
	onError?: (message: string) => void;
	/** An enclosing Apply action requests a retry without discarding recovery state. */
	retryAttempt?: number;
	/** Advances an enclosing queue only after cancellation leaves no pending session. */
	onCancelled?: () => void;
	/** An enclosing row provides the heading, chooser, and selected file summary. */
	compact?: boolean;
	/** Suppress the generic heading when embedded in an asset-management row. */
	hideTitle?: boolean;
	/** Lets an enclosing owner control mutually exclusive mutations such as delete. */
	onBusyChange?: (busy: boolean) => void;
	submissionItems?: readonly { id: string; clientToken: string }[];
}

/** Browser control for IMAGE and POSTER sessions; asset bytes go directly to Garage. */
export default function DirectImageUploadWidget({
	owner,
	kind,
	initialFiles = [],
	autoStart = false,
	onComplete,
	onError,
	retryAttempt = 0,
	onCancelled,
	compact = false,
	hideTitle = false,
	onBusyChange,
	submissionItems = [],
}: Props) {
	const qc = useQueryClient();
	const recoveringManifest = initialFiles.length === 0 && submissionItems.length > 0;
	const fileInputId = useId();
	const [files, setFiles] = useState<File[]>([...initialFiles]);
	const [phase, setPhase] = useState<Phase>('idle');
	const [progress, setProgress] = useState<DirectAssetUploadProgress | null>(null);
	const [completed, setCompleted] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [resumable, setResumable] = useState<SavedImageSession | null>(null);
	const [restoreDone, setRestoreDone] = useState(false);
	const mountedRef = useRef(true);
	const initialFilesRef = useRef(initialFiles);
	const resumableRef = useRef<SavedImageSession | null>(null);
	const completedRef = useRef(0);
	const autoStarted = useRef(false);
	const submitting = useRef(false);
	const cancelling = useRef(false);
	const runTokenRef = useRef(0);
	const runRef = useRef<{ token: number; controller: AbortController } | null>(null);
	const restoreControllerRef = useRef<AbortController | null>(null);
	const pausedRunTokenRef = useRef<number | null>(null);
	const autoPausedRef = useRef(false);
	const cancelledRunTokensRef = useRef(new Set<number>());
	const pendingCreateTokensRef = useRef(new Set<number>());
	const cancellationIntentRef = useRef(false);
	const cancellationRequestedSessionIdsRef = useRef(new Set<string>());
	const cancelLateSessionRef = useRef<(saved: SavedImageSession) => void>(() => undefined);
	const storageKey = `pcu.direct-${kind.toLowerCase()}-upload:${owner.type}:${owner.id}`;
	const title = kind === 'POSTER' ? '포스터 업로드' : '이미지 업로드';

	const invalidateOwner = useCallback(() => {
		if (owner.type === 'PROJECT') qc.invalidateQueries({ queryKey: queryKeys.adminProject(owner.id) });
		else qc.invalidateQueries({ queryKey: queryKeys.adminExhibitions });
	}, [owner, qc]);
	const updateCompleted = useCallback((next: number) => {
		completedRef.current = next;
		if (mountedRef.current) setCompleted(next);
	}, []);
	const remember = useCallback((session: DirectAssetUploadSession, file: Pick<File, 'name' | 'size'>, completedBefore: number, updateUi = true) => {
		const value: SavedImageSession = { session, originalName: file.name, totalBytes: file.size, completed: completedBefore };
		resumableRef.current = value;
		window.sessionStorage.setItem(storageKey, JSON.stringify(value));
		if (updateUi && mountedRef.current) setResumable(value);
	}, [storageKey]);
	const forget = useCallback((expectedSessionId?: string) => {
		if (expectedSessionId && resumableRef.current?.session.sessionId !== expectedSessionId) return false;
		resumableRef.current = null;
		window.sessionStorage.removeItem(storageKey);
		if (mountedRef.current) setResumable(null);
		return true;
	}, [storageKey]);
	const isCurrentRun = useCallback((token: number) => (
		mountedRef.current && runRef.current?.token === token
	), []);
	const finishCancellation = useCallback(() => {
		// Aborting a create does not prove that no server session was created.
		cancelling.current = cancelledRunTokensRef.current.size > 0 || cancellationRequestedSessionIdsRef.current.size > 0;
		if (!cancelling.current && pendingCreateTokensRef.current.size === 0 && !resumableRef.current
			&& cancellationIntentRef.current && mountedRef.current) {
			cancellationIntentRef.current = false;
			onCancelled?.();
		}
	}, [onCancelled]);
	const beginRun = useCallback(() => {
		if (submitting.current || cancelling.current || !mountedRef.current) return null;
		const controller = new AbortController();
		const token = ++runTokenRef.current;
		cancellationIntentRef.current = false;
		pausedRunTokenRef.current = null;
		runRef.current = { token, controller };
		submitting.current = true;
		return { token, controller };
	}, []);
	const abortLocalWork = useCallback(() => {
		const active = runRef.current;
		if (active) {
			runTokenRef.current += 1;
			runRef.current = null;
			submitting.current = false;
			active.controller.abort();
		}
		restoreControllerRef.current?.abort();
		restoreControllerRef.current = null;
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			abortLocalWork();
		};
	}, [abortLocalWork]);
	useEffect(() => {
		initialFilesRef.current = initialFiles;
	}, [initialFiles]);

	useEffect(() => {
		let disposed = false;
		const controller = new AbortController();
		restoreControllerRef.current = controller;
		async function restore() {
			const raw = window.sessionStorage.getItem(storageKey);
			if (!raw) return;
			try {
				const saved = JSON.parse(raw) as SavedImageSession;
				if (saved.session.kind !== kind || saved.session.owner.type !== owner.type || saved.session.owner.id !== owner.id) throw new Error('owner');
				const chosen = initialFilesRef.current;
				const completedBefore = recoveringManifest || (compact && chosen.length === 1)
					? 0 : saved.completed ?? 0;
				const matchesChosen = chosen.length === 0
					|| (chosen[completedBefore]?.name === saved.originalName && chosen[completedBefore]?.size === saved.totalBytes);
				// Preserve a valid opaque locator even when status is temporarily unavailable.
				remember(saved.session, { name: saved.originalName, size: saved.totalBytes }, completedBefore);
				updateCompleted(completedBefore);
				const status = await getDirectAssetUploadStatus(saved.session.sessionId, controller.signal);
				if (disposed || controller.signal.aborted
					|| status.kind !== kind || status.owner.type !== owner.type || status.owner.id !== owner.id
					|| status.generation !== saved.session.generation) return;
				if (status.state === 'VERIFYING' || status.state === 'COMPLETING') {
					setPhase('verifying');
					await waitForDirectAssetReady(status.sessionId, { signal: controller.signal });
					if (!disposed && !controller.signal.aborted) {
						forget(saved.session.sessionId);
						if (!matchesChosen) {
							updateCompleted(0);
							setPhase('idle');
							return;
						}
						const nextCompleted = completedBefore + 1;
						updateCompleted(nextCompleted);
						if (initialFilesRef.current.length === 0 || nextCompleted >= initialFilesRef.current.length) {
							setPhase('ready');
							invalidateOwner();
							onComplete?.();
						} else setPhase('idle');
					}
					return;
				}
				if (status.state === 'UPLOADING') {
					return;
				}
				if (status.state === 'READY') {
					forget(saved.session.sessionId);
					if (!matchesChosen) {
						updateCompleted(0);
						setPhase('idle');
						return;
					}
					const nextCompleted = completedBefore + 1;
					updateCompleted(nextCompleted);
					if (initialFilesRef.current.length === 0 || nextCompleted >= initialFilesRef.current.length) {
						setPhase('ready');
						invalidateOwner();
						onComplete?.();
					} else setPhase('idle');
					return;
				}
				if (status.state === 'CANCELLED') forget(saved.session.sessionId);
				else {
					setError(`업로드 세션이 ${status.state.toLowerCase()} 상태입니다.`);
					setPhase('idle');
				}
			} catch (cause) {
				if (!disposed && !controller.signal.aborted) {
					setError(getApiErrorMessage(cause));
					setPhase('idle');
				}
			}
		}
		void restore().finally(() => {
			if (!disposed) setRestoreDone(true);
		});
		return () => {
			disposed = true;
			controller.abort();
			if (restoreControllerRef.current === controller) restoreControllerRef.current = null;
		};
	}, [recoveringManifest, compact, forget, invalidateOwner, kind, onComplete, owner, remember, storageKey, updateCompleted]);

	useEffect(() => {
		onBusyChange?.(phase === 'uploading' || phase === 'verifying');
	}, [onBusyChange, phase]);

	const uploadQueue = useCallback(async (
		chosen: readonly File[],
		resume?: SavedImageSession,
		activeRun = beginRun(),
	) => {
		if (chosen.length === 0 || !activeRun) return;
		const { token, controller } = activeRun;
		setError(null);
		const startIndex = Math.min(completedRef.current, chosen.length);
		try {
			for (let index = startIndex; index < chosen.length; index += 1) {
				if (!isCurrentRun(token)) return;
				const file = chosen[index]!;
				setPhase('uploading');
				setProgress(null);
				const matchingResume = index === startIndex && resume
					&& resume.originalName === file.name && resume.totalBytes === file.size
					? resume.session
					: undefined;
				if (!matchingResume) pendingCreateTokensRef.current.add(token);
				const completion = await uploadDirectAssetFile(owner, file, kind, (next) => {
					if (!isCurrentRun(token)) return;
					setProgress(next);
					if (next.percent >= 100) setPhase('verifying');
				}, {
					...(matchingResume ? { resume: matchingResume } : {}),
					...(submissionItems[index] ? { submissionItem: submissionItems[index] } : {}),
					onSession: (next) => {
						const current = isCurrentRun(token);
						const paused = pausedRunTokenRef.current === token && !runRef.current && mountedRef.current;
						pendingCreateTokensRef.current.delete(token);
						const cancelRequested = cancelledRunTokensRef.current.delete(token);
						// A create response can arrive after its caller was aborted. Retain the
						// opaque locator first; unmounts deliberately stop here, while a
						// cancellation intent schedules its own authenticated control request.
						if (current || paused || cancelRequested || resumableRef.current === null) {
							remember(next, file, index, current || paused || (cancelRequested && mountedRef.current));
						}
						if (cancelRequested) cancelLateSessionRef.current({ session: next, originalName: file.name, totalBytes: file.size, completed: index });
					},
					signal: controller.signal,
				});
				if (!isCurrentRun(token)) return;
				if (completion.status === 'VERIFYING') {
					setPhase('verifying');
					await waitForDirectAssetReady(completion.sessionId, { signal: controller.signal });
				}
				if (!isCurrentRun(token)) return;
				forget(completion.sessionId);
				updateCompleted(index + 1);
			}
			if (!isCurrentRun(token)) return;
			setPhase('ready');
			invalidateOwner();
			onComplete?.();
		} catch (uploadError) {
			if (!isCurrentRun(token) || controller.signal.aborted) return;
			setError(getApiErrorMessage(uploadError));
			setPhase('error');
		} finally {
			pendingCreateTokensRef.current.delete(token);
			cancelledRunTokensRef.current.delete(token);
			finishCancellation();
			if (runRef.current?.token === token) {
				runRef.current = null;
				submitting.current = false;
			}
		}
	}, [beginRun, finishCancellation, forget, invalidateOwner, isCurrentRun, kind, onComplete, owner, remember, submissionItems, updateCompleted]);

	const matchesSavedFile = useCallback((chosen: readonly File[], saved: SavedImageSession) => {
		const current = chosen[saved.completed ?? 0];
		return current?.name === saved.originalName && current.size === saved.totalBytes;
	}, []);
	const continueAfterReady = useCallback(async (
		saved: SavedImageSession,
		chosen: readonly File[],
		activeRun: { token: number; controller: AbortController },
	) => {
		if (!isCurrentRun(activeRun.token)) return;
		forget(saved.session.sessionId);
		if (compact && chosen.length > 0 && !matchesSavedFile(chosen, saved)) {
			updateCompleted(0);
			invalidateOwner();
			runRef.current = null;
			submitting.current = false;
			setError('이전 파일의 업로드가 완료되었습니다. 선택한 파일을 재시도해 주세요.');
			setPhase('error');
			return;
		}
		const nextCompleted = (saved.completed ?? completedRef.current) + 1;
		updateCompleted(nextCompleted);
		if (nextCompleted < chosen.length) {
			await uploadQueue(chosen, undefined, activeRun);
			return;
		}
		if (!isCurrentRun(activeRun.token)) return;
		setPhase('ready');
		invalidateOwner();
		onComplete?.();
	}, [compact, matchesSavedFile, forget, invalidateOwner, isCurrentRun, onComplete, updateCompleted, uploadQueue]);
	const observeSavedReady = useCallback(async (
		saved: SavedImageSession,
		chosen: readonly File[],
		activeRun = beginRun(),
	) => {
		if (!activeRun) return;
		const { token, controller } = activeRun;
		setPhase('verifying');
		setError(null);
		try {
			await waitForDirectAssetReady(saved.session.sessionId, { signal: controller.signal });
			if (!isCurrentRun(token)) return;
			await continueAfterReady(saved, chosen, activeRun);
		} catch (cause) {
			if (!isCurrentRun(token) || controller.signal.aborted) return;
			setError(getApiErrorMessage(cause));
			setPhase('error');
		} finally {
			if (runRef.current?.token === token) {
				runRef.current = null;
				submitting.current = false;
			}
		}
	}, [beginRun, continueAfterReady, isCurrentRun]);
	const cancelLateSession = useCallback(async (saved: SavedImageSession) => {
		const sessionId = saved.session.sessionId;
		if (cancellationRequestedSessionIdsRef.current.has(sessionId)) return;
		cancellationRequestedSessionIdsRef.current.add(sessionId);
		cancelling.current = true;
		let verificationSaved: SavedImageSession | null = null;
		try {
			await cancelDirectAssetUploadSession(sessionId);
			forget(sessionId);
			if (mountedRef.current) {
				setProgress(null);
				setError(null);
				setPhase('idle');
			}
		} catch (cause) {
			try {
				const status = await getDirectAssetUploadStatus(sessionId);
				if (!mountedRef.current) return;
				if (status.state === 'CANCELLED') {
					forget(sessionId);
					setProgress(null);
					setError(null);
					setPhase('idle');
				} else if (status.state === 'READY' || status.state === 'COMPLETING' || status.state === 'VERIFYING') {
					cancellationIntentRef.current = false;
					verificationSaved = saved;
				} else {
					setError(getApiErrorMessage(cause));
					setPhase('idle');
				}
			} catch {
				if (mountedRef.current) {
					setError(getApiErrorMessage(cause));
					setPhase('idle');
				}
			}
		} finally {
			cancellationRequestedSessionIdsRef.current.delete(sessionId);
			finishCancellation();
			if (verificationSaved && mountedRef.current) void observeSavedReady(verificationSaved, files);
		}
	}, [files, finishCancellation, forget, observeSavedReady]);
	cancelLateSessionRef.current = cancelLateSession;
	const resumeQueue = useCallback(async (chosen: readonly File[], saved: SavedImageSession) => {
		if (!matchesSavedFile(chosen, saved)) {
			setError('중단된 파일과 선택한 파일 순서 또는 크기가 일치하지 않습니다.');
			setPhase('idle');
			return;
		}
		const activeRun = beginRun();
		if (!activeRun) return;
		const { token, controller } = activeRun;
		try {
			const status = await getDirectAssetUploadStatus(saved.session.sessionId, controller.signal);
			if (!isCurrentRun(token)) return;
			if (status.state === 'UPLOADING' && status.generation === saved.session.generation) {
				await uploadQueue(chosen, saved, activeRun);
				return;
			}
			if ((status.state === 'COMPLETING' || status.state === 'VERIFYING') && status.generation === saved.session.generation) {
				await observeSavedReady(saved, chosen, activeRun);
				return;
			}
			if (status.state === 'READY' && status.generation === saved.session.generation) {
				await continueAfterReady(saved, chosen, activeRun);
				return;
			}
			if (status.state === 'CANCELLED') forget(saved.session.sessionId);
			else {
				setError(`업로드 세션을 재개할 수 없습니다 (${status.state}).`);
				setPhase('idle');
			}
		} catch (cause) {
			if (!isCurrentRun(token) || controller.signal.aborted) return;
			setError(getApiErrorMessage(cause));
			setPhase('idle');
		} finally {
			if (runRef.current?.token === token) {
				runRef.current = null;
				submitting.current = false;
			}
		}
	}, [beginRun, continueAfterReady, forget, isCurrentRun, matchesSavedFile, observeSavedReady, uploadQueue]);

	useEffect(() => {
		if (!autoStart || !restoreDone || autoStarted.current || initialFiles.length === 0) return;
		autoStarted.current = true;
		if (!autoPausedRef.current) {
			const saved = resumableRef.current;
			if (saved) void resumeQueue(initialFiles, saved);
			else void uploadQueue(initialFiles);
		}
	}, [autoStart, initialFiles, restoreDone, resumeQueue, uploadQueue]);

	const pause = useCallback(() => {
		if (!runRef.current && !restoreControllerRef.current) return;
		autoPausedRef.current = true;
		pausedRunTokenRef.current = runRef.current?.token ?? null;
		abortLocalWork();
		setError(null);
		setPhase('idle');
	}, [abortLocalWork]);
	const cancel = useCallback(async () => {
		if (cancelling.current) return;
		cancellationIntentRef.current = true;
		autoPausedRef.current = true;
		for (const token of pendingCreateTokensRef.current) cancelledRunTokensRef.current.add(token);
		pausedRunTokenRef.current = null;
		abortLocalWork();
		const saved = resumableRef.current;
		if (!saved) {
			setError(null);
			setPhase('idle');
			finishCancellation();
			return;
		}
		cancelling.current = true;
		cancellationRequestedSessionIdsRef.current.add(saved.session.sessionId);
		setPhase('idle');
		const cancelToken = ++runTokenRef.current;
		let verificationSaved: SavedImageSession | null = null;
		try {
			await cancelDirectAssetUploadSession(saved.session.sessionId);
			forget(saved.session.sessionId);
			if (mountedRef.current && runTokenRef.current === cancelToken) {
				setPhase('idle');
				setProgress(null);
				setError(null);
			}
		} catch (cancelError) {
			if (!mountedRef.current || runTokenRef.current !== cancelToken) return;
			try {
				const status = await getDirectAssetUploadStatus(saved.session.sessionId);
				if (!mountedRef.current || runTokenRef.current !== cancelToken) return;
				if (status.state === 'CANCELLED') {
					forget(saved.session.sessionId);
					setProgress(null);
					setError(null);
					setPhase('idle');
				} else if (status.state === 'READY') {
					cancellationIntentRef.current = false;
					verificationSaved = saved;
				} else if (status.state === 'COMPLETING' || status.state === 'VERIFYING') {
					cancellationIntentRef.current = false;
					remember(saved.session, { name: saved.originalName, size: saved.totalBytes }, saved.completed ?? completedRef.current);
					verificationSaved = saved;
				} else {
					remember(saved.session, { name: saved.originalName, size: saved.totalBytes }, saved.completed ?? completedRef.current);
					if (status.state === 'REJECTED' || status.state === 'EXPIRED') setError(`업로드 세션이 ${status.state.toLowerCase()} 상태입니다.`);
					setPhase('idle');
				}
			} catch {
				if (mountedRef.current && runTokenRef.current === cancelToken) {
					setError(getApiErrorMessage(cancelError));
					setPhase('idle');
				}
			}
		} finally {
			cancellationRequestedSessionIdsRef.current.delete(saved.session.sessionId);
			finishCancellation();
			if (verificationSaved && mountedRef.current && runTokenRef.current === cancelToken) {
				void observeSavedReady(verificationSaved, files);
			}
		}
	}, [abortLocalWork, files, finishCancellation, forget, observeSavedReady, remember]);

	const start = () => {
		const saved = resumableRef.current;
		if (saved) void resumeQueue(files, saved);
		else void uploadQueue(files);
	};
	const retry = start;

	const previousRetryAttempt = useRef(retryAttempt);
	const reportedError = useRef<string | null>(null);
	useEffect(() => {
		if (phase !== 'error') reportedError.current = null;
		else if (error && reportedError.current !== error) {
			reportedError.current = error;
			onError?.(error);
		}
	}, [phase, error, onError]);
	useEffect(() => {
		if (previousRetryAttempt.current === retryAttempt) return;
		previousRetryAttempt.current = retryAttempt;
		if (phase === 'error' || phase === 'idle') start();
	// The explicit retry counter is the only trigger; handlers retain the latest recovery state.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [retryAttempt]);


	const canSelect = !compact && !autoStart && (phase === 'idle' || phase === 'error');

	return (
		<div className="game-upload">
			{!compact && !hideTitle && <h3 className="game-upload__title">{title}</h3>}
			{resumable && phase === 'idle' && <p className="field-hint">중단된 업로드가 있습니다. 동일한 파일을 다시 선택해 재개하세요.</p>}
			{canSelect && (
				<div className="game-upload__file-input">
					<label className="sr-only" htmlFor={fileInputId}>{title} 파일 선택</label>
					<input id={fileInputId} type="file" multiple={kind === 'IMAGE'} accept="image/*,application/pdf,.pdf" onChange={(event) => {
						const selected = Array.from(event.target.files ?? []);
						setFiles(selected);
						const saved = resumableRef.current;
						if (!saved || !matchesSavedFile(selected, saved)) updateCompleted(0);
						else updateCompleted(saved.completed ?? 0);
						setError(null);
					}} />
				</div>
			)}
			{!compact && files.length > 0 && <p className="game-upload__file-summary">{files.length}개 파일 선택됨 ({completed}/{files.length} 완료)</p>}
			{progress && (phase === 'uploading' || phase === 'verifying' || phase === 'ready') && (
				<div className="game-upload__progress-wrap" role="status" aria-live="polite">
					<div className="game-upload__progress-track" role="progressbar" aria-label={`${title} 업로드 진행률`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
						<div className={`game-upload__progress-bar ${phase === 'ready' ? 'game-upload__progress-bar--done' : ''}`} style={{ width: `${progress.percent}%` }} />
						<span className="game-upload__progress-label">{progress.percent}%</span>
					</div>
					<p className="game-upload__progress-status">
						{phase === 'ready' ? '업로드 완료!' : phase === 'verifying' ? '이미지 검증 및 변환 중…' : '업로드 중…'}
					</p>
				</div>
			)}
			{error && <p className="game-upload__error" role="alert">{error}</p>}
			<div className="game-upload__actions">
				{phase === 'idle' && files.length > 0 && <button className="btn btn--primary" type="button" onClick={start}>{resumable ? '이어올리기' : `${title} 시작`}</button>}
				{phase === 'error' && files.length > 0 && <button className="btn btn--primary" type="button" onClick={retry}>재시도</button>}
				{(phase === 'uploading' || phase === 'verifying') && <button className="btn btn--secondary btn--small" type="button" onClick={pause}>일시 정지</button>}
				{phase !== 'ready' && (files.length > 0 || resumable || phase === 'verifying') && <button className="btn btn--danger btn--small" type="button" onClick={() => void cancel()}>취소</button>}
				{phase === 'ready' && <span className="game-upload__complete-text">{title} 완료</span>}
			</div>
		</div>
	);
}
