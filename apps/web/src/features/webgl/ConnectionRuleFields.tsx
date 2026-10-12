import { ConnectionRule, draftOrigin, type WebglNetworkRequest } from '@pcu/contracts';
import { ConnectionRuleSummary } from './ConnectionRuleSummary';
import { FormSection, TextField, SelectField } from '../../components/ui';
import type { ConnectionDraft } from './connectionDraft';

export function ConnectionRuleFields({ value, onChange, prefix, items = [], disabled = false }: {
 value: ConnectionDraft; onChange: (value: ConnectionDraft) => void; prefix: string; items?: WebglNetworkRequest[]; disabled?: boolean;
}) {
 let rule: ConnectionRule | null = null;
 let error = '';
 if (value.host.trim()) { try { rule = ConnectionRule.parse(draftOrigin(value)); } catch (cause) { error = (cause as Error).message; } }
 const update = (patch: Partial<ConnectionDraft>) => onChange({ ...value, ...patch });
 return <FormSection legend="연결 범위 설정" disabled={disabled}>
  <TextField label="호스트명" id={`${prefix}-host`} value={value.host} onChange={event => update({ host: event.target.value })} placeholder="assets.example.com" maxLength={500} autoComplete="off" spellCheck={false} aria-describedby={`${prefix}-hint`} required />
  <SelectField label="연결 방식" id={`${prefix}-mode`} value={value.mode} onChange={event => update({ mode: event.target.value as ConnectionDraft['mode'] })}><option value="HTTPS">HTTPS API / Addressables</option><option value="WSS">WSS</option></SelectField>
  <SelectField label="호스트 범위" id={`${prefix}-scope`} value={value.scope} onChange={event => update({ scope: event.target.value as ConnectionDraft['scope'] })}><option value="exact">정확한 호스트</option><option value="subdomains">하위 도메인만 (루트 제외)</option></SelectField>
  <p id={`${prefix}-hint`} className="field-hint">{value.scope === 'subdomains' ? '입력한 호스트의 하위 도메인만 신청합니다. 루트 호스트는 포함하지 않습니다.' : '입력한 호스트만 신청합니다. 하위 도메인은 포함하지 않습니다.'} {value.ports === 'all' ? '모든 포트' : `특정 포트 ${value.port}`} · {value.mode}</p>
  <p className="field-hint">호스트 와일드카드 *.는 하위 도메인 범위, 포트 와일드카드 :*는 모든 포트를 뜻합니다. URL도 붙여넣을 수 있으며 숫자 포트는 고급 설정과 일치해야 합니다.</p>
  <details><summary>고급 설정 · 포트 정책</summary>
   <SelectField label="포트 정책" id={`${prefix}-ports`} value={value.ports} onChange={event => update({ ports: event.target.value as ConnectionDraft['ports'] })}><option value="all">모든 포트</option><option value="specific">특정 포트</option></SelectField>
   {value.ports === 'specific' && <TextField label="특정 포트" id={`${prefix}-port`} inputMode="numeric" value={value.port} onChange={event => update({ port: event.target.value })} required />}
  </details>
  {rule && <ConnectionRuleSummary rule={rule} items={items} />}
  {error && <p className="field-error">{error}</p>}
 </FormSection>;
}
