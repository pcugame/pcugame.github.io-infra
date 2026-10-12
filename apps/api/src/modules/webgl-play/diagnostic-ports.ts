export interface ConnectionReport { origin: string; directive: string }
export interface ConnectionDiagnostic extends ConnectionReport {
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}
export interface DiagnosticRepository {
  record(reportHash: string, item: ConnectionReport | null, at: Date): Promise<void>;
  list(sessionId: string): Promise<ConnectionDiagnostic[]>;
}
export interface DiagnosticService {
  report(token: string, body: unknown): Promise<void>;
  list(sessionId: string): Promise<ConnectionDiagnostic[]>;
}
