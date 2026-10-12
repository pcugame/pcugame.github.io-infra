import { SelectControl } from '../../components/ui';
import { useState } from 'react';
import { CONNECTION_PROFILES, CreateWebglNetworkRequestSchema, type WebglNetworkRequest } from '@pcu/contracts';
import { api } from '../../lib/api/client';
import { getApiErrorMessage } from '../../lib/api';

export function ConnectionProfileForm({ path, items, onSubmitted }: { path: string; items: WebglNetworkRequest[]; onSubmitted: () => void }) {
 const [profileId, setProfileId] = useState(CONNECTION_PROFILES[0]!.id);
 const profile = CONNECTION_PROFILES.find(value => value.id === profileId)!;
 const [rows, setRows] = useState(() => profile.examples.map(origin => ({ origin, selected: false })));
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
    if (submitted.has(row.origin)) continue;
    const parsed = CreateWebglNetworkRequestSchema.safeParse({ origin: row.origin, mode: row.origin.startsWith('wss:') ? 'WSS' : 'HTTPS', purpose, cors });
    if (!parsed.success) { setResults(previous => ({ ...previous, [row.origin]: '주소·목적·서버 설정을 확인하세요.' })); continue; }
    try {
     await api.post(path, parsed.data);
     submitted.add(row.origin);
     setResults(previous => ({ ...previous, [row.origin]: '등록 완료' }));
    } catch (error) { setResults(previous => ({ ...previous, [row.origin]: getApiErrorMessage(error) })); }
   }
  } finally { setBusy(false); onSubmitted(); }
 }
 return <section className="admin-card project-form" aria-label="서비스별 신청 예시">
  <h2>서비스별 신청 예시</h2>
  <label>서비스<SelectControl disabled={busy} value={profileId} onChange={event => {
   const next = CONNECTION_PROFILES.find(value => value.id === event.target.value)!;
   setProfileId(next.id); setRows(next.examples.map(origin => ({ origin, selected: false })));
  }}>{CONNECTION_PROFILES.map(value => <option key={value.id} value={value.id}>{value.title}</option>)}</SelectControl></label>
  <p>{profile.guide} <a href={profile.documentation} target="_blank" rel="noreferrer">공식 설정 안내</a></p>
  <p>선택한 주소만 개별 신청합니다. 포트마다 한 개이며, 작품당 승인 한도는 16개입니다.</p>
  {rows.map((row, index) => <div className="form-field" key={index}>
   <label><input type="checkbox" disabled={busy || active(row.origin)} checked={row.selected} onChange={event => setRows(previous => previous.map((value, i) => i === index ? { ...value, selected: event.target.checked } : value))} />예시 {index + 1} 선택</label>
   <input aria-label={`예시 ${index + 1} 주소`} disabled={busy} value={row.origin} onChange={event => setRows(previous => previous.map((value, i) => i === index ? { ...value, origin: event.target.value.trim() } : value))} />
   <span role="status">{active(row.origin) ? '이미 등록됨 · 재신청하지 않습니다.' : results[row.origin]}</span>
  </div>)}
  <label>예시 사용 목적<textarea disabled={busy} value={purpose} onChange={event => setPurpose(event.target.value)} maxLength={2000} /></label>
  <label>예시 서버 설정 계획<textarea disabled={busy} value={cors} onChange={event => setCors(event.target.value)} maxLength={2000} /></label>
  <button className="btn btn--secondary" type="button" disabled={busy || !purpose.trim() || !cors.trim() || !rows.some(row => row.selected && !active(row.origin))} onClick={() => void submit()}>{busy ? '신청 중…' : '선택한 예시 신청 / 실패 항목 재시도'}</button>
 </section>;
}
