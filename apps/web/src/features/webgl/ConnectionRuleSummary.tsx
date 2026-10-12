import { ConnectionRule, type WebglNetworkRequest } from '@pcu/contracts';

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
 return <section className="network-rule-summary" aria-label="신청 미리보기">
  <div className="network-rule-summary__header">
   <p className="network-rule-summary__title">신청 미리보기</p>
   <span className="network-rule-summary__protocol">{rule.mode}</span>
  </div>
  <p className="network-rule-summary__host">{rule.hostname}</p>
  <dl className="network-rule-summary__facts">
   <div><dt>호스트 범위</dt><dd>{rule.subdomains ? '하위 도메인만' : '이 호스트만'}<small>{rule.subdomains ? '입력 호스트 제외' : '하위 도메인 제외'}</small></dd></div>
   <div><dt>허용 포트</dt><dd>{rule.port === '*' ? '모든 포트' : rule.port}<small>{rule.port === '*' ? '1–65535' : rule.port === 443 ? '기본 포트' : '지정한 포트만'}</small></dd></div>
  </dl>
  <details className="network-rule-summary__technical"><summary>CSP 문자열 상세 (읽기 전용)</summary><code>{rule.toCsp()}</code></details>
  <ConnectionConflicts rule={rule} items={items} />
 </section>;
}
