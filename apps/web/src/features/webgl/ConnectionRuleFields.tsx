import { ConnectionDraftError, ConnectionRule, draftOrigin, type WebglNetworkRequest } from '@pcu/contracts';
import { ConnectionConflicts, ConnectionRuleSummary } from './ConnectionRuleSummary';
import { FormSection, TextField, SelectField } from '../../components/ui';
import type { ConnectionDraft } from './connectionDraft';

export function ConnectionRuleFields({ value, onChange, prefix, items = [], disabled = false, errors = {}, compact = false }: {
 compact?: boolean; value: ConnectionDraft; onChange: (value: ConnectionDraft) => void; prefix: string; items?: WebglNetworkRequest[]; disabled?: boolean; errors?: Partial<Record<keyof ConnectionDraft, string>>;
}) {
 let rule: ConnectionRule | null = null;
 let error: ConnectionDraftError | null = null;
 try { rule = ConnectionRule.parse(draftOrigin(value)); }
 catch (cause) { if (cause instanceof ConnectionDraftError && (value.host || cause.field !== 'host')) error = cause; }
 const fieldError = (field: keyof ConnectionDraft) => errors[field] ?? (error?.field === field ? error.message : undefined);
 const update = (patch: Partial<ConnectionDraft>) => onChange({ ...value, ...patch });
 const content = <>
  <div className={compact ? "network-rule-compact" : "network-rule-row"}>
   <SelectField label="연결 방식" id={`${prefix}-mode`} value={value.mode} error={fieldError('mode')} onChange={event => update({ mode: event.target.value as ConnectionDraft['mode'] })}><option value="HTTPS">HTTPS</option><option value="WSS">WSS</option></SelectField>
   <TextField label="도메인 (호스트명)" id={`${prefix}-host`} value={value.host} error={fieldError('host')} onChange={event => update({ host: event.target.value })} placeholder="assets.example.com" autoComplete="off" spellCheck={false} required />
   <SelectField label="호스트 범위" id={`${prefix}-scope`} value={value.scope} error={fieldError('scope')} onChange={event => update({ scope: event.target.value as ConnectionDraft['scope'] })}><option value="exact">이 호스트만</option><option value="subdomains">하위 도메인만 — 입력 호스트 제외</option></SelectField>
   <div className="network-rule-port">
    <SelectField label="포트 정책" id={`${prefix}-ports`} value={value.ports} error={fieldError('ports')} onChange={event => update({ ports: event.target.value as ConnectionDraft['ports'] })}><option value="all">모든 포트</option><option value="specific">특정 포트</option></SelectField>
    {value.ports === 'specific' && <TextField label="특정 포트" id={`${prefix}-port`} inputMode="numeric" value={value.port} error={fieldError('port')} onChange={event => update({ port: event.target.value })} required />}
   </div>
  </div>
  {!compact && <p className="field-hint">호스트명만 입력하세요. 하위 도메인 범위는 입력 호스트 자체를 포함하지 않습니다.</p>}
  {rule && (compact ? <>
   <details className="network-rule-preview"><summary>신청 미리보기</summary><ConnectionRuleSummary rule={rule} items={[]} /></details>
   <ConnectionConflicts rule={rule} items={items} />
  </> : <ConnectionRuleSummary rule={rule} items={items} />)}
 </>;
 return compact ? <div className="network-rule-fields-compact">{content}</div> : <FormSection legend="연결 범위 설정" disabled={disabled}>{content}</FormSection>;
}
