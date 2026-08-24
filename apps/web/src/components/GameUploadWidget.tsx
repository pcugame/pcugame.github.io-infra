/** Direct Garage multipart uploader for project GAME and WEBGL sources. */

import { useState, useCallback, useEffect } from 'react';
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

type UploadState = 'idle' | 'uploading' | 'verifying' | 'completed' | 'error' | 'cancelled';

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
	const isWebgl = uploadKind === 'WEBGL';
	const labels = isWebgl
		? { title: 'WebGL 빌드 업로드 (ZIP 파일)', noun: 'WebGL 빌드' }
		: { title: '게임 파일 업로드 (ZIP 파일)', noun: '게임 파일' };
	const [file, setFile] = useState<File | null>(initialFile ?? null);
	const [state, setState] = useState<UploadState>('idle');
	const [progress, setProgress] = useState<DirectAssetUploadProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [session, setSession] = useState<DirectAssetUploadSession | null>(null);
	const [sessionRestored, setSessionRestored] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const directSessionStorageKey = `pcu.direct-asset-upload:${projectId}:${uploadKind}`;

	const rememberSession = useCallback((next: DirectAssetUploadSession) => {
		setSession(next);
		window.sessionStorage.setItem(directSessionStorageKey, JSON.stringify(next));
	}, [directSessionStorageKey]);
	const forgetSession = useCallback(() => {
		setSession(null);
		window.sessionStorage.removeItem(directSessionStorageKey);
	}, [directSessionStorageKey]);

	useEffect(() => {
		let cancelled = false;
		const polling = new AbortController();
		async function restoreSession() {
			const raw = window.sessionStorage.getItem(directSessionStorageKey);
			if (!raw) return;
			let keepForBackgroundVerification = false;
			try {
				const candidate = JSON.parse(raw) as DirectAssetUploadSession;
				if (candidate.kind !== uploadKind) throw new Error('asset upload kind mismatch');
				const status = await getDirectAssetUploadStatus(candidate.sessionId);
				if (!cancelled && status.state === 'UPLOADING' && status.generation === candidate.generation) {
					setSession(candidate);
					return;
				}
				if (!cancelled && ['COMPLETING', 'VERIFYING'].includes(status.state) && status.generation === candidate.generation) {
					keepForBackgroundVerification = true;
					setSession(candidate);
					setState('verifying');
					await waitForDirectAssetReady(candidate.sessionId, { signal: polling.signal });
					if (!cancelled) {
						forgetSession();
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
			} catch (cause) {
				if (keepForBackgroundVerification) {
					if (!cancelled && !polling.signal.aborted) {
						setError(getApiErrorMessage(cause));
						setState('error');
					}
					return;
				}
				// stale, unauthorized, or malformed saved session
			}
			window.sessionStorage.removeItem(directSessionStorageKey);
		}
		void restoreSession().finally(() => {
			if (!cancelled) setSessionRestored(true);
		});
		return () => { cancelled = true; polling.abort(); };
	}, [directSessionStorageKey, forgetSession, onComplete, projectId, qc, uploadKind]);

	const handleFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
		setFile(event.target.files?.[0] ?? null);
		setError(null);
	}, []);

	const runUpload = useCallback(async (uploadFile: File, resume?: DirectAssetUploadSession) => {
		if (submitting) return;
		setSubmitting(true);
		setState('uploading');
		setError(null);
		try {
			const completion = await uploadDirectAssetFile(projectId, uploadFile, uploadKind, (next) => {
				setProgress(next);
				if (next.percent >= 100) setState('verifying');
			}, {
				...(resume ? { resume } : {}),
				onSession: rememberSession,
				...(submissionItem ? { submissionItem } : {}),
			});
			if (completion.status === 'VERIFYING') {
				setState('verifying');
				await waitForDirectAssetReady(completion.sessionId);
			}
			forgetSession();
			setState('completed');
			qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
			onComplete?.();
		} catch (cause) {
			setError(getApiErrorMessage(cause));
			setState('error');
		} finally {
			setSubmitting(false);
		}
	}, [forgetSession, onComplete, projectId, qc, rememberSession, submissionItem, submitting, uploadKind]);

	useEffect(() => {
		if (!autoStart || !initialFile || !sessionRestored) return;
		void runUpload(initialFile, session ?? undefined);
	// Auto-start belongs to this concrete file/session pair, not later file input changes.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [autoStart, initialFile, sessionRestored]);

	const handleStart = useCallback(() => {
		if (file) void runUpload(file);
	}, [file, runUpload]);
	const handleResume = useCallback(() => {
		if (file && session) void runUpload(file, session);
	}, [file, runUpload, session]);
	const handleCancel = useCallback(async () => {
		if (!session) return;
		try {
			await cancelDirectAssetUploadSession(session.sessionId);
			forgetSession();
			setState('cancelled');
			setProgress(null);
		} catch (cause) {
			setError(getApiErrorMessage(cause));
		}
	}, [forgetSession, session]);

	const fileSizeMB = file ? (file.size / 1024 / 1024).toFixed(1) : '0';
	return (
		<div className="game-upload">
			<h3 className="game-upload__title">{labels.title}</h3>
			{session && state === 'idle' && (
				<div className="game-upload__resume-banner">
					<p className="game-upload__resume-text">직접 업로드가 중단되었습니다. 동일한 {labels.noun}을 선택해 재개하세요.</p>
				</div>
			)}
			{(state === 'idle' || state === 'error' || state === 'cancelled') && (
				<div className="game-upload__file-input">
					<input type="file" accept=".zip,application/zip,application/x-zip-compressed" onChange={handleFileChange} />
					{file && <p className="file-info">{file.name} — {fileSizeMB}MB</p>}
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
			<div className="game-upload__actions">
				{state === 'idle' && file && !session && <button className="btn btn--primary" onClick={handleStart}>업로드 시작</button>}
				{state === 'idle' && file && session && <>
					<button className="btn btn--primary" onClick={handleResume}>이어올리기</button>
					<button className="btn btn--danger btn--small" onClick={() => void handleCancel()}>취소 (세션 삭제)</button>
				</>}
				{(state === 'error' || state === 'cancelled') && file && <button className="btn btn--primary" onClick={session ? handleResume : handleStart}>재시도</button>}
				{(state === 'error' || state === 'cancelled') && session && <button className="btn btn--danger btn--small" onClick={() => void handleCancel()}>취소 (세션 삭제)</button>}
				{state === 'completed' && <span className="game-upload__complete-text">업로드 완료</span>}
				{onSkip && state !== 'uploading' && state !== 'verifying' && state !== 'completed' && <button className="btn btn--secondary" onClick={onSkip}>건너뛰기</button>}
			</div>
		</div>
	);
}
