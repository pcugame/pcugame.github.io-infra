import { ConnectionRule, describeConnectionRule, type WebglNetworkRequest } from '@pcu/contracts';

export function ConnectionConflicts({ rule, items }: { rule: ConnectionRule; items: WebglNetworkRequest[] }) {
 const conflicts = items.filter(item => {
  if (item.state !== 'APPROVED') return false;
  try { return rule.overlaps(ConnectionRule.parse(item.origin)); } catch { return false; }
 });
 if (!conflicts.length) return null;
 return <div className="field-error">
  <p>기존 승인과 충돌합니다. 중첩 승인을 철회한 후 새 승인 → 새 실행이 필요합니다. 철회 시 기존 플레이의 이후 파일 요청·갱신이 거절되며, 새 승인 전에는 연결 승인 공백이 생깁니다. 이미 열린 연결을 즉시 종료하지는 않습니다.</p>
  <ul>{conflicts.map(item => <li key={item.id}><code>{item.origin}</code> · 신청 #{item.id}</li>)}</ul>
 </div>;
}

export function ConnectionRuleSummary({ rule, items }: { rule: ConnectionRule; items: WebglNetworkRequest[] }) {
 return <div aria-label="신청 미리보기"><p>신청 미리보기: <code>{rule.origin}</code></p><p>{describeConnectionRule(rule)}</p><ConnectionConflicts rule={rule} items={items} /></div>;
}
