import { Button, CheckboxField, SelectField } from '../../components/ui';
import { useState } from 'react';
import { ConnectionRule, CONNECTION_PROFILES, type WebglNetworkRequest } from '@pcu/contracts';
import { ConnectionRuleFields } from './ConnectionRuleFields';
import { draftOrigin, type ConnectionDraft } from './connectionDraft';

// Examples are new drafts only; persisted requests are never converted.
function profileRows(examples: readonly string[]) {
 return examples.map(origin => {
  const rule = ConnectionRule.parse(origin);
  return { draft: { host: rule.hostname, mode: rule.mode, scope: rule.subdomains ? 'subdomains' : 'exact', ports: rule.port === '*' ? 'all' : 'specific', port: rule.port === '*' ? '443' : String(rule.port) } as ConnectionDraft, selected: false };
 });
}
function rowOrigin(draft: ConnectionDraft) { try { return draftOrigin(draft); } catch { return JSON.stringify(draft); } }

export function ConnectionProfileForm({ items, disabled, onAdd }: { items: WebglNetworkRequest[]; disabled: boolean; onAdd: (drafts: ConnectionDraft[]) => string }) {
 const [profileId, setProfileId] = useState(CONNECTION_PROFILES[0]!.id);
 const profile = CONNECTION_PROFILES.find(value => value.id === profileId)!;
 const [rows, setRows] = useState(() => profileRows(profile.examples));
 const [message, setMessage] = useState('');
 const busy = disabled;
 const active = (origin: string) => items.some(item => item.origin === origin && ['PENDING', 'APPROVED'].includes(item.state));
 return <section className="network-profile-panel project-form" aria-label="서비스별 신청 예시">
  <h2>서비스별 신청 예시</h2>
  <SelectField label="서비스" disabled={busy} value={profileId} onChange={event => {
   const next = CONNECTION_PROFILES.find(value => value.id === event.target.value)!;
   setProfileId(next.id); setRows(profileRows(next.examples));
  }}>{CONNECTION_PROFILES.map(value => <option key={value.id} value={value.id}>{value.title}</option>)}</SelectField>
  <div className="network-profile-prose"><p>{profile.guide} <a href={profile.documentation} target="_blank" rel="noreferrer">공식 설정 안내</a></p>
  <p>예시는 연동 보장이 아닙니다. example.com 주소는 실제 서비스 주소로 바꾸세요. 선택한 예시를 작성 목록에 추가한 뒤 공통 설명을 작성하고 함께 신청하세요. 새 예시는 모든 포트가 기본이며, 하위 도메인 범위는 루트를 포함하지 않습니다. 특정 포트는 포트 정책에서 선택한 뒤 숫자를 입력하세요. 작품당 승인 한도는 16개입니다.</p></div>
  {rows.map((row, index) => {
   const origin = rowOrigin(row.draft);
   return <div className="form-field" key={index}>
    <CheckboxField label={`예시 ${index + 1} 선택`} disabled={busy || active(origin)} checked={row.selected} onChange={event => setRows(previous => previous.map((value, i) => i === index ? { ...value, selected: event.target.checked } : value))} />
    <ConnectionRuleFields prefix={`profile-${index}`} value={row.draft} items={items} disabled={busy} onChange={draft => setRows(previous => previous.map((value, i) => i === index ? { ...value, draft } : value))} />
    <span role="status">{active(origin) ? '이미 등록됨 · 재신청하지 않습니다.' : ''}</span>
   </div>;
  })}
  <Button variant="secondary" disabled={busy || !rows.some(row => row.selected && !active(rowOrigin(row.draft)))} onClick={() => setMessage(onAdd(rows.filter(row => row.selected && !active(rowOrigin(row.draft))).map(row => row.draft)))}>선택한 예시 목록에 추가</Button>
  {message && <p role="status">{message}</p>}
 </section>;
}
