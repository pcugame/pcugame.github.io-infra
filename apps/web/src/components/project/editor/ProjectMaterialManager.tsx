import '../../../styles/features/material-manager.css';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ProjectUploadKind } from '../../../lib/upload/project-files';
import type { FileUploadRowState } from '../../../lib/upload/fileUploadQueue';
import { claimUploadPresentation } from '../../../lib/upload/presentation';

import { materialGroups, type MaterialGroup, type MaterialGroupId } from './materialGroups';
export function ProjectMaterialManager({ groups, busy = false, firstKind, summary }: {
 groups: { id: MaterialGroupId; count: number; failed?: boolean; content: ReactNode }[];
 busy?: boolean; firstKind?: ProjectUploadKind; summary?: ReactNode;
}) {
 const id = useId();
 const [active, setActive] = useState<MaterialGroupId>('poster');
 const tabs = useRef<HTMLDivElement>(null);
 const [started, setStarted] = useState(false);
 useEffect(() => claimUploadPresentation(), []);
 if (busy && !started && firstKind) {
  setActive(materialGroups.find(group => (group.kinds as readonly string[]).includes(firstKind))!.id);
  setStarted(true);
 }
 if (!busy && started) setStarted(false);
 useEffect(() => {
  const container = tabs.current!;
  const reveal = () => {
   const selected = container.querySelector<HTMLElement>('[aria-selected="true"]');
   if (!selected || !container.clientWidth) return;
   const bounds = container.getBoundingClientRect(), target = selected.getBoundingClientRect();
   if (target.left < bounds.left) container.scrollLeft -= bounds.left - target.left;
   else if (target.right > bounds.right) container.scrollLeft += target.right - bounds.right;
  };
  reveal();
  if (typeof ResizeObserver === 'undefined') return;
  const observer = new ResizeObserver(reveal);
  observer.observe(container);
  return () => observer.disconnect();
 }, [active]);
 const failed = groups.find(group => group.failed);
 return <div className="material-manager">
  <div className="material-manager__tabs" ref={tabs} role="tablist" aria-label="자료 종류" onKeyDown={event => {
   if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
   event.preventDefault();
   const index = materialGroups.findIndex(group => group.id === active);
   const next = event.key === 'Home' ? 0 : event.key === 'End' ? 4 : (index + (event.key === 'ArrowRight' ? 1 : 4)) % 5;
   setActive(materialGroups[next].id);
   tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }}>{materialGroups.map(group => {
   const info = groups.find(item => item.id === group.id)!;
   return <button key={group.id} type="button" role="tab" id={`${id}-${group.id}`} aria-controls={`${id}-${group.id}-panel`} aria-selected={active === group.id} tabIndex={active === group.id ? 0 : -1} onClick={() => setActive(group.id)}>{group.label}<span className="material-manager__count">{info.count}</span>{info.failed && <span className="material-manager__failure" aria-label="실패">!</span>}</button>;
  })}</div>
  {(summary || failed) && <div className="material-manager__summary">{summary}{failed && <button type="button" className="btn btn--secondary btn--small" onClick={() => { setActive(failed.id); tabs.current?.querySelector<HTMLButtonElement>(`[aria-controls="${id}-${failed.id}-panel"]`)?.focus(); }}>실패 파일 보기</button>}</div>}
  {groups.map(group => <section key={group.id} role="tabpanel" id={`${id}-${group.id}-panel`} aria-labelledby={`${id}-${group.id}`} hidden={active !== group.id}>{group.content}</section>)}
 </div>;
}

