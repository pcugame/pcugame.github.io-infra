import { LinearUploadContext, UploadProgressReporter } from '../../lib/upload/linearPresentation';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { claimUploadPresentation } from '../../lib/upload/presentation';
import { usePreventWindowClose } from './usePreventWindowClose';

/** Children stay mounted across visibility changes so retries keep their upload owner. */
export function ProjectUploadDialog({ open, title, description, completed, total, busy, children, actions }: {
 open: boolean; title: string; description: string; completed: number; total: number;
 busy: boolean; children: ReactNode; actions?: ReactNode;
}) {
 const [progress, setProgress] = useState<Record<string, number>>({});
 const report = useCallback((id: string, value: number | null) => setProgress(previous => {
  if (value === null && !(id in previous) || value === previous[id]) return previous;
  const next = { ...previous };
  if (value === null) delete next[id]; else next[id] = value;
  return next;
 }), []);
 const percent = total > 0 ? Math.min(100, Math.floor(Object.values(progress).reduce((sum, value) => sum + value, 0) / total)) : 0;
 const ref = useRef<HTMLDialogElement>(null);
 const id = useId();
 usePreventWindowClose(open && busy);
 useEffect(() => {
  if (!open) return;
  const release = claimUploadPresentation();
  const dialog = ref.current!;
  const previous = document.activeElement as HTMLElement | null;
  const overflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  dialog.showModal();
  return () => {
   dialog.close();
   document.body.style.overflow = overflow;
   release();
   if (previous?.isConnected) previous.focus({ preventScroll: true });
  };
 }, [open]);
 return createPortal(<dialog ref={ref} className="project-upload-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onCancel={event => event.preventDefault()}>
  <header className="project-upload-dialog__header">
   <h2 id={`${id}-title`} tabIndex={-1} autoFocus>{title}</h2>
   <span className="project-upload-dialog__count" aria-label="파일 검증 완료">{percent}% · {completed} / {total}</span>
   <progress className="project-upload-dialog__progress" aria-label="전체 파일 업로드 진행률" max={100} value={percent} />
   <p id={`${id}-description`} className="sr-only">{description}</p>
  </header>
  <LinearUploadContext.Provider value={true}><UploadProgressReporter.Provider value={report}><div className="project-upload-dialog__body">{children}</div></UploadProgressReporter.Provider></LinearUploadContext.Provider>
  {actions && <footer className="project-upload-dialog__footer">{actions}</footer>}
 </dialog>, document.body);
}
