import { useContext, useEffect, useSyncExternalStore } from 'react';
import { UploadProgressReporter } from '../../lib/upload/linearPresentation';
import type { FileUploadQueue, FileUploadRowState } from '../../lib/upload/fileUploadQueue';

const labels = {
 waiting: '대기', checking: '파일 확인 중', preparing: '업로드 준비 중', uploading: '전송 중', transferred: '전송 완료',
 completing: '완료 처리 중', verifying: '검증 중', ready: '완료', failed: '실패', cancelled: '취소 완료',
 cancelling: '취소 처리 중', 'cancel-unconfirmed': '취소 결과 미확정',
};
const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
export function FileUploadRow({ row, queue, disabled = false }: { row: FileUploadRowState; queue: FileUploadQueue; disabled?: boolean }) {
 const report = useContext(UploadProgressReporter);
 const sent = ['transferred', 'completing', 'verifying', 'ready'].includes(row.phase);
 const total = row.size ?? row.progress?.totalBytes;
 const loaded = sent ? total ?? 0 : row.progress?.uploadedBytes ?? 0;
 const percent = sent ? 100 : row.progress?.percent ?? 0;
 const retry = row.phase === 'failed' || row.phase === 'cancelled';
 const cancelling = row.phase === 'cancelling';
 const uncertain = row.phase === 'cancel-unconfirmed';
 useEffect(() => { report?.(row.id, { loaded, total, count: 1, percent }); }, [report, row.id, loaded, total, percent]);
 useEffect(() => () => { report?.(row.id, null); }, [report, row.id]);
 return <div className="upload-file-row" data-file-id={row.id} data-phase={row.phase}>
  <span className="upload-file-row__name" title={row.name}>{row.name}</span>
  <span className="upload-file-row__state" role="status">{labels[row.phase]}</span>
  <div className="upload-file-row__meter">
   <progress max={100} value={percent} aria-label={`${row.name} 업로드 진행률`} />
   <span>{percent}% · {bytes(loaded)} / {total === undefined ? '크기 확인 중' : bytes(total)}</span>
  </div>
  <div className="upload-file-row__actions">
   {!sent && !retry && <button type="button" className="btn btn--secondary btn--small" disabled={disabled || cancelling} aria-label={`${row.name} ${uncertain ? '취소 다시 시도' : '취소'}`} onClick={() => void queue.cancel(row.id)}>{uncertain ? '취소 다시 시도' : '취소'}</button>}
   {retry && row.file && <button type="button" className="btn btn--secondary btn--small" disabled={disabled} aria-label={`${row.name} 재시도`} onClick={() => queue.retry(row.id)}>재시도</button>}
   {(!row.file || row.phase === 'failed') && ['waiting', 'failed', 'cancelled'].includes(row.phase) && <label className="upload-file-row__select">파일 선택<input disabled={disabled} type="file" aria-label={`${row.name} 원본 파일 선택`} onChange={event => { const file = event.target.files?.[0]; if (file) void queue.select(row.id, file); event.target.value = ''; }} /></label>}
  </div>
  {row.error && <p className="upload-file-row__error" role="alert">{row.error}</p>}
 </div>;
}
export function FileUploadRows({ queue, disabled = false, list = false }: { queue: FileUploadQueue; disabled?: boolean; list?: boolean }) {
 const rows = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
 return <>{rows.map(row => list ? <li key={row.id}><FileUploadRow row={row} queue={queue} disabled={disabled} /></li> : <FileUploadRow key={row.id} row={row} queue={queue} disabled={disabled} />)}</>;
}