export function MaterialPanel({ group, count, enabled, hint, error, onFiles, children, actions, help }: {
 group: MaterialGroup; count: number; enabled: boolean; hint: string; error?: string | null; onFiles: (files: File[]) => void; children?: ReactNode; actions?: ReactNode; help?: ReactNode;
}) {
 const input = useRef<HTMLInputElement>(null);
 const depth = useRef(0);
 const [drag, setDrag] = useState(false);
 const id = useId();
 const single = ['poster', 'native', 'web'].includes(group.id);
 const select = () => input.current?.click();
 useEffect(() => {
  const reset = () => { depth.current = 0; setDrag(false); };
  const prevent = (event: DragEvent) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); };
  window.addEventListener('dragend', reset); window.addEventListener('drop', reset); window.addEventListener('blur', reset); window.addEventListener('dragover', prevent); window.addEventListener('drop', prevent);
  return () => { window.removeEventListener('dragend', reset); window.removeEventListener('drop', reset); window.removeEventListener('blur', reset); window.removeEventListener('dragover', prevent); window.removeEventListener('drop', prevent); };
 }, []);
 return <div className={`material-panel${drag && enabled ? ' is-dragging' : ''}`} data-file-group={group.id} role="group" aria-labelledby={`${id}-title`} aria-describedby={`${id}-hint`} onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { depth.current++; setDrag(true); } }} onDragLeave={() => { if (--depth.current <= 0) { depth.current = 0; setDrag(false); } }} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = enabled ? 'copy' : 'none'; }} onDrop={event => { event.preventDefault(); depth.current = 0; setDrag(false); if (enabled) onFiles(Array.from(event.dataTransfer.files)); }}>
  <header className="material-panel__heading"><h3 id={`${id}-title`}>{group.label} <span>· {count}{single ? '/1' : group.id === 'video' ? '/5' : ''}개</span></h3><div>{actions}<button type="button" className="btn btn--secondary btn--small" disabled={!enabled} aria-label={`${group.label} 파일 선택`} onClick={select}>{single && count > 0 ? '교체' : '＋ 추가'}</button></div></header>
  <p id={`${id}-hint`} className="field-hint">{hint} {help}</p>
  <input ref={input} hidden type="file" disabled={!enabled} aria-label={`${group.label} 파일 선택`} multiple={!single} accept={group.id === 'poster' ? '.jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf' : single ? '.zip,application/zip,application/x-zip-compressed' : group.id === 'video' ? '.mp4,.mov,.m4v,.3gp,.3g2,.mkv,.webm,.avi,.wmv,.asf' : undefined} onChange={event => { if (enabled) onFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
  {error && <p className="field-error" role="alert">{error}</p>}
  {count === 0 && <div className="material-panel__empty"><button type="button" className="btn btn--secondary" disabled={!enabled} onClick={select}>파일 선택</button><p>파일을 여기에 끌어다 놓으세요.</p></div>}
  {children}
  {drag && enabled && <div className="material-panel__drop" aria-hidden="true">여기에 놓아서 {group.label} 추가</div>}
 </div>;
}

export function MaterialUploadSummary({ rows, children }: { rows: readonly FileUploadRowState[]; children?: ReactNode }) {
 const known = rows.length > 0 && rows.every(row => row.size !== undefined || row.progress?.totalBytes !== undefined);
 const total = rows.reduce((sum, row) => sum + (row.size ?? row.progress?.totalBytes ?? 0), 0);
 const loaded = rows.reduce((sum, row) => sum + (['transferred', 'completing', 'verifying', 'ready'].includes(row.phase) ? row.size ?? row.progress?.totalBytes ?? 0 : row.progress?.uploadedBytes ?? 0), 0);
 const percent = known && total > 0 ? Math.min(100, Math.floor(loaded / total * 100)) : undefined;
 return <><div className="material-upload-summary" role="status"><span>{percent === 100 ? '전송 완료' : percent === undefined ? '전송량 확인 중' : `전송 ${percent}%`}{known && ` · ${(loaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`}</span><span>검증 {rows.filter(row => row.phase === 'ready').length}/{rows.length}개 완료</span><progress max={100} value={percent} aria-label="전체 파일 전송률" /></div>{children}</>;
}
