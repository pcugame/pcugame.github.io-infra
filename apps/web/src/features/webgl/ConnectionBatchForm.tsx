import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ConnectionDraftError, CreateWebglNetworkBatchSchema, type CreateWebglNetworkBatch, type WebglNetworkRequest, type WebglNetworkBatchResponse } from '@pcu/contracts';
import { api, ApiError } from '../../lib/api/client';
import { getApiErrorMessage } from '../../lib/api';
import { ConnectionRuleFields } from './ConnectionRuleFields';
import { ConnectionProfileForm } from './ConnectionProfileForm';
import { draftOrigin, emptyConnectionDraft, type ConnectionDraft } from './connectionDraft';

type Row = { id: string; draft: ConnectionDraft };
type Issue = { index: number; field: string; message: string };
const newRow = (draft = emptyConnectionDraft): Row => ({ id: crypto.randomUUID(), draft });
const fieldName = (field: string) => field === 'origin' ? 'host' : field;
export function ConnectionBatchForm({ path, items, gameOrigin, onSubmitted }: {
 path: string; items: WebglNetworkRequest[]; gameOrigin: string; onSubmitted: () => Promise<void>;
}) {
 const [rows, setRows] = useState<Row[]>(() => [newRow()]);
 const [errors, setErrors] = useState<Record<string, Issue[]>>({});
 const [description, setDescription] = useState({ purpose: '', cors: '' });
 const [descriptionErrors, setDescriptionErrors] = useState<Record<string, string>>({});
 const [notice, setNotice] = useState('');
 const locked = useRef(false);
 const focusTarget = useRef<string | null>(null);
 function showErrors(issues: Issue[]) {
  const next: Record<string, Issue[]> = {};
  const shared: Record<string, string> = {};
  for (const issue of issues) { if (issue.field === 'purpose' || issue.field === 'cors') { shared[issue.field] = issue.message; continue; } const row = rows[issue.index]; if (row) (next[row.id] ??= []).push(issue); }
  setErrors(next); setDescriptionErrors(shared);
  const first = issues[0];
  focusTarget.current = first && (first.field === 'purpose' || first.field === 'cors') ? `network-${first.field}` : first && rows[first.index] ? `network-${rows[first.index]!.id}-${fieldName(first.field)}` : null;
 }
 const submit = useMutation({
  mutationFn: (body: CreateWebglNetworkBatch) => api.post<WebglNetworkBatchResponse>(`${path}/batch`, body),
  retry: false,
  onSuccess: async () => { setRows([newRow()]); setDescription({ purpose: '', cors: '' }); setDescriptionErrors({}); setErrors({}); setNotice('신청이 모두 등록되었습니다. 관리자 검토 결과를 기다려 주세요.'); await onSubmitted(); },
  onError: async error => {
   const details = error instanceof ApiError ? (error.body as { error?: { details?: unknown } })?.error?.details : null;
   if (Array.isArray(details)) showErrors(details.filter((value): value is Issue => typeof value?.index === 'number' && typeof value?.field === 'string').map(value => ({ ...value, message: value.message || '입력을 확인하세요.' })));
   if (!(error instanceof ApiError) || error.status >= 500) {
    setNotice('신청 결과를 확인할 수 없습니다. 신청 이력을 새로 조회하여 등록 여부를 확인한 뒤 다시 신청하세요. 입력은 유지됩니다.');
    await onSubmitted();
   }
  },
  onSettled: () => { locked.current = false; },
 });
 useEffect(() => {
  if (!submit.isPending && focusTarget.current) {
   document.getElementById(focusTarget.current)?.focus(); focusTarget.current = null;
  }
 }, [errors, submit.isPending]);
 function update(id: string, patch: Partial<Row>) {
  if (locked.current) return;
  setRows(previous => previous.map(row => row.id === id ? { ...row, ...patch } : row));
  setErrors(previous => ({ ...previous, [id]: [] }));
  setNotice('');
 }
 function send(event: FormEvent) {
  event.preventDefault(); if (locked.current) return;
  const issues: Issue[] = [];
  const inputs = rows.map((row, index) => {
   let origin = '';
   try { origin = draftOrigin(row.draft); } catch (error) { issues.push({ index, field: error instanceof ConnectionDraftError ? error.field : 'host', message: error instanceof Error ? error.message : '빈 항목을 작성하거나 삭제하세요.' }); }
   return { origin, mode: row.draft.mode, ...description };
  });
  const parsed = CreateWebglNetworkBatchSchema.safeParse({ items: inputs });
  if (!parsed.success) for (const issue of parsed.error.issues) {
   const index = Number(issue.path[1]); const field = String(issue.path[2] ?? 'host');
   if (field === 'origin' && issues.some(value => value.index === index)) continue;
   issues.push({ index, field, message: field === 'purpose' ? '사용 목적을 입력하세요.' : field === 'cors' ? 'CORS / 인증 설정 계획을 입력하세요.' : issue.message });
  }
  inputs.forEach((input, index) => { if (items.some(item => item.origin === input.origin && ['PENDING', 'APPROVED'].includes(item.state))) issues.push({ index, field: 'origin', message: '이미 대기 중이거나 승인된 주소입니다.' }); });
  issues.sort((a, b) => Number(['purpose', 'cors'].includes(a.field)) - Number(['purpose', 'cors'].includes(b.field)) || a.index - b.index);
  showErrors(issues); setNotice('');
  if (issues.length || !parsed.success) return;
  locked.current = true; submit.mutate(parsed.data);
 }
 function addExamples(drafts: ConnectionDraft[]) {
  if (locked.current) return '신청 처리 중입니다.';
  const existing = new Set(rows.map(row => { try { return draftOrigin(row.draft); } catch { return ''; } }));
  const added: Row[] = [];
  let duplicates = 0;
  try {
   for (const draft of drafts) {
    const origin = draftOrigin(draft);
    if (existing.has(origin)) { duplicates++; continue; }
    existing.add(origin); added.push(newRow(draft));
   }
  } catch (error) { return error instanceof Error ? error.message : '예시 주소를 확인하세요.'; }
  if (rows.length + added.length > 16) return '한 번에 최대 16개까지 작성할 수 있습니다. 예시를 추가하지 않았습니다.';
  setRows(previous => [...previous, ...added]);
  return `${added.length}개를 작성 목록에 추가했습니다.${duplicates ? ` 중복 ${duplicates}개는 추가하지 않았습니다.` : ''} 목적과 설정을 작성하세요.`;
 }
 return <div className="network-editor">
  <form id="network-new-request" className="admin-card project-form network-form" onSubmit={send} noValidate>
   <h2>새 연결 신청</h2>
   <p className="field-hint">주소를 추가하고 사용 목적과 설정 계획은 아래에 한 번만 작성하세요. 최대 16개 · 현재 승인 {items.filter(item => item.state === 'APPROVED').length} / 16개. 새 신청은 모든 포트가 기본입니다.</p>
   {rows.map((row, index) => {
    const prefix = `network-${row.id}`;
    const rowErrors = errors[row.id] ?? [];

    return <fieldset key={row.id} className="network-batch-item" disabled={submit.isPending} aria-label={`연결 ${index + 1}`}>
     <div className="network-batch-item__header">
      <span className="network-batch-item__title">연결 {index + 1}</span>
      <button type="button" className="btn btn--danger btn--small network-batch-delete" onClick={() => {
      if (locked.current) return;
      const next = rows.filter(value => value.id !== row.id); setRows(next.length ? next : [newRow()]);
      }}>삭제</button>
     </div>
     <ConnectionRuleFields compact prefix={prefix} value={row.draft} items={items} disabled={submit.isPending} errors={Object.fromEntries(rowErrors.map(issue => [fieldName(issue.field), issue.message]))} onChange={draft => update(row.id, { draft })} />
    </fieldset>;
   })}
   <button type="button" className="btn btn--secondary btn--small" disabled={submit.isPending || rows.length >= 16} onClick={() => { if (!locked.current) setRows(previous => [...previous, newRow()]); }}>＋ 연결 추가</button>
   <div className="network-batch-description">
    <h3>신청 설명</h3>
    <p className="field-hint">주소별 용도와 설정이 다르면 주소 이름과 함께 이곳에 모아 적어 주세요.</p>
    {(['purpose', 'cors'] as const).map(field => <div className="form-field" key={field}>
     <label htmlFor={`network-${field}`}>{field === 'purpose' ? '사용 목적' : 'CORS / 인증 설정 계획'}</label>
     <textarea id={`network-${field}`} value={description[field]} disabled={submit.isPending} onChange={event => {
      if (locked.current) return;
      setDescription(previous => ({ ...previous, [field]: event.target.value }));
      setDescriptionErrors(previous => ({ ...previous, [field]: '' })); setNotice('');
     }} rows={2} maxLength={2000} required aria-invalid={!!descriptionErrors[field]} aria-describedby={descriptionErrors[field] ? `network-${field}-error` : undefined} />
     {descriptionErrors[field] && <p id={`network-${field}-error`} className="field-error" role="alert">{descriptionErrors[field]}</p>}
    </div>)}
    <p className="field-hint">CORS·WebSocket Origin 허용 대상: <code>{gameOrigin}</code></p>
   </div>
   <div className="form-actions">
    <button className="btn btn--primary" type="submit" disabled={submit.isPending}>{submit.isPending ? '신청 중…' : `연결 ${rows.length}개 신청`}</button>
   </div>
   {submit.error && <p className="field-error" role="alert">{getApiErrorMessage(submit.error)}</p>}
   {notice && <p role="status">{notice}</p>}
  </form>
  <details className="network-profile-examples"><summary>서비스 예시에서 연결 추가</summary><ConnectionProfileForm items={items} disabled={submit.isPending} onAdd={addExamples} /></details>
 </div>;
}
