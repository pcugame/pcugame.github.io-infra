import { ConnectionRule } from './connection-rule.js';

/** New request input only. Persisted origins retain their original port policy. */
export interface ConnectionDraft {
 host: string;
 mode: 'HTTPS' | 'WSS';
 scope: 'exact' | 'subdomains';
 ports: 'all' | 'specific';
 port: string;
}
export const emptyConnectionDraft: ConnectionDraft = Object.freeze({ host: '', mode: 'HTTPS', scope: 'exact', ports: 'all', port: '443' });

export function draftOrigin(draft: ConnectionDraft): string {
 const value = draft.host.trim();
 // Inspect the raw authority before URL normalization can discard credentials,
 // paths, empty query/fragment delimiters, backslashes or control characters.
 const match = /^(?:(https|wss):\/\/)?(\*\.)?(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(?::(\*|[0-9]+))?(\/)?$/.exec(value);
 if (!match || (match[5] && !match[1])) throw new Error('호스트명 또는 HTTPS/WSS 주소만 입력하세요. 자격 증명·경로·쿼리·조각은 사용할 수 없습니다.');
 if (match[1] && match[1].toUpperCase() !== draft.mode) throw new Error('붙여넣은 주소의 방식과 선택한 연결 방식이 다릅니다.');
 if (match[2] && draft.scope !== 'subdomains') throw new Error('호스트 와일드카드는 하위 도메인만 (루트 제외)을 선택해야 합니다.');
 if (draft.ports === 'specific' && (!/^\d+$/.test(draft.port) || Number(draft.port) < 1 || Number(draft.port) > 65535)) throw new Error('특정 포트는 1~65535의 정수로 입력하세요.');
 const port = draft.ports === 'all' ? '*' : Number(draft.port);
 if (match[4] && (match[4] === '*' ? port !== '*' : port !== Number(match[4]))) throw new Error(`주소의 포트 ${match[4]}와 선택한 포트 정책이 다릅니다. 숫자 포트는 고급 설정에 동일하게 입력하세요.`);
 const suffix = port === 443 ? '' : `:${port}`;
 const origin = `${draft.mode.toLowerCase()}://${draft.scope === 'subdomains' ? '*.' : ''}${match[3]!.toLowerCase()}${suffix}`;
 try { return ConnectionRule.parse(origin, draft.mode).origin; }
 catch { throw new Error('공개 HTTPS/WSS 호스트와 연결 범위를 확인하세요.'); }
}

export function describeConnectionRule(rule: ConnectionRule): string {
 return `${rule.mode} · ${rule.subdomains ? `${rule.hostname}의 하위 도메인만 (루트 제외)` : rule.hostname} · ${rule.port === '*' ? '모든 포트 (1~65535)' : `특정 포트 ${rule.port}${rule.port === 443 ? ' (기본 포트)' : ''}`}`;
}
