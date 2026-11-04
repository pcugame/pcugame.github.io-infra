import { useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import { MaterialFileRow } from '../project/editor/MaterialFileRow';
import { Button, ProgressBar, StatusBadge, type StatusBadgeProps } from '../ui';
import { UploadProgressReporter } from '../../lib/upload/linearPresentation';
import type { FileUploadQueue, FileUploadRowState } from '../../lib/upload/fileUploadQueue';

const labels = {
 waiting: '대기', checking: '파일 확인 중', preparing: '업로드 준비 중', uploading: '전송 중', transferred: '전송 완료',
 completing: '완료 처리 중', verifying: '검증 중', ready: '완료', failed: '실패', cancelled: '취소 완료',
 cancelling: '취소 처리 중', 'cancel-unconfirmed': '취소 결과 미확정',
};
const tones: Record<FileUploadRowState['phase'], StatusBadgeProps['tone']> = {
 waiting: 'neutral', checking: 'info', preparing: 'info', uploading: 'info', transferred: 'info', completing: 'info', verifying: 'info', ready: 'success', failed: 'danger', cancelled: 'neutral', cancelling: 'warning', 'cancel-unconfirmed': 'warning',
};
const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
export function FileUploadRow({ row, queue, disabled = false, material = false }: { row: FileUploadRowState; queue: FileUploadQueue; disabled?: boolean; material?: boolean }) {
 const report = useContext(UploadProgressReporter);
 const fileInput = useRef<HTMLInputElement>(null);
 const sent = ['transferred', 'completing', 'verifying', 'ready'].includes(row.phase);
 const total = row.size ?? row.progress?.totalBytes;
 const loaded = sent ? total ?? 0 : row.progress?.uploadedBytes ?? 0;
 const percent = sent ? 100 : row.progress?.percent ?? 0;
 const retry = row.phase === 'failed' || row.phase === 'cancelled';
 const cancelling = row.phase === 'cancelling';
 const uncertain = row.phase === 'cancel-unconfirmed';
 useEffect(() => { report?.(row.id, { loaded, total, count: 1, percent }); }, [report, row.id, loaded, total, percent]);
 useEffect(() => () => { report?.(row.id, null); }, [report, row.id]);
 const source = (!row.file || row.phase === 'failed') && ['waiting', 'failed', 'cancelled'].includes(row.phase);
 if (material) return <div data-file-id={row.id} data-phase={row.phase}><MaterialFileRow name={row.name} kind={row.kind} size={total} status={labels[row.phase]} statusTone={tones[row.phase]} error={row.error} failed={retry || uncertain}
  actions={!sent && !retry ? [{ label: uncertain ? '취소 다시 시도' : '취소', disabled: disabled || cancelling, onClick: () => { void queue.cancel(row.id); } }] : []}
  primaryAction={<>
   {retry && row.file && <Button variant="secondary" size="small" disabled={disabled} aria-label={`${row.name} 재시도`} onClick={() => queue.retry(row.id)}>재시도</Button>}
   {source && <><Button variant="secondary" size="small" disabled={disabled} aria-label={`${row.name} 원본 선택`} onClick={() => fileInput.current?.click()}>{row.file ? '원본 다시 선택' : '파일 선택'}</Button><input ref={fileInput} hidden disabled={disabled} type="file" aria-label={`${row.name} 원본 파일 선택`} onChange={event => { const file = event.target.files?.[0]; if (file) void queue.select(row.id, file); event.target.value = ''; }} /></>}
  </>}>
  <ProgressBar className="material-file__meter" size="sm" tone={row.phase === 'failed' ? 'danger' : 'info'} value={percent} aria-label={`${row.name} 업로드 진행률`} /><span>{percent}% · {bytes(loaded)} / {total === undefined ? '크기 확인 중' : bytes(total)}</span>
 </MaterialFileRow></div>;
 return <div className="upload-file-row" data-file-id={row.id} data-phase={row.phase}>
  <span className="upload-file-row__name" title={row.name}>{row.name}</span>
  <StatusBadge size="sm" tone={tones[row.phase]} role="status">{labels[row.phase]}</StatusBadge>
  <div className="upload-file-row__meter">
   <ProgressBar size="sm" tone={row.phase === 'failed' ? 'danger' : 'info'} value={percent} aria-label={`${row.name} 업로드 진행률`} />
   <span>{percent}% · {bytes(loaded)} / {total === undefined ? '크기 확인 중' : bytes(total)}</span>
  </div>
  <div className="upload-file-row__actions">
   {!sent && !retry && <Button variant="secondary" size="small" disabled={disabled || cancelling} aria-label={`${row.name} ${uncertain ? '취소 다시 시도' : '취소'}`} onClick={() => void queue.cancel(row.id)}>{uncertain ? '취소 다시 시도' : '취소'}</Button>}
   {retry && row.file && <Button variant="secondary" size="small" disabled={disabled} aria-label={`${row.name} 재시도`} onClick={() => queue.retry(row.id)}>재시도</Button>}
   {(!row.file || row.phase === 'failed') && ['waiting', 'failed', 'cancelled'].includes(row.phase) && <>
    <Button variant="secondary" size="small" disabled={disabled} aria-label={`${row.name} 원본 선택`} onClick={() => fileInput.current?.click()}>{row.file ? '원본 다시 선택' : '파일 선택'}</Button>
    <input ref={fileInput} hidden disabled={disabled} type="file" aria-label={`${row.name} 원본 파일 선택`} onChange={event => { const file = event.target.files?.[0]; if (file) void queue.select(row.id, file); event.target.value = ''; }} />
   </>}
  </div>
  {row.error && <p className="upload-file-row__error" role="alert">{row.error}</p>}
 </div>;
}
export function FileUploadRows({ queue, disabled = false, list = false }: { queue: FileUploadQueue; disabled?: boolean; list?: boolean }) {
 const rows = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
 return <>{rows.map(row => list ? <li key={row.id}><FileUploadRow row={row} queue={queue} disabled={disabled} /></li> : <FileUploadRow key={row.id} row={row} queue={queue} disabled={disabled} />)}</>;
}
