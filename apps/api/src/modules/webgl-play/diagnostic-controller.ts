import type { FastifyPluginAsync, FastifyError } from 'fastify';
import type { DiagnosticService } from './diagnostic-ports.js';

/** Encapsulation covers parser, hook, validation and service failures for reports. */
export function createDiagnosticController(service: Pick<DiagnosticService, 'report'>): FastifyPluginAsync {
  return async app => {
    app.setErrorHandler((error: FastifyError, _request, reply) => {
      reply.status(error.statusCode ?? 500).send({ ok: false, error: { code: 'REPORT_REJECTED', message: 'Report rejected' } });
    });
    app.addContentTypeParser('application/csp-report', { parseAs: 'string', bodyLimit: 16 * 1024 }, (_request, body, done) => {
      try { done(null, JSON.parse(String(body))); } catch { done(null, null); }
    });
    app.post<{ Params: { token: string }; Body: unknown }>('/api/webgl-play/reports/:token',
      { bodyLimit: 16 * 1024, logLevel: 'silent' }, async (request, reply) => {
        await service.report(request.params.token, request.body);
        return reply.status(204).send();
      });
  };
}
