import { useContext, useEffect, useId, type ReactNode } from 'react';
import { UploadProgressReporter } from '../../lib/upload/linearPresentation';

export function UploadFileRows({ names, completed = 0, percent = 0, phase = 'idle', actions }: {
 names: string[]; completed?: number; percent?: number; phase?: string; actions?: ReactNode;
}) {
 const report = useContext(UploadProgressReporter);
 const id = useId();
 const ready = phase === 'ready' || phase === 'completed';
 const safePercent = phase === 'verifying' ? 100 : Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
 const sum = ready ? names.length * 100 : Math.min(completed, names.length) * 100 + (completed < names.length ? safePercent : 0);
 useEffect(() => { report?.(id, sum); }, [report, id, sum]);
 useEffect(() => () => { report?.(id, null); }, [report, id]);
 return <div className="upload-file-rows">{names.map((name, index) => {
  const done = index < completed || ready;
  const current = index === completed;
  const recoverable = current && (phase === 'error' || phase === 'idle');
  return <div className="upload-file-row" key={`${index}:${name}`}>
   <span className="upload-file-row__name" title={name}>{name}</span>
   <span className="upload-file-row__state">{done ? '완료' : current && phase === 'verifying' ? '검증 중' : current && phase === 'uploading' ? '전송 중' : phase === 'error' && current ? '실패' : '대기'}</span>
   {recoverable && actions}
  </div>;
 })}</div>;
}
