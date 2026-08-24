import { useCallback, useEffect, useRef, useState } from 'react';
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

type Phase = 'idle' | 'uploading' | 'verifying' | 'ready' | 'error' | 'cancelled';
type ImageKind = Extract<DirectAssetUploadKind, 'IMAGE' | 'POSTER'>;

interface SavedImageSession {
	session: DirectAssetUploadSession;
	originalName: string;
	totalBytes: number;
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

/**
 * Direct image/poster browser control. File bytes only travel to Garage; this
 * component persists enough opaque session metadata to resume after reload.
 */
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
	const [files, setFiles] = useState<File[]>([...initialFiles]);
	const [phase, setPhase] = useState<Phase>('idle');
	const [progress, setProgress] = useState<DirectAssetUploadProgress | null>(null);
	const [completed, setCompleted] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [resumable, setResumable] = useState<SavedImageSession | null>(null);
	const autoStarted = useRef(false);
	const submitting = useRef(false);
	const storageKey = `pcu.direct-${kind.toLowerCase()}-upload:${owner.type}:${owner.id}`;
	const title = kind === 'POSTER' ? '포스터 업로드' : '이미지 업로드';

	const invalidateOwner = useCallback(() => {
		if (owner.type === 'PROJECT') qc.invalidateQueries({ queryKey: queryKeys.adminProject(owner.id) });
		else qc.invalidateQueries({ queryKey: queryKeys.adminExhibitions });
	}, [owner, qc]);
	const forget = useCallback(() => {
		window.sessionStorage.removeItem(storageKey);
		setResumable(null);
	}, [storageKey]);
	const remember = useCallback((session: DirectAssetUploadSession, file: File) => {
		const value: SavedImageSession = { session, originalName: file.name, totalBytes: file.size };
		window.sessionStorage.setItem(storageKey, JSON.stringify(value));
		setResumable(value);
	}, [storageKey]);

	useEffect(() => {
		let cancelled = false;
		async function restore() {
			const raw = window.sessionStorage.getItem(storageKey);
			if (!raw) return;
			try {
				const saved = JSON.parse(raw) as SavedImageSession;
				if (saved.session.kind !== kind || saved.session.owner.type !== owner.type || saved.session.owner.id !== owner.id) throw new Error('owner');
				const status = await getDirectAssetUploadStatus(saved.session.sessionId);
				if (status.kind !== kind || status.owner.type !== owner.type || status.owner.id !== owner.id || cancelled) return;
				if (status.state === 'VERIFYING') {
					setPhase('verifying');
					await waitForDirectAssetReady(status.sessionId);
					if (!cancelled) { forget(); setPhase('ready'); invalidateOwner(); onComplete?.(); }
					return;
				}
				if (status.state === 'UPLOADING' && !cancelled) setResumable(saved);
				else if (!cancelled) window.sessionStorage.removeItem(storageKey);
			} catch {
				if (!cancelled) window.sessionStorage.removeItem(storageKey);
			}
		}
		void restore();
		return () => { cancelled = true; };
	}, [forget, invalidateOwner, kind, onComplete, owner, storageKey]);

	useEffect(() => {
		onBusyChange?.(phase === 'uploading' || phase === 'verifying');
	}, [onBusyChange, phase]);

	const uploadQueue = useCallback(async (chosen: readonly File[], resume?: SavedImageSession) => {
		if (submitting.current || chosen.length === 0) return;
		submitting.current = true;
		setError(null);
		try {
			for (let index = 0; index < chosen.length; index += 1) {
				const file = chosen[index]!;
				setPhase('uploading');
				setProgress(null);
				const matchingResume = index === 0 && resume && resume.originalName === file.name && resume.totalBytes === file.size ? resume.session : undefined;
				const completion = await uploadDirectAssetFile(owner, file, kind, (next) => {
					setProgress(next);
					if (next.percent >= 100) setPhase('verifying');
				}, {
					resume: matchingResume,
					onSession: (session) => remember(session, file),
					...(submissionItems[index] ? { submissionItem: submissionItems[index] } : {}),
				});
				if (completion.status === 'VERIFYING') {
					setPhase('verifying');
					await waitForDirectAssetReady(completion.sessionId);
				}
				forget();
				setCompleted(index + 1);
			}
			setPhase('ready');
			invalidateOwner();
			onComplete?.();
		} catch (uploadError) {
			setError(getApiErrorMessage(uploadError));
			setPhase('error');
		} finally {
			submitting.current = false;
		}
	}, [forget, invalidateOwner, kind, onComplete, owner, remember, submissionItems]);

	useEffect(() => {
		if (!autoStart || autoStarted.current || initialFiles.length === 0) return;
		autoStarted.current = true;
		void uploadQueue(initialFiles);
	}, [autoStart, initialFiles, uploadQueue]);

	const cancel = () => {
		if (!resumable) return;
		void cancelDirectAssetUploadSession(resumable.session.sessionId).then(() => {
			forget(); setPhase('cancelled');
		}).catch((cancelError) => setError(getApiErrorMessage(cancelError)));
	};
	const canSelect = !autoStart && (phase === 'idle' || phase === 'error' || phase === 'cancelled');

	return (
		<div className="game-upload">
			{!hideTitle && <h3 className="game-upload__title">{title}</h3>}
			{resumable && phase === 'idle' && <p className="field-hint">중단된 업로드가 있습니다. 동일한 파일을 다시 선택해 재개하세요.</p>}
			{canSelect && <input type="file" multiple={kind === 'IMAGE'} accept="image/*,application/pdf,.pdf" onChange={(event) => { setFiles(Array.from(event.target.files ?? [])); setError(null); }} />}
			{files.length > 0 && <p className="file-info">{files.length}개 파일 선택됨 ({completed}/{files.length} 완료)</p>}
			{progress && <p className="field-hint">{phase === 'verifying' ? '이미지 검증 및 변환 중…' : `${progress.percent}% 업로드`}</p>}
			{error && <p className="field-error">{error}</p>}
			<div className="game-upload__actions">
				{phase === 'idle' && files.length > 0 && <button className="btn btn--primary" type="button" onClick={() => void uploadQueue(files, resumable ?? undefined)}>{title} 시작</button>}
				{phase === 'error' && files.length > 0 && <button className="btn btn--primary" type="button" onClick={() => void uploadQueue(files, resumable ?? undefined)}>재시도</button>}
				{(phase === 'uploading' || phase === 'error' || phase === 'idle') && resumable && <button className="btn btn--danger btn--small" type="button" onClick={cancel}>취소</button>}
				{phase === 'ready' && <span className="game-upload__complete-text">{title} 완료</span>}
			</div>
		</div>
	);
}
