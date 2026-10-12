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

export class ConnectionDraftError extends Error {
 constructor(readonly field: keyof ConnectionDraft, message: string) { super(message); }
}

export function draftOrigin(draft: ConnectionDraft): string {
 if (!['HTTPS', 'WSS'].includes(draft.mode)) throw new ConnectionDraftError('mode', 'HTTPS 또는 WSS를 선택하세요.');
 if (!['exact', 'subdomains'].includes(draft.scope)) throw new ConnectionDraftError('scope', '호스트 범위를 선택하세요.');
 if (!['all', 'specific'].includes(draft.ports)) throw new ConnectionDraftError('ports', '포트 정책을 선택하세요.');
 const host = draft.host.trim().toLowerCase();
 if (!/^[a-z0-9.-]+$/.test(host)) throw new ConnectionDraftError('host', '호스트명만 입력하세요. 연결 방식·포트·호스트 범위는 각각 선택하세요. URL·*.·CSP 문법은 입력할 수 없습니다.');
 const portInput = draft.port.trim();
 if (draft.ports === 'specific' && (!/^\d+$/.test(portInput) || Number(portInput) < 1 || Number(portInput) > 65535)) throw new ConnectionDraftError('port', '특정 포트는 1~65535의 정수로 입력하세요.');
 const port = draft.ports === 'all' ? '*' : Number(portInput);
 const suffix = port === 443 ? '' : `:${port}`;
 const origin = `${draft.mode.toLowerCase()}://${draft.scope === 'subdomains' ? '*.' : ''}${host}${suffix}`;
 try { return ConnectionRule.parse(origin, draft.mode).origin; }
 catch { throw new ConnectionDraftError('host', '공개 호스트명과 선택한 호스트 범위를 확인하세요.'); }
}

export function describeConnectionRule(rule: ConnectionRule): string {
 return `${rule.mode} · ${rule.subdomains ? `${rule.hostname}의 하위 도메인만 (루트 제외)` : rule.hostname} · ${rule.port === '*' ? '모든 포트 (1~65535)' : `특정 포트 ${rule.port}${rule.port === 443 ? ' (기본 포트)' : ''}`}`;
}
