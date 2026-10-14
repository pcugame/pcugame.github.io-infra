import { useCallback, useEffect, useRef, useState } from 'react';
import { getDirectAssetUploadStatus, waitForDirectAssetReady, type DirectAssetUploadSession } from '../../lib/api/game-upload';
import { getApiErrorMessage } from '../../lib/api';
import { useDirectUploadSession, type UploadRun } from '../../lib/upload/useDirectUploadSession';

export function VotePosterUpload({ voteId, exhibitionId, onReady }: {
	voteId: string; exhibitionId: number; onReady: (id: string) => void;
}) {
	const [file, setFile] = useState<File | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [status, setStatus] = useState('');
	const [terminal, setTerminal] = useState(false);
	const onReadyRef = useRef(onReady);
	useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
	const {
		getSaved, restore, beginRun, finishRun, isCurrentRun, isMounted, transfer, acceptRestoredReady, selectFiles, getSelectedFiles,
		forget, cancel, taskMessage, handoff, saved, canContinue, cancelPending,
	} = useDirectUploadSession<DirectAssetUploadSession>({
		storageKey: `pcu.vote-poster:${voteId}`, operationKey: `vote:${voteId}`, initialSelection: file ? [file] : [],
		recovery: { owner: { type: 'EXHIBITION', id: exhibitionId }, kind: 'POSTER', items: [], files: file ? [file] : [], toSaved: session => session },
		onCancelled: () => { selectFiles([]); setFile(null); setStatus('업로드가 취소되었습니다.'); },
		onCancelReady: candidate => { void observe(candidate); },
		onCancelError: cause => { setError(getApiErrorMessage(cause)); setBusy(false); },
		onCancelSettled: () => { setBusy(false); setError(''); setTerminal(false); },
	});
	const observe = useCallback(async (candidate: DirectAssetUploadSession, activeRun = beginRun()) => {
		if (!activeRun) return;
		const { token, controller } = activeRun;
		try {
			const current = await getDirectAssetUploadStatus(candidate.sessionId, controller.signal);
			if (!isCurrentRun(token)) return;
			if (['REJECTED', 'EXPIRED', 'CANCELLED'].includes(current.state)) {
				setTerminal(true); throw new Error(`업로드가 종료되었습니다 (${current.state}). 새 업로드를 시작할 수 있습니다.`);
			}
			if (current.state === 'UPLOADING' || current.state === 'ALLOCATING') {
				setStatus('이전 업로드를 이어가려면 같은 파일을 선택하고 재시도해 주세요.'); return;
			}
			setBusy(true); setStatus('포스터 처리 중…');
			await waitForDirectAssetReady(candidate.sessionId, { signal: controller.signal });
			if (!isCurrentRun(token)) return;
			if (!await acceptRestoredReady(activeRun, candidate.sessionId, candidate.generation) || !isCurrentRun(token)) return;
			setBusy(false); selectFiles([]); setFile(null); setStatus('포스터가 준비되었습니다.');
			onReadyRef.current(candidate.sessionId);
		} catch (cause) {
			if (isCurrentRun(token)) setError(getApiErrorMessage(cause));
		} finally { if (isCurrentRun(token)) setBusy(false); finishRun(token); }
	}, [beginRun, isCurrentRun, acceptRestoredReady, finishRun, selectFiles]);
	useEffect(() => {
		let disposed = false;
		void restore().then(candidate => { if (!disposed && candidate) void observe(candidate); })
			.catch(cause => { if (!disposed) setError(getApiErrorMessage(cause)); });
		return () => { disposed = true; };
	}, [restore, observe, handoff]);

	async function upload(chosen: File) {
		const selected = getSelectedFiles();
		let run: UploadRun | null = null;
		try {
			const candidate = await restore();
			if (!isMounted() || getSelectedFiles() !== selected || selected[0] !== chosen || candidate === undefined) return;
			run = beginRun(); if (!run) return;
			setBusy(true); setError(''); setTerminal(false);
			if (candidate) {
				const current = await getDirectAssetUploadStatus(candidate.sessionId, run.controller.signal);
				if (!isCurrentRun(run.token)) return;
				if (current.state !== 'UPLOADING') { await observe(candidate, run); return; }
			}
			const result = await transfer(run, [{ type: 'EXHIBITION', id: exhibitionId }, chosen, 'POSTER', p => setStatus(`업로드 ${p.percent}%`), {
				voteId, ...(candidate ? { resume: candidate } : {}),
			}], session => session);
			if (!isCurrentRun(run.token)) return;
			const confirmed = getSaved();
			if (confirmed && confirmed.sessionId === result.sessionId) await observe(confirmed, run);
		} catch (cause) { if (isMounted() && getSelectedFiles() === selected && (!run || isCurrentRun(run.token))) setError(getApiErrorMessage(cause)); }
		finally { if (getSelectedFiles() === selected && (!run || isCurrentRun(run.token))) setBusy(false); if (run) finishRun(run.token); }
	}
	function startNew() {
		const candidate = getSaved();
		if (!terminal || !candidate || !file || !forget(candidate.sessionId)) return;
		setTerminal(false); void upload(file);
	}
	return <div className="vote-upload form-field">
		<label className="form-field form-field__label">투표 전용 포스터 업로드
			<input className="form-control" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" disabled={busy || !canContinue}
				onChange={event => { const chosen = event.target.files?.[0]; if (chosen) { selectFiles([chosen]); setFile(chosen); void upload(chosen); } }} />
		</label>
		<p className="field-hint">이 이미지를 투표 화면에 공개합니다. 작품·전시회 원본 포스터는 변경하지 않습니다.</p>
		<p role="status" className="field-hint">{status}</p>
		{!busy && file && <button type="button" className="btn btn--secondary" disabled={!canContinue} onClick={() => terminal ? startNew() : void upload(file)}>{terminal ? '새 업로드 시작' : '재시도'}</button>}
		{(file || saved || taskMessage) && <button type="button" className="btn btn--danger" disabled={cancelPending} onClick={() => void cancel()}>취소</button>}
		{(error || taskMessage) && <p role="alert" className="error-box error-box__message">{error || taskMessage}</p>}
		{error && taskMessage && error !== taskMessage && <p role="status">{taskMessage}</p>}
	</div>;
}
