import { usePreventWindowClose } from './common/usePreventWindowClose';
import { LinearUploadContext } from '../lib/upload/linearPresentation';
import { UploadFileRows } from './common/UploadFileRows';
import { useContext, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getApiErrorMessage } from '../lib/api';
import {
	getDirectAssetUploadStatus,
	waitForDirectAssetReady,
	type DirectAssetUploadSession,
	type DirectAssetUploadProgress,
} from '../lib/api/game-upload';
import { fileVerificationMessage, type SubmissionBinding } from '../lib/upload/directUploadTask';
import { useDirectUploadSession, type UploadRun } from '../lib/upload/useDirectUploadSession';
import { queryKeys } from '../lib/query';
import type { DirectAssetUploadKind } from '../contracts';

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
	operationKey?: string;
	projectId: number;
	initialFiles?: readonly File[];
	autoStart?: boolean;
	onComplete?: () => void;
	onError?: (message: string) => void;
	/** An enclosing Apply action requests a retry without discarding recovery state. */
	cancelAttempt?: number;
	retryAttempt?: number;
	/** Advances an enclosing queue only after cancellation leaves no pending session. */
	onCancelled?: () => void;
	/** An enclosing row provides the heading, chooser, and selected file summary. */
	displayNames?: string[];
	compact?: boolean;
	onSkip?: () => void;
	submissionItems?: readonly SubmissionBinding[];
	/** Available VIDEO slots for this upload operation (project maximum is five). */
	maxFiles?: number;
	maxFileBytes?: number;
	kind?: Extract<DirectAssetUploadKind, 'VIDEO' | 'DOCUMENT' | 'ATTACHMENT'>;
	label?: string;
	accept?: string;
}

/**
 * This widget uploads its selected files sequentially. The database permits
 * concurrent VIDEO sessions in distinct reserved slots (up to five per project).
 */
export default function DirectVideoUploadWidget(props: Props) {
	return <VideoUploadSession key={`${props.projectId}:${props.kind ?? 'VIDEO'}`} {...props} />;
}

