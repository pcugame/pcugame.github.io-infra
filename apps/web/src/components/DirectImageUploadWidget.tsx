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
	hideTitle = false,
	onBusyChange,
	submissionItems = [],
}: Props) {
	const qc = useQueryClient();
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
	const cancellationRequestedSessionIdsRef = useRef(new Set<string>());
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
	const beginRun = useCallback(() => {
		if (submitting.current || cancelling.current || !mountedRef.current) return null;
		const controller = new AbortController();
		const token = ++runTokenRef.current;
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
	const cancelLateSession = useCallback(async (sessionId: string) => {
		if (cancellationRequestedSessionIdsRef.current.has(sessionId)) return;
		cancellationRequestedSessionIdsRef.current.add(sessionId);
		try {
			await cancelDirectAssetUploadSession(sessionId);
			forget(sessionId);
		} catch {
			try {
				const status = await getDirectAssetUploadStatus(sessionId);
				if (status.state === 'CANCELLED') forget(sessionId);
			} catch {
				// The locator remains available when neither DELETE nor status confirms cancellation.
			}
		}
	}, [forget]);

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
				const completedBefore = saved.completed ?? 0;
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
	}, [forget, invalidateOwner, kind, onComplete, owner, remember, storageKey, updateCompleted]);

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
				const completion = await uploadDirectAssetFile(owner, file, kind, (next) => {
					if (!isCurrentRun(token)) return;
					setProgress(next);
					if (next.percent >= 100) setPhase('verifying');
				}, {
					...(matchingResume ? { resume: matchingResume } : {}),
					onSession: (next) => {
						const current = isCurrentRun(token);
						const paused = pausedRunTokenRef.current === token && !runRef.current && mountedRef.current;
						const cancelRequested = cancelledRunTokensRef.current.delete(token);
						// A create response can arrive after its caller was aborted. Retain the
						// opaque locator first; unmounts deliberately stop here, while a
						// cancellation intent schedules its own authenticated control request.
						remember(next, file, index, current || paused || (cancelRequested && mountedRef.current));
						if (cancelRequested) void cancelLateSession(next.sessionId);
					},
					...(submissionItems[index] ? { submissionItem: submissionItems[index] } : {}),
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
			if (runRef.current?.token === token) {
				runRef.current = null;
				submitting.current = false;
			}
		}
	}, [beginRun, cancelLateSession, forget, invalidateOwner, isCurrentRun, kind, onComplete, owner, remember, submissionItems, updateCompleted]);

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
	}, [forget, invalidateOwner, isCurrentRun, onComplete, updateCompleted, uploadQueue]);
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
		const activeToken = runRef.current?.token;
		if (activeToken !== undefined) cancelledRunTokensRef.current.add(activeToken);
		pausedRunTokenRef.current = null;
		abortLocalWork();
		const saved = resumableRef.current;
		if (!saved) {
			setError(null);
			setPhase('idle');
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
					verificationSaved = saved;
				} else if (status.state === 'COMPLETING' || status.state === 'VERIFYING') {
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
			cancelling.current = false;
			if (verificationSaved && mountedRef.current && runTokenRef.current === cancelToken) {
				void observeSavedReady(verificationSaved, files);
			}
		}
	}, [abortLocalWork, files, forget, observeSavedReady, remember]);

	const start = () => {
		const saved = resumableRef.current;
		if (saved) void resumeQueue(files, saved);
		else void uploadQueue(files);
	};
	const retry = start;

	const canSelect = !autoStart && (phase === 'idle' || phase === 'error');

	return (
		<div className="game-upload">
			{!hideTitle && <h3 className="game-upload__title">{title}</h3>}
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
			{files.length > 0 && <p className="game-upload__file-summary">{files.length}개 파일 선택됨 ({completed}/{files.length} 완료)</p>}
			{progress && (
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
				{((phase === 'uploading' || phase === 'verifying') || (resumable && phase !== 'ready')) && <button className="btn btn--danger btn--small" type="button" onClick={() => void cancel()}>취소</button>}
				{phase === 'ready' && <span className="game-upload__complete-text">{title} 완료</span>}
			</div>
		</div>
	);
}
