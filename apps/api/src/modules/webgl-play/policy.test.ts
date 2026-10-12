import { describe, expect, it } from 'vitest';
import { canStoreDiagnostic, connectionRevocationFilter, isConnectionPolicyValid, nextReportWindow, type DiagnosticSession } from './policy.js';

const at = new Date('2026-10-12T00:00:00Z');
const session: DiagnosticSession = {
  projectId: 7, policyVersion: 3, approvedOrigins: ['https://scores.example.com'],
  revokedAt: null, expiresAt: new Date(+at + 60_000), absoluteExpiresAt: new Date(+at + 120_000),
  reportWindowAt: null, reportCount: 0,
};
describe('diagnostic policy', () => {
  it('shares project, origin and strictly newer revocation selection', () => {
    expect(connectionRevocationFilter(session)).toEqual({ originalProjectId: 7, action: 'REVOKE', policyVersion: { gt: 3 }, origin: { in: session.approvedOrigins } });
    expect(isConnectionPolicyValid(session, true, 0)).toBe(true);
    expect(isConnectionPolicyValid(session, true, 1)).toBe(false);
    expect(isConnectionPolicyValid(session, false, 0)).toBe(false);
    expect(isConnectionPolicyValid({ ...session, approvedOrigins: [] }, false, 1)).toBe(true);
  });
  it.each([{ revokedAt: at }, { expiresAt: at }, { absoluteExpiresAt: at }])('rejects inactive sessions %j', change => {
    expect(() => nextReportWindow({ ...session, ...change }, 0, at)).toThrow('Forbidden');
  });
  it('rejects revoked external snapshots', () => {
    expect(() => nextReportWindow(session, 1, at)).toThrow('Forbidden');
  });
  it('starts, increments, limits and resets the report window at exactly sixty seconds', () => {
    expect(nextReportWindow(session, 0, at)).toEqual({ reportWindowAt: at, reportCount: 1 });
    const limited = { ...session, reportWindowAt: new Date(+at - 59_999), reportCount: 29 };
    expect(nextReportWindow(limited, 0, at).reportCount).toBe(30);
    expect(() => nextReportWindow({ ...limited, reportCount: 30 }, 0, at)).toThrow('Report limit reached');
    expect(nextReportWindow({ ...limited, reportCount: 30, reportWindowAt: new Date(+at - 60_000) }, 0, at)).toEqual({ reportWindowAt: at, reportCount: 1 });
    expect(limited.reportCount).toBe(29);
  });
  it('keeps updating known origins at the distinct report limit', () => {
    expect(canStoreDiagnostic(false, 19)).toBe(true);
    expect(canStoreDiagnostic(false, 20)).toBe(false);
    expect(canStoreDiagnostic(true, 20)).toBe(true);
  });
});