function VideoUploadSession({
	operationKey,
	projectId,
	initialFiles = EMPTY_VIDEO_FILES,
	autoStart = false,
	onComplete,
	onError,
	cancelAttempt = 0,
	retryAttempt = 0,
	onCancelled,
	displayNames,
	compact = false,
	onSkip,
	submissionItems = [],
	maxFiles = 5,
	maxFileBytes,
	kind = 'VIDEO',
	label = '동영상',
	accept,
}: Props) {
	const linear = useContext(LinearUploadContext);
	const qc = useQueryClient();
	const recoveringManifest = initialFiles.length === 0 && submissionItems.length > 0;
	const fileInputId = useId();
	const [files, setFiles] = useState<File[]>([...initialFiles]);
	const [phase, setPhase] = useState<Phase>('idle');
	usePreventWindowClose(linear && (phase === 'uploading' || phase === 'verifying'));
	const [progress, setProgress] = useState<DirectAssetUploadProgress | null>(null);
	const [completed, setCompleted] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [terminalSessionId, setTerminalSessionId] = useState<string | null>(null);
	const [restoreDone, setRestoreDone] = useState(false);
	const completedRef = useRef(0);
	const initialFilesRef = useRef(initialFiles);
	const autoStarted = useRef(false);
	const autoPausedRef = useRef(false);
	const completionReported = useRef(false);
	const onCompleteRef = useRef(onComplete);
	useEffect(() => {
		initialFilesRef.current = initialFiles;
		onCompleteRef.current = onComplete;
	}, [initialFiles, onComplete]);
	const storageKey = `pcu.direct-${kind.toLowerCase()}-upload:${projectId}`;

	const reportCompletion = useCallback(() => {
		if (completionReported.current) return;
		completionReported.current = true;
		setPhase('ready');
		qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
		onCompleteRef.current?.();
	}, [projectId, qc]);
	const {
		saved: resumable, getSaved, remember: rememberLocator, forget, isMounted,
		beginRun, isCurrentRun, finishRun, pause: pauseSession, cancel: cancelSession,
		transfer, acceptReady, restore: restoreTask, restoreRequired, matchesFile, isPendingCreate, handoff, taskMessage, canContinue, cancelPending,
	} = useDirectUploadSession<SavedVideoSession>({
		storageKey, operationKey, onCancelled,
		recovery: { owner: { type: 'PROJECT', id: projectId }, kind, items: submissionItems, files: initialFiles,
			toSaved: (session, status, index) => ({ session, originalName: status.originalName, totalBytes: status.totalBytes, completed: index }) },
		onCancelReady: (saved, state) => {
			// READY is already confirmed: continue the video queue without another poll.
			if (state === 'READY') {
				const run = beginRun();
				if (run) void continueAfterReady(saved, files, run).finally(() => finishRun(run.token));
			} else void observeSavedReady(saved, files);
		},
		onCancelError: (cause, terminalState) => {
			if (terminalState) setTerminalSessionId(getSaved()?.session.sessionId ?? null);
			setError(terminalState ? `업로드 세션이 ${terminalState.toLowerCase()} 상태입니다.` : getApiErrorMessage(cause));
			setPhase('idle');
		},
		onCancelSettled: () => { setTerminalSessionId(null); autoPausedRef.current = true; setProgress(null); setError(null); setPhase('idle'); },
	});
	const updateCompleted = useCallback((next: number) => {
		completedRef.current = next;
		if (isMounted()) setCompleted(next);
	}, [isMounted]);
	const remember = useCallback((session: DirectAssetUploadSession, file: Pick<File, 'name' | 'size'>, completedBefore: number) => {
		rememberLocator({ session, originalName: file.name, totalBytes: file.size, completed: completedBefore });
	}, [rememberLocator]);

	useEffect(() => {
		let disposed = false;
		if (!restoreRequired()) { setRestoreDone(true); return; }
		const controller = new AbortController();
		let activeRun: ReturnType<typeof beginRun> = null;
		let token = -1;
		const restore = async () => {
			try {
				const saved = await restoreTask();
				if (disposed || !saved) return;
				activeRun = beginRun();
				if (!activeRun) return;
				token = activeRun.token;
				activeRun.controller.signal.addEventListener('abort', () => controller.abort(), { once: true });
				if (saved.session.kind !== kind || saved.session.owner.type !== 'PROJECT' || saved.session.owner.id !== projectId) throw new Error('owner');
				const chosen = initialFilesRef.current;
				const completedBefore = recoveringManifest || (compact && chosen.length === 1)
					? 0 : saved.completed ?? 0;
				const matchesChosen = chosen.length === 0
					|| (chosen[completedBefore]?.name === saved.originalName && chosen[completedBefore]?.size === saved.totalBytes && await matchesFile(chosen[completedBefore]!));
				updateCompleted(completedBefore);
				remember(saved.session, { name: saved.originalName, size: saved.totalBytes }, completedBefore);
				const status = await getDirectAssetUploadStatus(saved.session.sessionId, controller.signal);
				if (disposed || !isCurrentRun(token) || controller.signal.aborted || status.kind !== kind
					|| status.sessionId !== saved.session.sessionId || status.generation !== saved.session.generation
					|| status.owner.type !== 'PROJECT' || status.owner.id !== projectId) return;
				if (status.state === 'VERIFYING' || status.state === 'COMPLETING') {
					remember(saved.session, { name: saved.originalName, size: saved.totalBytes }, completedBefore);
					setPhase('verifying');
					await waitForDirectAssetReady(status.sessionId, { signal: controller.signal });
					if (!disposed && isCurrentRun(token) && !controller.signal.aborted) {
						if (!matchesChosen) {
							updateCompleted(0);
							setError(fileVerificationMessage);
							setPhase('idle');
							return;
						}
						if (!acceptReady(activeRun, saved.session.sessionId, saved.session.generation)) return;
						const nextCompleted = completedBefore + 1;
						updateCompleted(nextCompleted);
						if (chosen.length === 0 || nextCompleted >= chosen.length) {
							reportCompletion();
						} else setPhase('idle');
					}
					return;
				}
				if (status.state === 'UPLOADING') {
					setPhase('idle'); setError(null);
					remember(saved.session, { name: saved.originalName, size: saved.totalBytes }, completedBefore);
					return;
				}
				if (status.state === 'READY') {
					if (!matchesChosen) {
						updateCompleted(0);
						setError(fileVerificationMessage);
						setPhase('idle');
						return;
					}
					if (!acceptReady(activeRun, saved.session.sessionId, saved.session.generation)) return;
					const nextCompleted = completedBefore + 1;
					updateCompleted(nextCompleted);
					if (chosen.length === 0 || nextCompleted >= chosen.length) {
						reportCompletion();
					} else setPhase('idle');
					return;
				}
				if (status.state === 'CANCELLED') {
					if (matchesChosen) { autoPausedRef.current = true; autoStarted.current = true; }
					else updateCompleted(0);
					forget(saved.session.sessionId);
				}
				else {
					remember(saved.session, { name: saved.originalName, size: saved.totalBytes }, completedBefore);
					if (status.state === 'REJECTED' || status.state === 'EXPIRED') setTerminalSessionId(saved.session.sessionId);
					setError(`업로드 세션이 ${status.state.toLowerCase()} 상태입니다. 종료된 업로드는 새 업로드 시작을 선택해 주세요.`);
					setPhase('idle');
				}
			} catch {
				// An unavailable status must not discard a resumable locator.
			}
		};
		void restore().finally(() => {
			finishRun(token);
			if (!disposed) setRestoreDone(true);
		});
		return () => {
			disposed = true;
			controller.abort();
			finishRun(token);
		};
	}, [restoreTask, restoreRequired, matchesFile, isPendingCreate, handoff, recoveringManifest, compact, forget, kind, projectId, remember, storageKey, updateCompleted, beginRun, finishRun, isCurrentRun, acceptReady, reportCompletion]);

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
				const completion = await transfer(activeRun, [projectId, file, kind, (next) => {
					if (!isCurrentRun(token)) return;
					setProgress(next);
					if (next.percent >= 100) setPhase('verifying');
				}, {
					...(matchingResume ? { resume: matchingResume } : {}),
					recoveryIndex: index,
					...(submissionItems[index] ? { submissionItem: { id: submissionItems[index].id, clientToken: submissionItems[index].clientToken } } : {}),
				}], (session) => ({ session, originalName: file.name, totalBytes: file.size, completed: index }));
				if (!isCurrentRun(token)) return;
				if (completion.status === 'VERIFYING') {
					setPhase('verifying');
					await waitForDirectAssetReady(completion.sessionId, { signal: controller.signal });
				}
				if (!isCurrentRun(token)) return;
				if (!acceptReady(activeRun, completion.sessionId, completion.generation)) return;
				updateCompleted(index + 1);
			}
			if (!isCurrentRun(token)) return;
			reportCompletion();
		} catch (uploadError) {
			if (!isCurrentRun(token) || controller.signal.aborted) return;
			setError(getApiErrorMessage(uploadError));
			setPhase('error');
		} finally {
			finishRun(token);
		}
	}, [beginRun, finishRun, acceptReady, isCurrentRun, kind, reportCompletion, projectId, transfer, submissionItems, updateCompleted]);

	const matchesSavedFile = useCallback((chosen: readonly File[], saved: SavedVideoSession) => {
		const index = saved.completed ?? 0;
		const current = chosen[index];
		return current?.name === saved.originalName && current.size === saved.totalBytes;
	}, []);
	const continueAfterReady = useCallback(async (
		saved: SavedVideoSession,
		chosen: readonly File[],
		activeRun: UploadRun,
	) => {
		if (!isCurrentRun(activeRun.token)) return;
		const matches = chosen.length === 0 || (matchesSavedFile(chosen, saved) && await matchesFile(chosen[saved.completed ?? 0]!));
		if (!matches) {
			updateCompleted(0);
			qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
			finishRun(activeRun.token);
			setError(fileVerificationMessage);
			setPhase('error');
			return;
		}
		if (!acceptReady(activeRun, saved.session.sessionId, saved.session.generation)) return;
		const nextCompleted = (saved.completed ?? completedRef.current) + 1;
		updateCompleted(nextCompleted);
		if (nextCompleted < chosen.length) {
			await uploadQueue(chosen, undefined, activeRun);
			return;
		}
		if (!isCurrentRun(activeRun.token)) return;
		reportCompletion();
	}, [matchesSavedFile, matchesFile, acceptReady, isCurrentRun, reportCompletion, finishRun, projectId, qc, updateCompleted, uploadQueue]);
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
			finishRun(token);
		}
	}, [beginRun, continueAfterReady, isCurrentRun, finishRun]);
	const resumeQueue = useCallback(async (chosen: readonly File[], saved: SavedVideoSession, restartTerminal = false) => {
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
			// A user's retry may start a new transfer only after the server confirms termination.
			if (restartTerminal && status.generation === saved.session.generation && ['REJECTED', 'EXPIRED', 'CANCELLED'].includes(status.state)) {
				forget(saved.session.sessionId);
				setTerminalSessionId(null);
				await uploadQueue(chosen, undefined, activeRun);
				return;
			}
			if (status.state === 'CANCELLED') { forget(saved.session.sessionId); setTerminalSessionId(null); setError(null); setPhase('idle'); }
			else {
				if (status.state === 'REJECTED' || status.state === 'EXPIRED') setTerminalSessionId(saved.session.sessionId);
				setError(`업로드 세션을 재개할 수 없습니다 (${status.state}). 종료된 업로드는 새 업로드 시작을 선택해 주세요.`);
				setPhase('idle');
			}
		} catch (cause) {
			if (!isCurrentRun(token) || controller.signal.aborted) return;
			setError(getApiErrorMessage(cause));
			setPhase('idle');
		} finally {
			finishRun(token);
		}
	}, [beginRun, continueAfterReady, forget, isCurrentRun, matchesSavedFile, observeSavedReady, uploadQueue, finishRun]);

	useEffect(() => {
		if (!autoStart || !restoreDone || autoStarted.current || initialFiles.length === 0) return;
		autoStarted.current = true;
		if (!autoPausedRef.current && phase !== 'ready') {
			const saved = getSaved();
			if (saved) void resumeQueue(initialFiles, saved);
			else void uploadQueue(initialFiles);
		}
	}, [autoStart, initialFiles, restoreDone, resumeQueue, uploadQueue, getSaved, phase]);

	const pause = useCallback(() => {
		autoPausedRef.current = true;
		pauseSession();
		setError(null);
		setPhase('idle');
	}, [pauseSession]);
	const cancel = useCallback(async () => {
		autoPausedRef.current = true;
		setError(null);
		setPhase('idle');
		await cancelSession();
	}, [cancelSession]);

	const start = () => {
		void restoreTask().then(saved => {
			if (!isMounted() || saved === undefined) return;
			if (saved) void resumeQueue(files, saved, terminalSessionId === saved.session.sessionId);
			else { completionReported.current = false; void uploadQueue(files); }
		}).catch(cause => { if (isMounted()) { setError(getApiErrorMessage(cause)); setPhase('error'); } });
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


	const lastCancelAttempt = useRef(cancelAttempt);
	useEffect(() => {
		if (lastCancelAttempt.current === cancelAttempt) return;
		lastCancelAttempt.current = cancelAttempt;
		void cancel();
	}, [cancelAttempt, cancel]);

	const uploadActions = (<div className="game-upload__actions">
				{linear && phase === 'idle' && <button className="btn btn--secondary btn--small" type="button" onClick={() => document.getElementById(fileInputId)?.click()}>파일 선택</button>}
				{phase === 'idle' && files.length > 0 && <button className="btn btn--primary" type="button" disabled={!canContinue} onClick={start}>{terminalSessionId && terminalSessionId === resumable?.session.sessionId ? '새 업로드 시작' : resumable ? '이어올리기' : `${label} 업로드 시작`}</button>}
				{phase === 'error' && files.length > 0 && <button className="btn btn--primary" type="button" disabled={!canContinue} onClick={retry}>{terminalSessionId && terminalSessionId === resumable?.session.sessionId ? '새 업로드 시작' : '재시도'}</button>}
				{(phase === 'uploading' || phase === 'verifying') && <button className="btn btn--secondary btn--small" type="button" onClick={pause}>일시 정지</button>}
				{phase !== 'ready' && (files.length > 0 || resumable || taskMessage || phase === 'verifying') && <button className="btn btn--danger btn--small" type="button" disabled={cancelPending} onClick={() => void cancel()}>취소</button>}
				{phase === 'ready' && <span className="game-upload__complete-text">{label} 업로드 완료</span>}
				{onSkip && phase !== 'uploading' && phase !== 'verifying' && phase !== 'ready' && <button className="btn btn--secondary" type="button" onClick={onSkip}>건너뛰기</button>}
			</div>);

	return (
		<div className={`game-upload${linear ? ' game-upload--linear' : ''}`} data-phase={phase}>
			{linear && <UploadFileRows actions={uploadActions} names={files.length ? files.map(file => file.name) : (displayNames?.length ? displayNames : [resumable?.originalName ?? label])} completed={files.length ? completed : 0} phase={phase} percent={progress?.percent} />}
			{!linear && !compact && <h3 className="game-upload__title">{label} 업로드</h3>}
			{!linear && resumable && phase === 'idle' && (
				<p className="field-hint">중단된 {label} 업로드가 있습니다. 동일한 파일을 다시 선택해 재개하세요.</p>
			)}
			{((!compact && !autoStart) || linear) && (phase === 'idle' || phase === 'error') && (
				<div className="game-upload__file-input" hidden={linear}>
					<label className="sr-only" htmlFor={fileInputId}>{label} 파일 선택</label>
					<input
						id={fileInputId}
						type="file"
						multiple
					accept={accept ?? (kind === 'VIDEO' ? 'video/mp4,video/x-matroska,video/webm,video/x-msvideo,video/x-ms-wmv,.mp4,.mkv,.webm,.avi,.wmv' : undefined)}
					onChange={(event) => {
						const selected = Array.from(event.target.files ?? []);

						if (maxFileBytes !== undefined && selected.some((file) => file.size > maxFileBytes || file.size === 0)) {
							setFiles([]);
							setError(`빈 파일은 업로드할 수 없으며 파일당 최대 ${maxFileBytes / 1024 / 1024} MiB까지 허용됩니다.`);
							event.target.value = '';
							return;
						}
						const saved = getSaved();
						const pendingCount = Math.max(0, selected.length - (saved?.completed ?? 0));
						if (pendingCount > maxFiles) {
							setFiles([]);
							updateCompleted(0);
							setError(kind === 'VIDEO' ? `동영상은 프로젝트당 최대 5개까지 등록할 수 있습니다. 현재 ${maxFiles}개까지 추가할 수 있습니다.` : `${label}은 현재 ${maxFiles}개까지 추가할 수 있습니다.`);
							event.target.value = '';
							return;
						}
						setFiles(selected);
						completionReported.current = false;
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
				</div>
			)}
			{!linear && !compact && files.length > 0 && <p className="game-upload__file-summary">{files.length}개 {label} 선택됨 ({completed}/{files.length} 완료)</p>}
			{!linear && progress && (phase === 'uploading' || phase === 'verifying' || phase === 'ready') && (
				<div className="game-upload__progress-wrap" role="status" aria-live="polite">
					<div className="game-upload__progress-track" role="progressbar" aria-label={`${label} 업로드 진행률`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
						<div className={`game-upload__progress-bar ${phase === 'ready' ? 'game-upload__progress-bar--done' : ''}`} style={{ width: `${progress.percent}%` }} />
						<span className="game-upload__progress-label">{progress.percent}%</span>
					</div>
					<p className="game-upload__progress-status">
						{phase === 'ready' ? '업로드 완료!' : phase === 'verifying' ? `${label} 검증 중…` : '업로드 중…'}
					</p>
				</div>
			)}
			{(error || taskMessage) && <p className="game-upload__error" role="alert">{error || taskMessage}</p>}
			{error && taskMessage && error !== taskMessage && <p role="status">{taskMessage}</p>}
			{!linear && uploadActions}
		</div>
	);
}
