import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { IconDots, IconFile, IconMovie, IconPhoto, IconPackage, IconWorld } from '@tabler/icons-react';
import type { ProjectUploadKind } from '../../../lib/upload/project-files';

export type MaterialAction = { label: string; onClick: () => void; disabled?: boolean };
function FileMenu({ name, actions }: { name: string; actions: MaterialAction[] }) {
 const [open, setOpen] = useState(false);
 const root = useRef<HTMLDivElement>(null);
 const trigger = useRef<HTMLButtonElement>(null);
 const id = useId();
 const close = (restore = true) => { setOpen(false); if (restore) trigger.current?.focus(); };
 useEffect(() => {
  if (!open) return;
  root.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
  document.addEventListener('pointerdown', outside);
  return () => document.removeEventListener('pointerdown', outside);
 }, [open]);
 return <div className="material-file__menu" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  if (!open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const items = Array.from(root.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[index]?.focus();
 }}>
  <button ref={trigger} type="button" className="btn btn--secondary btn--small material-file__more" aria-label={`${name} 더보기`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)} onKeyDown={event => { if (!open && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); } }}><IconDots size={20} aria-hidden="true" /></button>
  {open && <div id={id} role="menu" aria-label={`${name} 작업`} className="material-file__menu-items">{actions.map(action => <button key={action.label} type="button" role="menuitem" disabled={action.disabled} onClick={() => { close(); action.onClick(); }}>{action.label}</button>)}</div>}
 </div>;
}

export function MaterialFileRow({ name, kind, size, status, error, failed, icon, actions = [], primaryAction, children }: {
 name: string; kind: ProjectUploadKind; size?: number; status: string; error?: string | null; failed?: boolean;
 icon?: ReactNode; actions?: MaterialAction[]; primaryAction?: ReactNode; children?: ReactNode;
}) {
 const Icon = kind === 'VIDEO' ? IconMovie : kind === 'POSTER' || kind === 'IMAGE' ? IconPhoto : kind === 'GAME' ? IconPackage : kind === 'WEBGL' ? IconWorld : IconFile;
 return <div className="material-file" data-failed={failed || undefined}>
  <div className="material-file__icon">{icon ?? <Icon size={24} aria-hidden="true" />}</div>
  <strong className="material-file__name" title={name}>{name}</strong>
  <span className="material-file__status" role="status">{status}</span>
  <div className="material-file__actions">{primaryAction}{actions.length > 0 && <FileMenu name={name} actions={actions} />}</div>
  {children && <div className="material-file__progress">{children}</div>}
  <details className="material-file__details"><summary>{error ? '실패 이유 · 파일 정보' : '파일 정보'}</summary><p>{name}</p><p>{size === undefined ? '크기 확인 중' : `${(size / 1024 / 1024).toFixed(2)} MB`}</p>{error && <p className="field-error">{error}</p>}</details>
 </div>;
}
