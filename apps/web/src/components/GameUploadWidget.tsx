import { usePreventWindowClose } from './common/usePreventWindowClose';
import { useContext } from 'react';
import { LinearUploadContext } from '../lib/upload/linearPresentation';
import { UploadFileRows } from './common/UploadFileRows';
/** Direct Garage multipart uploader for project GAME and WEBGL sources. */

import { useState, useCallback, useEffect, useId, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/query';
import { getApiErrorMessage } from '../lib/api';
import {
	getDirectAssetUploadStatus,
	waitForDirectAssetReady,
	type DirectAssetUploadProgress,
	type DirectAssetUploadSession,
} from '../lib/api/game-upload';
import type { SubmissionBinding } from '../lib/upload/directUploadTask';
import { useDirectUploadSession } from '../lib/upload/useDirectUploadSession';
import type { UploadKind } from '../contracts';

type UploadState = 'idle' | 'uploading' | 'verifying' | 'completed' | 'error';

interface Props {
	operationKey?: string;
	projectId: number;
	initialFile?: File | null;
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
	uploadKind?: UploadKind;
	submissionItem?: SubmissionBinding;
}

export default function GameUploadWidget(props: Props) {
	return <GameUploadSession key={`${props.projectId}:${props.uploadKind ?? 'GAME'}`} {...props} />;
}

function GameUploadSession({
	operationKey,
	projectId,
	initialFile,
	autoStart,
	onComplete,
	onError,
	cancelAttempt = 0,
	retryAttempt = 0,
	onCancelled,
	displayNames,
	compact = false,
	onSkip,
	uploadKind = 'GAME',
	submissionItem,
}: Props) {
	const linear = useContext(LinearUploadContext);
	const qc = useQueryClient();
	const fileInputId = useId();
	const isWebgl = uploadKind === 'WEBGL';
	const labels = isWebgl
		? { title: 'WebGL 빌드 업로드 (ZIP 파일)', noun: 'WebGL 빌드' }
		: { title: '게임 파일 업로드 (ZIP 파일)', noun: '게임 파일' };
	const [file, setFile] = useState<File | null>(initialFile ?? null);
	const [state, setState] = useState<UploadState>('idle');
	usePreventWindowClose(linear && (state === 'uploading' || state === 'verifying'));
	const [progress, setProgress] = useState<DirectAssetUploadProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [terminalSessionConfirmation, setTerminalSessionConfirmation] = useState<{
		sessionId: string;
		generation: number;
	} | null>(null);
	const [sessionRestored, setSessionRestored] = useState(false);
	const autoStartedRef = useRef(false);
	const autoPausedRef = useRef(false);
	const onCompleteRef = useRef(onComplete);
	useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
	const restoredFileMatchesRef = useRef(true);
	const restoredSessionIdRef = useRef<string | null>(null);
	const directSessionStorageKey = `pcu.direct-asset-upload:${projectId}:${uploadKind}`;

	const {
		saved: session, getSaved, remember: rememberSession, forget, isMounted,
		beginRun, isCurrentRun, finishRun, pause: pauseSession, cancel: cancelSession,
		transfer, acceptReady, restore: restoreTask, restoreRequired, matchesFile, isPendingCreate, handoff, taskMessage,
	} = useDirectUploadSession<DirectAssetUploadSession>({
		storageKey: directSessionStorageKey, operationKey, onCancelled,
		recovery: { owner: { type: 'PROJECT', id: projectId }, kind: uploadKind,
			items: submissionItem ? [submissionItem] : [], files: initialFile ? [initialFile] : [],
			toSaved: (session) => session },
		onCancelReady: async (candidate, serverState, status) => {
			// A restored ZIP must match the selection before reporting its completion.
			checkRestoredFile(candidate, status, file);
			if (file && !await matchesFile(file)) restoredFileMatchesRef.current = false;
			if (serverState === 'READY') {
				const run = beginRun();
				if (!run) return;
				if (acceptReady(run, candidate.sessionId, candidate.generation)) reportCompletion();
				finishRun(run.token);
			} else void waitForSessionReady(candidate);
		},
		onCancelError: (cause, _terminalState, status) => {
			const candidate = getSaved();
			if (candidate && status && markTerminalSession(candidate, status)) return;
			if (!status) setError(getApiErrorMessage(cause));
			setState('idle');
		},
		onCancelSettled: () => {
            autoPausedRef.current = true;
			setTerminalSessionConfirmation(null);
			setProgress(null);
			setError(null);
			setState('idle');
		},
	});
	const forgetSession = useCallback((expectedSessionId: string) => {
		if (!forget(expectedSessionId)) return false;
		if (isMounted()) setTerminalSessionConfirmation((current) => (
			current?.sessionId === expectedSessionId ? null : current
		));
		return true;
	}, [forget, isMounted]);
	const markTerminalSession = useCallback((candidate: DirectAssetUploadSession, status: {
		sessionId: string;
		generation: number;
		state: string;
	}) => {
		if (!isMounted()
			|| getSaved()?.sessionId !== candidate.sessionId
			|| getSaved()?.generation !== candidate.generation
			|| status.sessionId !== candidate.sessionId
			|| status.generation !== candidate.generation
			|| !['REJECTED', 'EXPIRED'].includes(status.state)) return false;
		autoStartedRef.current = true;
		setTerminalSessionConfirmation({ sessionId: candidate.sessionId, generation: candidate.generation });
		setError('업로드 세션을 다시 이어올릴 수 없습니다. 원본 ZIP 파일을 선택한 뒤 새 업로드 시작을 눌러 다시 올리세요.');
		setState('idle');
		return true;
	}, [getSaved, isMounted]);
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
		if (!restoredFileMatchesRef.current) {
			setError('이전 파일의 업로드가 완료되었습니다. 선택한 파일을 재시도해 주세요.');
			setState('error');
			return;
		}
		setState('completed');
		onCompleteRef.current?.();
	}, [projectId, qc]);

	useEffect(() => {
		let cancelled = false;
		if (!restoreRequired()) { setSessionRestored(true); return; }
		const polling = new AbortController();
		let activeRun: ReturnType<typeof beginRun> = null;
		let token = -1;
		const isCurrentRestoredSession = (candidate: DirectAssetUploadSession | null) => (
			!cancelled
			&& isCurrentRun(token)
			&& !polling.signal.aborted
			&& candidate !== null
			&& getSaved()?.sessionId === candidate.sessionId
			&& getSaved()?.generation === candidate.generation
		);
		const restoreSession = async () => {
			let keepForBackgroundVerification = false;
			let candidate: DirectAssetUploadSession | null = null;
			try {
				candidate = await restoreTask();
				if (cancelled || !candidate) return;
				activeRun = beginRun();
				if (!activeRun) return;
				token = activeRun.token;
				activeRun.controller.signal.addEventListener('abort', () => polling.abort(), { once: true });
				if (candidate.kind !== uploadKind || candidate.owner.type !== 'PROJECT' || candidate.owner.id !== projectId) throw new Error('asset upload owner/kind mismatch');
				restoredSessionIdRef.current = candidate.sessionId;
				restoredFileMatchesRef.current = !initialFile;
				rememberSession(candidate);
				const status = await getDirectAssetUploadStatus(candidate.sessionId, polling.signal);
				if (!isCurrentRestoredSession(candidate) || status.sessionId !== candidate.sessionId || status.generation !== candidate.generation || status.kind !== uploadKind || status.owner.type !== 'PROJECT' || status.owner.id !== projectId) return;
				const matchesChosen = !initialFile || (initialFile.name === status.originalName && initialFile.size === status.totalBytes && await matchesFile(initialFile));
				restoredFileMatchesRef.current = matchesChosen;
				if (status.state === 'UPLOADING' && status.generation === candidate.generation) {
					setState('idle'); setError(null);
					rememberSession(candidate);
					return;
				}
				if (['COMPLETING', 'VERIFYING'].includes(status.state) && status.generation === candidate.generation) {
					keepForBackgroundVerification = true;
					rememberSession(candidate);
					setState('verifying');
					await waitForDirectAssetReady(candidate.sessionId, { signal: polling.signal });
					if (isCurrentRestoredSession(candidate)) {
						if (!acceptReady(activeRun, candidate.sessionId, candidate.generation)) return;
						if (!matchesChosen) {
							setState('idle');
							return;
						}
						reportCompletion();
					}
					return;
				}
				if (status.state === 'READY' && status.generation === candidate.generation) {
					if (!acceptReady(activeRun, candidate.sessionId, candidate.generation)) return;
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
		};
		void restoreSession().finally(() => {
			finishRun(token);
			if (!cancelled) setSessionRestored(true);
		});
		return () => {
			cancelled = true;
			polling.abort();
			finishRun(token);
		};
	}, [restoreTask, restoreRequired, matchesFile, isPendingCreate, handoff, directSessionStorageKey, forgetSession, initialFile, markTerminalSession, reportCompletion, projectId, qc, rememberSession, uploadKind, getSaved, beginRun, isCurrentRun, finishRun, acceptReady]);

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
			if (acceptReady(activeRun, candidate.sessionId, candidate.generation)) reportCompletion();
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
			finishRun(token);
		}
	}, [beginRun, acceptReady, isCurrentRun, markTerminalSession, reportCompletion, finishRun]);

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
			if (!resume) {
				restoredSessionIdRef.current = null;
				restoredFileMatchesRef.current = true;
			}
			const completion = await transfer(activeRun, [projectId, uploadFile, uploadKind, (next) => {
				if (!isCurrentRun(token)) return;
				setProgress(next);
				if (next.percent >= 100) setState('verifying');
			}, {
				...(resume ? { resume } : {}),
				...(submissionItem ? { submissionItem: { id: submissionItem.id, clientToken: submissionItem.clientToken } } : {}),
			}], (next) => next);
			if (!isCurrentRun(token)) return;
			restoredFileMatchesRef.current = true;
			if (completion.status === 'VERIFYING') {
				const verificationSession = getSaved();
				if (!verificationSession || verificationSession.sessionId !== completion.sessionId) {
					setError('업로드 세션 정보를 확인할 수 없습니다. 네트워크 연결을 확인한 뒤 다시 시도하세요.');
					setState('error');
					return;
				}
				await waitForSessionReady(verificationSession, activeRun);
				return;
			}
			if (!isCurrentRun(token)) return;
			if (acceptReady(activeRun, completion.sessionId, completion.generation)) reportCompletion();
		} catch (cause) {
			if (!isCurrentRun(token) || controller.signal.aborted) return;
			setError(getApiErrorMessage(cause));
			setState('error');
		} finally {
			finishRun(token);
		}
	}, [beginRun, transfer, getSaved, acceptReady, finishRun, isCurrentRun, reportCompletion, projectId, submissionItem, uploadKind, waitForSessionReady]);

	const resumeUpload = useCallback(async (uploadFile: File, candidate: DirectAssetUploadSession) => {
		const activeRun = beginRun();
		if (!activeRun) return;
		const { token, controller } = activeRun;
		try {
			const status = await getDirectAssetUploadStatus(candidate.sessionId, controller.signal);
			if (!isCurrentRun(token)) return;
			checkRestoredFile(candidate, status, uploadFile);
			if (!await matchesFile(uploadFile)) restoredFileMatchesRef.current = false;
			if (status.state === 'UPLOADING' && status.generation === candidate.generation) {
				await runUpload(uploadFile, candidate, activeRun);
				return;
			}
			if ((status.state === 'COMPLETING' || status.state === 'VERIFYING') && status.generation === candidate.generation) {
				await waitForSessionReady(candidate, activeRun);
				return;
			}
			if (status.state === 'READY' && status.generation === candidate.generation) {
				if (acceptReady(activeRun, candidate.sessionId, candidate.generation)) reportCompletion();
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
			finishRun(token);
		}
	}, [checkRestoredFile, matchesFile, beginRun, acceptReady, finishRun, isCurrentRun, markTerminalSession, reportCompletion, runUpload, waitForSessionReady]);

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
		if (isPendingCreate()) { void restoreTask(); return; }
		if (!file) return;
		void restoreTask().then(saved => {
			if (!isMounted()) return;
			if (saved) void resumeUpload(file, saved);
			else void runUpload(file);
		}).catch(cause => { if (isMounted()) { setError(getApiErrorMessage(cause)); setState('error'); } });
	}, [file, runUpload, resumeUpload, restoreTask, isMounted, isPendingCreate]);
	const handleTerminalRetry = useCallback(() => {
		const candidate = getSaved();
		const confirmation = terminalSessionConfirmation;
		if (!file || !candidate || !confirmation
			|| candidate.sessionId !== confirmation.sessionId
			|| candidate.generation !== confirmation.generation) return;
		const activeRun = beginRun();
		if (!activeRun) return;
		if (!forgetSession(candidate.sessionId)) { finishRun(activeRun.token); return; }
		setProgress(null);
		setError(null);
		void runUpload(file, undefined, activeRun);
	}, [file, forgetSession, runUpload, terminalSessionConfirmation, getSaved, beginRun, finishRun]);
	const handleResume = useCallback(() => {
		if (file && session) void resumeUpload(file, session);
	}, [file, resumeUpload, session]);
	const handlePause = useCallback(() => {
		autoPausedRef.current = true;
		pauseSession();
		setError(null);
		setState('idle');
	}, [pauseSession]);
	const handleCancel = useCallback(async () => {
		autoPausedRef.current = true;
		setState('idle');
		setError(null);
		await cancelSession();
	}, [cancelSession]);


	const previousRetryAttempt = useRef(retryAttempt);
	const reportedError = useRef<string | null>(null);
	useEffect(() => {
		if (state !== 'error') reportedError.current = null;
		else if (error && reportedError.current !== error) {
			reportedError.current = error;
			onError?.(error);
		}
	}, [state, error, onError]);
	useEffect(() => {
		if (previousRetryAttempt.current === retryAttempt) return;
		previousRetryAttempt.current = retryAttempt;
		if (state === 'error' || state === 'idle') {
			if (terminalSessionConfirmation) handleTerminalRetry();
			else if (session) handleResume();
			else handleStart();
		}
	// The explicit retry counter is the only trigger; handlers retain the latest recovery state.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [retryAttempt]);

	const fileSizeMB = file ? (file.size / 1024 / 1024).toFixed(1) : '0';
	const terminalSession = session !== null
		&& terminalSessionConfirmation?.sessionId === session.sessionId
		&& terminalSessionConfirmation.generation === session.generation;
	const lastCancelAttempt = useRef(cancelAttempt);
	useEffect(() => {
		if (lastCancelAttempt.current === cancelAttempt) return;
		lastCancelAttempt.current = cancelAttempt;
		void handleCancel();
	}, [cancelAttempt, handleCancel]);

	const uploadActions = (<div className="game-upload__actions">
				{linear && state === 'idle' && (!file || !terminalSession) && <button className="btn btn--secondary btn--small" type="button" onClick={() => document.getElementById(fileInputId)?.click()}>파일 선택</button>}
				{state === 'idle' && file && !session && <button className="btn btn--primary" type="button" onClick={handleStart}>업로드 시작</button>}
				{state === 'idle' && file && terminalSession && (
					<button className="btn btn--primary" type="button" onClick={handleTerminalRetry}>{linear ? '재시도' : '새 업로드 시작'}</button>
				)}
				{state === 'idle' && file && session && !terminalSession && <>
					<button className="btn btn--primary" type="button" onClick={handleResume}>이어올리기</button>
				</>}
				{state === 'error' && file && <button className="btn btn--primary" type="button" onClick={session ? handleResume : handleStart}>재시도</button>}
				{(state === 'uploading' || state === 'verifying') && <button className="btn btn--secondary btn--small" type="button" onClick={handlePause}>일시 정지</button>}
				{state !== 'completed' && (file || session || state === 'verifying') && <button className="btn btn--danger btn--small" type="button" onClick={() => void handleCancel()}>{linear ? '취소' : '취소 (세션 삭제)'}</button>}
				{state === 'completed' && <span className="game-upload__complete-text">업로드 완료</span>}
				{onSkip && state !== 'uploading' && state !== 'verifying' && state !== 'completed' && <button className="btn btn--secondary" type="button" onClick={onSkip}>건너뛰기</button>}
			</div>);

	return (
		<div className={`game-upload${linear ? ' game-upload--linear' : ''}`} data-phase={state}>
			{linear && <UploadFileRows actions={uploadActions} names={[file?.name ?? displayNames?.[0] ?? labels.noun]} phase={state === 'idle' && error && file ? 'error' : state} percent={progress?.percent} />}
			{!linear && !compact && <h3 className="game-upload__title">{labels.title}</h3>}
			{!linear && session && state === 'idle' && (
				<div className="game-upload__resume-banner">
					<p className="game-upload__resume-text">직접 업로드가 중단되었습니다. 동일한 {labels.noun}을 선택해 재개하세요.</p>
				</div>
			)}
			{(!compact || linear) && (state === 'idle' || state === 'error') && (
				<div className="game-upload__file-input" hidden={linear}>
					<label className="sr-only" htmlFor={fileInputId}>{labels.noun} ZIP 파일 선택</label>
					<input id={fileInputId} type="file" accept=".zip,application/zip,application/x-zip-compressed" onChange={handleFileChange} />
					{file && <p className="game-upload__file-summary">{file.name} — {fileSizeMB}MB</p>}
				</div>
			)}
			{!linear && progress && (state === 'uploading' || state === 'verifying' || state === 'completed') && (
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
			{(error || taskMessage) && <div className="game-upload__error" role="alert">{error || taskMessage}</div>}
			{error && taskMessage && error !== taskMessage && <p role="status">{taskMessage}</p>}
			{!linear && uploadActions}
		</div>
	);
}
