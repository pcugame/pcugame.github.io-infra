import { SelectControl } from '../../components/ui';
import { useState } from 'react';
import { ConnectionRule, CONNECTION_PROFILES, CreateWebglNetworkRequestSchema, type WebglNetworkRequest } from '@pcu/contracts';
import { ConnectionRuleFields } from './ConnectionRuleFields';
import { draftOrigin, type ConnectionDraft } from './connectionDraft';
import { api } from '../../lib/api/client';
import { getApiErrorMessage } from '../../lib/api';

// Examples are new drafts only; persisted requests are never converted.
function profileRows(examples: readonly string[]) {
 return examples.map(origin => {
  const rule = ConnectionRule.parse(origin);
  return { draft: { host: rule.hostname, mode: rule.mode, scope: rule.subdomains ? 'subdomains' : 'exact', ports: rule.port === '*' ? 'all' : 'specific', port: rule.port === '*' ? '443' : String(rule.port) } as ConnectionDraft, selected: false };
 });
}
function rowOrigin(draft: ConnectionDraft) { try { return draftOrigin(draft); } catch { return JSON.stringify(draft); } }

export function ConnectionProfileForm({ path, items, onSubmitted }: { path: string; items: WebglNetworkRequest[]; onSubmitted: () => void }) {
 const [profileId, setProfileId] = useState(CONNECTION_PROFILES[0]!.id);
 const profile = CONNECTION_PROFILES.find(value => value.id === profileId)!;
 const [rows, setRows] = useState(() => profileRows(profile.examples));
 const [purpose, setPurpose] = useState('');
 const [cors, setCors] = useState('');
 const [results, setResults] = useState<Record<string, string>>({});
 const [busy, setBusy] = useState(false);
 const active = (origin: string) => items.some(item => item.origin === origin && ['PENDING', 'APPROVED'].includes(item.state)) || results[origin] === '등록 완료';
 async function submit() {
  setBusy(true);
  const submitted = new Set(items.filter(item => ['PENDING', 'APPROVED'].includes(item.state)).map(item => item.origin));
  Object.entries(results).filter(([, result]) => result === '등록 완료').forEach(([origin]) => submitted.add(origin));
  try {
   for (const row of rows.filter(row => row.selected)) {
    const origin = rowOrigin(row.draft);
    if (submitted.has(origin)) continue;
    const parsed = CreateWebglNetworkRequestSchema.safeParse({ origin: origin, mode: row.draft.mode, purpose, cors });
    if (!parsed.success) { setResults(previous => ({ ...previous, [origin]: '호스트명·목적·서버 설정과 미리보기의 입력 오류를 확인하세요.' })); continue; }
    try {
     await api.post(path, parsed.data);
     submitted.add(origin);
     setResults(previous => ({ ...previous, [origin]: '등록 완료' }));
    } catch (error) { setResults(previous => ({ ...previous, [origin]: getApiErrorMessage(error) })); }
   }
  } finally { setBusy(false); onSubmitted(); }
 }
 return <section className="admin-card project-form" aria-label="서비스별 신청 예시">
  <h2>서비스별 신청 예시</h2>
  <label>서비스<SelectControl disabled={busy} value={profileId} onChange={event => {
   const next = CONNECTION_PROFILES.find(value => value.id === event.target.value)!;
   setProfileId(next.id); setRows(profileRows(next.examples));
  }}>{CONNECTION_PROFILES.map(value => <option key={value.id} value={value.id}>{value.title}</option>)}</SelectControl></label>
  <p>{profile.guide} <a href={profile.documentation} target="_blank" rel="noreferrer">공식 설정 안내</a></p>
  <p>예시는 연동 보장이 아닙니다. example.com 주소는 실제 서비스 주소로 바꾸세요. 선택한 주소만 개별 신청합니다. 새 예시는 모든 포트가 기본이며, 하위 도메인 범위는 루트를 포함하지 않습니다. 특정 포트는 고급 설정에서 지정하세요. 작품당 승인 한도는 16개입니다.</p>
  {rows.map((row, index) => {
   const origin = rowOrigin(row.draft);
   return <div className="form-field" key={index}>
    <label><input type="checkbox" disabled={busy || active(origin)} checked={row.selected} onChange={event => setRows(previous => previous.map((value, i) => i === index ? { ...value, selected: event.target.checked } : value))} />예시 {index + 1} 선택</label>
    <ConnectionRuleFields prefix={`profile-${index}`} value={row.draft} items={items} disabled={busy} onChange={draft => setRows(previous => previous.map((value, i) => i === index ? { ...value, draft } : value))} />
    <span role="status">{active(origin) ? '이미 등록됨 · 재신청하지 않습니다.' : results[origin]}</span>
   </div>;
  })}
  <label>예시 사용 목적<textarea disabled={busy} value={purpose} onChange={event => setPurpose(event.target.value)} maxLength={2000} /></label>
  <label>예시 서버 설정 계획<textarea disabled={busy} value={cors} onChange={event => setCors(event.target.value)} maxLength={2000} /></label>
  <button className="btn btn--secondary" type="button" disabled={busy || !purpose.trim() || !cors.trim() || !rows.some(row => row.selected && !active(rowOrigin(row.draft)))} onClick={() => void submit()}>{busy ? '신청 중…' : '선택한 예시 신청 / 실패 항목 재시도'}</button>
 </section>;
}
