import { createHash } from 'node:crypto';
import { forbidden } from '../../shared/errors.js';
import { sanitizeConnectionReport } from './diagnostics.js';
import type { DiagnosticRepository, DiagnosticService } from './diagnostic-ports.js';

export function createDiagnosticService(repository: DiagnosticRepository, now = () => new Date()): DiagnosticService {
  return {
    async report(token, body) {
      if (!/^[a-f0-9]{64}$/.test(token)) throw forbidden();
      await repository.record(createHash('sha256').update(token).digest('hex'), sanitizeConnectionReport(body), now());
    },
    list: sessionId => repository.list(sessionId),
  };
}
