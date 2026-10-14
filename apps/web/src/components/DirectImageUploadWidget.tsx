import { usePreventWindowClose } from './common/usePreventWindowClose';
import { LinearUploadContext } from '../lib/upload/linearPresentation';
import { UploadFileRows } from './common/UploadFileRows';
import { useContext, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { DirectAssetUploadKind, DirectAssetUploadOwner } from '../contracts';
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
	operationKey?: string;
	owner: DirectAssetUploadOwner;
	kind: ImageKind;
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
	/** Suppress the generic heading when embedded in an asset-management row. */
	hideTitle?: boolean;
	/** Lets an enclosing owner control mutually exclusive mutations such as delete. */
	onBusyChange?: (busy: boolean) => void;
	submissionItems?: readonly SubmissionBinding[];
}

/** Browser control for IMAGE and POSTER sessions; asset bytes go directly to Garage. */
export default function DirectImageUploadWidget(props: Props) {
	// A different owner/kind is a different local lifetime, including queue state.
	return <ImageUploadSession key={`${props.owner.type}:${props.owner.id}:${props.kind}`} {...props} />;
}

function ImageUploadSession({
	operationKey,
	owner: ownerProp,
	kind,
	initialFiles = [],
	autoStart = false,
	onComplete,
	onError,
	cancelAttempt = 0,
	retryAttempt = 0,
	onCancelled,
	displayNames,
	compact = false,
	hideTitle = false,
	onBusyChange,
	submissionItems = [],
}: Props) {
	const owner = useMemo(() => ({ type: ownerProp.type, id: ownerProp.id } as DirectAssetUploadOwner), [ownerProp.type, ownerProp.id]);
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
	const initialFilesRef = useRef(initialFiles);
	const completedRef = useRef(0);
	const autoStarted = useRef(false);
	const autoPausedRef = useRef(false);
	const completionReported = useRef(false);
	const onCompleteRef = useRef(onComplete);
	useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
	const storageKey = `pcu.direct-${kind.toLowerCase()}-upload:${owner.type}:${owner.id}`;
	const title = kind === 'POSTER' ? '포스터 업로드' : '이미지 업로드';

	const invalidateOwner = useCallback(() => {
		if (owner.type === 'PROJECT') qc.invalidateQueries({ queryKey: queryKeys.adminProject(owner.id) });
		else qc.invalidateQueries({ queryKey: queryKeys.adminExhibitions });
	}, [owner, qc]);
	const reportCompletion = useCallback(() => {
		if (completionReported.current) return;
		completionReported.current = true;
		setPhase('ready');
		invalidateOwner();
		onCompleteRef.current?.();
	}, [invalidateOwner]);
	const {
		saved: resumable, getSaved, remember: rememberLocator, forget, isMounted,
		beginRun, isCurrentRun, finishRun, pause: pauseSession, cancel: cancelSession,
		transfer, acceptReady, restore: restoreTask, restoreRequired, matchesFile, isPendingCreate, handoff, taskMessage, canContinue, cancelPending,
	} = useDirectUploadSession<SavedImageSession>({
		storageKey, operationKey, onCancelled,
		recovery: { owner: owner, kind, items: submissionItems, files: initialFiles,
			toSaved: (session, status, index) => ({ session, originalName: status.originalName, totalBytes: status.totalBytes, completed: index }) },
		onCancelReady: (saved) => { void observeSavedReady(saved, files); },
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
		initialFilesRef.current = initialFiles;
	}, [initialFiles]);

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
				if (saved.session.kind !== kind || saved.session.owner.type !== owner.type || saved.session.owner.id !== owner.id) throw new Error('owner');
				const chosen = initialFilesRef.current;
				const completedBefore = recoveringManifest || (compact && chosen.length === 1)
					? 0 : saved.completed ?? 0;
				const matchesChosen = chosen.length === 0
					|| (chosen[completedBefore]?.name === saved.originalName && chosen[completedBefore]?.size === saved.totalBytes && await matchesFile(chosen[completedBefore]!));
				// Preserve a valid opaque locator even when status is temporarily unavailable.
				remember(saved.session, { name: saved.originalName, size: saved.totalBytes }, completedBefore);
				updateCompleted(completedBefore);
				const status = await getDirectAssetUploadStatus(saved.session.sessionId, controller.signal);
				if (disposed || !isCurrentRun(token) || controller.signal.aborted
					|| status.sessionId !== saved.session.sessionId || status.kind !== kind || status.owner.type !== owner.type || status.owner.id !== owner.id
					|| status.generation !== saved.session.generation) return;
				if (status.state === 'VERIFYING' || status.state === 'COMPLETING') {
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
						if (initialFilesRef.current.length === 0 || nextCompleted >= initialFilesRef.current.length) {
							reportCompletion();
						} else setPhase('idle');
					}
					return;
				}
				if (status.state === 'UPLOADING') {
					setPhase('idle'); setError(null);
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
					if (initialFilesRef.current.length === 0 || nextCompleted >= initialFilesRef.current.length) {
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
					if (status.state === 'REJECTED' || status.state === 'EXPIRED') setTerminalSessionId(saved.session.sessionId);
					setError(`업로드 세션이 ${status.state.toLowerCase()} 상태입니다. 종료된 업로드는 새 업로드 시작을 선택해 주세요.`);
					setPhase('idle');
				}
			} catch (cause) {
				if (!disposed && isCurrentRun(token) && !controller.signal.aborted) {
					setError(getApiErrorMessage(cause));
					setPhase('idle');
				}
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
	}, [restoreTask, restoreRequired, matchesFile, isPendingCreate, handoff, recoveringManifest, compact, forget, reportCompletion, kind, owner, remember, storageKey, updateCompleted, beginRun, finishRun, isCurrentRun, acceptReady]);

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
				const completion = await transfer(activeRun, [owner, file, kind, (next) => {
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
	}, [beginRun, finishRun, acceptReady, reportCompletion, isCurrentRun, kind, owner, transfer, submissionItems, updateCompleted]);

	const matchesSavedFile = useCallback((chosen: readonly File[], saved: SavedImageSession) => {
		const current = chosen[saved.completed ?? 0];
		return current?.name === saved.originalName && current.size === saved.totalBytes;
	}, []);
	const continueAfterReady = useCallback(async (
		saved: SavedImageSession,
		chosen: readonly File[],
		activeRun: UploadRun,
	) => {
		if (!isCurrentRun(activeRun.token)) return;
		const matches = chosen.length === 0 || (matchesSavedFile(chosen, saved) && await matchesFile(chosen[saved.completed ?? 0]!));
		if (!matches) {
			updateCompleted(0);
			invalidateOwner();
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
	}, [matchesSavedFile, matchesFile, acceptReady, invalidateOwner, isCurrentRun, reportCompletion, finishRun, updateCompleted, uploadQueue]);
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
			finishRun(token);
		}
	}, [beginRun, continueAfterReady, isCurrentRun, finishRun]);
	const resumeQueue = useCallback(async (chosen: readonly File[], saved: SavedImageSession, restartTerminal = false) => {
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


	const canSelect = ((!compact && !autoStart) || linear) && (phase === 'idle' || phase === 'error');

	const lastCancelAttempt = useRef(cancelAttempt);
	useEffect(() => {
		if (lastCancelAttempt.current === cancelAttempt) return;
		lastCancelAttempt.current = cancelAttempt;
		void cancel();
	}, [cancelAttempt, cancel]);

	const uploadActions = (<div className="game-upload__actions">
				{linear && phase === 'idle' && <button className="btn btn--secondary btn--small" type="button" onClick={() => document.getElementById(fileInputId)?.click()}>파일 선택</button>}
				{phase === 'idle' && files.length > 0 && <button className="btn btn--primary" type="button" disabled={!canContinue} onClick={start}>{terminalSessionId && terminalSessionId === resumable?.session.sessionId ? '새 업로드 시작' : resumable ? '이어올리기' : `${title} 시작`}</button>}
				{phase === 'error' && files.length > 0 && <button className="btn btn--primary" type="button" disabled={!canContinue} onClick={retry}>{terminalSessionId && terminalSessionId === resumable?.session.sessionId ? '새 업로드 시작' : '재시도'}</button>}
				{(phase === 'uploading' || phase === 'verifying') && <button className="btn btn--secondary btn--small" type="button" onClick={pause}>일시 정지</button>}
				{phase !== 'ready' && (files.length > 0 || resumable || taskMessage || phase === 'verifying') && <button className="btn btn--danger btn--small" type="button" disabled={cancelPending} onClick={() => void cancel()}>취소</button>}
				{phase === 'ready' && <span className="game-upload__complete-text">{title} 완료</span>}
			</div>);

	return (
		<div className={`game-upload${linear ? ' game-upload--linear' : ''}`} data-phase={phase}>
			{linear && <UploadFileRows actions={uploadActions} names={files.length ? files.map(file => file.name) : (displayNames?.length ? displayNames : [resumable?.originalName ?? title])} completed={files.length ? completed : 0} phase={phase} percent={progress?.percent} />}
			{!linear && !compact && !hideTitle && <h3 className="game-upload__title">{title}</h3>}
			{!linear && resumable && phase === 'idle' && <p className="field-hint">중단된 업로드가 있습니다. 동일한 파일을 다시 선택해 재개하세요.</p>}
			{canSelect && (
				<div className="game-upload__file-input" hidden={linear}>
					<label className="sr-only" htmlFor={fileInputId}>{title} 파일 선택</label>
					<input id={fileInputId} type="file" multiple={kind === 'IMAGE'} accept="image/*,application/pdf,.pdf" onChange={(event) => {
						const selected = Array.from(event.target.files ?? []);
						setFiles(selected);
						completionReported.current = false;
						const saved = getSaved();
						if (!saved || !matchesSavedFile(selected, saved)) updateCompleted(0);
						else updateCompleted(saved.completed ?? 0);
						setError(null);
					}} />
				</div>
			)}
			{!linear && !compact && files.length > 0 && <p className="game-upload__file-summary">{files.length}개 파일 선택됨 ({completed}/{files.length} 완료)</p>}
			{!linear && progress && (phase === 'uploading' || phase === 'verifying' || phase === 'ready') && (
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
			{(error || taskMessage) && <p className="game-upload__error" role="alert">{error || taskMessage}</p>}
			{error && taskMessage && error !== taskMessage && <p role="status">{taskMessage}</p>}
			{!linear && uploadActions}
		</div>
	);
}
