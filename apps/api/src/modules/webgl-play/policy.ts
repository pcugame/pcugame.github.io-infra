import { AppError, forbidden } from '../../shared/errors.js';

export interface ConnectionSnapshot {
  projectId: number;
  policyVersion: number;
  approvedOrigins: readonly string[];
}

/** Shared revocation selection for execution and diagnostic reports. */
export function connectionRevocationFilter(snapshot: ConnectionSnapshot) {
  return {
    originalProjectId: snapshot.projectId,
    action: 'REVOKE' as const,
    policyVersion: { gt: snapshot.policyVersion },
    origin: { in: [...snapshot.approvedOrigins] },
  };
}

export function isConnectionPolicyValid(snapshot: ConnectionSnapshot, externalEnabled: boolean, revocationCount: number): boolean {
  return snapshot.approvedOrigins.length === 0 || (externalEnabled && revocationCount === 0);
}

export interface DiagnosticSession extends ConnectionSnapshot {
  revokedAt: Date | null;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  reportWindowAt: Date | null;
  reportCount: number;
}

/** Evaluate the locked snapshot; no clock or persistence access here. */
export function nextReportWindow(session: DiagnosticSession, revocationCount: number, at: Date) {
  if (session.revokedAt || session.expiresAt <= at || session.absoluteExpiresAt <= at
    || !isConnectionPolicyValid(session, true, revocationCount)) throw forbidden();
  const inWindow = session.reportWindowAt !== null && at.getTime() - session.reportWindowAt.getTime() < 60_000;
  if (inWindow && session.reportCount >= 30) throw new AppError(429, 'Report limit reached', 'RATE_LIMITED');
  return {
    reportWindowAt: inWindow ? session.reportWindowAt : at,
    reportCount: inWindow ? session.reportCount + 1 : 1,
  };
}

export function canStoreDiagnostic(existing: boolean, distinctCount: number): boolean {
  return existing || distinctCount < 20;
}
