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

type Phase = 'idle' | 'uploading' | 'verifying' | 'ready' | 'error';

const EMPTY_VIDEO_FILES: readonly File[] = [];

interface SavedVideoSession {
	session: DirectAssetUploadSession;
	originalName: string;
	totalBytes: number;
	/** Number of files already completed before the saved in-flight file. */
	completed?: number;
}

interface Props {
	projectId: number;
	initialFiles?: readonly File[];
	autoStart?: boolean;
	onComplete?: () => void;
	onSkip?: () => void;
	/** Available VIDEO slots for this upload operation (project maximum is five). */
	maxFiles?: number;
}

/**
 * Sequential canonical VIDEO uploader. The server permits one live VIDEO
 * multipart session, so selected files deliberately run one at a time.
 */
export default function DirectVideoUploadWidget({
	projectId,
	initialFiles = EMPTY_VIDEO_FILES,
	autoStart = false,
	onComplete,
	onSkip,
	maxFiles = 5,
}: Props) {
	const qc = useQueryClient();
	const [files, setFiles] = useState<File[]>([...initialFiles]);
	const [phase, setPhase] = useState<Phase>('idle');
	const [progress, setProgress] = useState<GameUploadProgress | null>(null);
	const [completed, setCompleted] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [resumable, setResumable] = useState<SavedVideoSession | null>(null);
	const [restoreDone, setRestoreDone] = useState(false);
	const mountedRef = useRef(true);
	const resumableRef = useRef<SavedVideoSession | null>(null);
	const completedRef = useRef(0);
	const autoStarted = useRef(false);
	const submitting = useRef(false);
	const cancelling = useRef(false);
	const runTokenRef = useRef(0);
	const runRef = useRef<{ token: number; controller: AbortController } | null>(null);
	const restoreControllerRef = useRef<AbortController | null>(null);
	const pausedRunTokenRef = useRef<number | null>(null);
	const autoPausedRef = useRef(false);
	const cancelIntentRunTokenRef = useRef<number | null>(null);
	const lateCancelSessionIdRef = useRef<string | null>(null);
	const cancelLateCreatedSessionRef = useRef<(saved: SavedVideoSession, sourceToken: number) => void>(() => undefined);
	const storageKey = `pcu.direct-video-upload:${projectId}`;

	const updateCompleted = useCallback((next: number) => {
		completedRef.current = next;
		if (mountedRef.current) setCompleted(next);
	}, []);
	const remember = useCallback((session: DirectAssetUploadSession, file: Pick<File, 'name' | 'size'>, completedBefore: number, updateUi = true) => {
		const value: SavedVideoSession = { session, originalName: file.name, totalBytes: file.size, completed: completedBefore };
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

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			abortLocalWork();
		};
	}, [abortLocalWork]);

	useEffect(() => {
		let disposed = false;
		const controller = new AbortController();
		restoreControllerRef.current = controller;
		async function restore() {
			const raw = window.sessionStorage.getItem(storageKey);
			if (!raw) return;
			try {
				const saved = JSON.parse(raw) as SavedVideoSession;
				if (saved.session.kind !== 'VIDEO') throw new Error('kind');
				const completedBefore = saved.completed ?? 0;
				updateCompleted(completedBefore);
				remember(saved.session, { name: saved.originalName, size: saved.totalBytes }, completedBefore);
				const status = await getDirectAssetUploadStatus(saved.session.sessionId, controller.signal);
				if (disposed || controller.signal.aborted || status.kind !== 'VIDEO') return;
				if (status.state === 'VERIFYING' || status.state === 'COMPLETING') {
					remember(saved.session, { name: saved.originalName, size: saved.totalBytes }, completedBefore);
					setPhase('verifying');
					await waitForDirectAssetReady(status.sessionId, { signal: controller.signal });
					if (!disposed && !controller.signal.aborted) {
						forget(saved.session.sessionId);
						const nextCompleted = completedBefore + 1;
						updateCompleted(nextCompleted);
						if (initialFiles.length === 0 || nextCompleted >= initialFiles.length) {
							setPhase('ready');
							qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
							onComplete?.();
						} else setPhase('idle');
					}
					return;
				}
				if (status.state === 'UPLOADING') {
					remember(saved.session, { name: saved.originalName, size: saved.totalBytes }, completedBefore);
					return;
				}
				if (status.state === 'READY') {
					forget();
					const nextCompleted = completedBefore + 1;
					updateCompleted(nextCompleted);
					if (initialFiles.length === 0 || nextCompleted >= initialFiles.length) {
						setPhase('ready');
						qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
						onComplete?.();
					} else setPhase('idle');
					return;
				}
				if (status.state === 'CANCELLED') forget();
				else {
					remember(saved.session, { name: saved.originalName, size: saved.totalBytes }, completedBefore);
					setError(`업로드 세션이 ${status.state.toLowerCase()} 상태입니다.`);
					setPhase('idle');
				}
			} catch {
				// An unavailable status must not discard a resumable locator.
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
	}, [forget, initialFiles, onComplete, projectId, qc, remember, storageKey, updateCompleted]);

	const uploadQueue = useCallback(async (
		chosen: readonly File[],
		resume?: SavedVideoSession,
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
				const completion = await uploadDirectAssetFile(projectId, file, 'VIDEO', (next) => {
					if (!isCurrentRun(token)) return;
					setProgress(next);
					if (next.percent >= 100) setPhase('verifying');
				}, {
					...(matchingResume ? { resume: matchingResume } : {}),
					onSession: (next) => {
						const current = isCurrentRun(token);
						const paused = pausedRunTokenRef.current === token && !runRef.current && mountedRef.current;
						const cancelPending = cancelIntentRunTokenRef.current === token;
						if (cancelPending) {
							remember(next, file, index, mountedRef.current);
							cancelLateCreatedSessionRef.current({
								session: next, originalName: file.name, totalBytes: file.size, completed: index,
							}, token);
						} else if (current || paused) remember(next, file, index, true);
						else if (resumableRef.current === null) remember(next, file, index, false);
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
			qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
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
	}, [beginRun, forget, isCurrentRun, onComplete, projectId, qc, remember, updateCompleted]);

	const matchesSavedFile = useCallback((chosen: readonly File[], saved: SavedVideoSession) => {
		const index = saved.completed ?? 0;
		const current = chosen[index];
		return current?.name === saved.originalName && current.size === saved.totalBytes;
	}, []);
	const continueAfterReady = useCallback(async (
		saved: SavedVideoSession,
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
		qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
		onComplete?.();
	}, [forget, isCurrentRun, onComplete, projectId, qc, updateCompleted, uploadQueue]);
	const observeSavedReady = useCallback(async (
		saved: SavedVideoSession,
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
	const cancelLateCreatedSession = useCallback(async (saved: SavedVideoSession, sourceToken: number) => {
		if (lateCancelSessionIdRef.current === saved.session.sessionId) return;
		lateCancelSessionIdRef.current = saved.session.sessionId;
		cancelling.current = true;
		let readySaved: SavedVideoSession | null = null;
		let verificationSaved: SavedVideoSession | null = null;
		try {
			await cancelDirectAssetUploadSession(saved.session.sessionId);
			forget(saved.session.sessionId);
			if (mountedRef.current) {
				setProgress(null);
				setError(null);
				setPhase('idle');
			}
		} catch (cancelError) {
			try {
				const status = await getDirectAssetUploadStatus(saved.session.sessionId);
				if (!mountedRef.current) return;
				if (status.state === 'CANCELLED') {
					forget(saved.session.sessionId);
					setProgress(null);
					setError(null);
					setPhase('idle');
				} else if (status.state === 'READY') {
					readySaved = saved;
				} else if (status.state === 'COMPLETING' || status.state === 'VERIFYING') {
					remember(saved.session, { name: saved.originalName, size: saved.totalBytes }, saved.completed ?? completedRef.current);
					verificationSaved = saved;
				} else {
					remember(saved.session, { name: saved.originalName, size: saved.totalBytes }, saved.completed ?? completedRef.current);
					if (status.state === 'REJECTED' || status.state === 'EXPIRED') setError(`업로드 세션이 ${status.state.toLowerCase()} 상태입니다.`);
					setPhase('idle');
				}
			} catch {
				if (mountedRef.current) {
					setError(getApiErrorMessage(cancelError));
					setPhase('idle');
				}
			}
		} finally {
			cancelling.current = false;
			if (cancelIntentRunTokenRef.current === sourceToken) cancelIntentRunTokenRef.current = null;
			if (mountedRef.current) {
				if (readySaved) {
					const activeRun = beginRun();
					if (activeRun) void continueAfterReady(readySaved, files, activeRun);
				} else if (verificationSaved) void observeSavedReady(verificationSaved, files);
			}
		}
	}, [beginRun, continueAfterReady, files, forget, observeSavedReady, remember]);
	cancelLateCreatedSessionRef.current = cancelLateCreatedSession;
	const resumeQueue = useCallback(async (chosen: readonly File[], saved: SavedVideoSession) => {
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
		pausedRunTokenRef.current = null;
		const activeToken = runRef.current?.token ?? null;
		if (activeToken !== null && !resumableRef.current) cancelIntentRunTokenRef.current = activeToken;
		abortLocalWork();
		const saved = resumableRef.current;
		if (!saved) {
			setPhase('idle');
			return;
		}
		cancelling.current = true;
		setPhase('idle');
		const cancelToken = ++runTokenRef.current;
		let verificationSaved: SavedVideoSession | null = null;
		let readySaved: SavedVideoSession | null = null;
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
					readySaved = saved;
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
			} else if (readySaved && mountedRef.current && runTokenRef.current === cancelToken) {
				const activeRun = beginRun();
				if (activeRun) void continueAfterReady(readySaved, files, activeRun);
			}
		}
	}, [abortLocalWork, beginRun, continueAfterReady, files, forget, observeSavedReady, remember]);

	const start = () => {
		const saved = resumableRef.current;
		if (saved) void resumeQueue(files, saved);
		else void uploadQueue(files);
	};
	const retry = start;

	return (
		<div className="game-upload">
			<h3 className="game-upload__title">동영상 업로드</h3>
			{resumable && phase === 'idle' && (
				<p className="field-hint">중단된 동영상 업로드가 있습니다. 동일한 파일을 다시 선택해 재개하세요.</p>
			)}
			{!autoStart && (phase === 'idle' || phase === 'error') && (
				<input
					type="file"
					multiple
					accept="video/mp4,video/x-matroska,video/webm,video/x-msvideo,video/x-ms-wmv,.mp4,.mkv,.webm,.avi,.wmv"
					onChange={(event) => {
						const selected = Array.from(event.target.files ?? []);
						const saved = resumableRef.current;
						const pendingCount = Math.max(0, selected.length - (saved?.completed ?? 0));
						if (pendingCount > maxFiles) {
							setFiles([]);
							updateCompleted(0);
							setError(`동영상은 프로젝트당 최대 5개까지 등록할 수 있습니다. 현재 ${maxFiles}개까지 추가할 수 있습니다.`);
							event.target.value = '';
							return;
						}
						setFiles(selected);
						if (saved && !matchesSavedFile(selected, saved)) {
							setError('중단된 파일과 선택한 파일 순서 또는 크기가 일치하지 않습니다.');
							return;
						}
						if (saved) updateCompleted(saved.completed ?? 0);
						else updateCompleted(0);
						setError(null);
					}}
					disabled={maxFiles <= 0}
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
				{phase === 'idle' && files.length > 0 && <button className="btn btn--primary" type="button" onClick={start}>{resumable ? '이어올리기' : '동영상 업로드 시작'}</button>}
				{phase === 'error' && files.length > 0 && <button className="btn btn--primary" type="button" onClick={retry}>재시도</button>}
				{(phase === 'uploading' || phase === 'verifying') && <button className="btn btn--secondary btn--small" type="button" onClick={pause}>일시 정지</button>}
				{((phase === 'uploading' || phase === 'verifying') || (resumable && phase !== 'ready')) && <button className="btn btn--danger btn--small" type="button" onClick={() => void cancel()}>취소</button>}
				{phase === 'ready' && <span className="game-upload__complete-text">동영상 업로드 완료</span>}
				{onSkip && phase !== 'uploading' && phase !== 'verifying' && phase !== 'ready' && <button className="btn btn--secondary" type="button" onClick={onSkip}>건너뛰기</button>}
			</div>
		</div>
	);
}
