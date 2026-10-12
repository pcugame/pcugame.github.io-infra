import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createDiagnosticController } from './diagnostic-controller.js';
import { AppError } from '../../shared/errors.js';

const token = 'a'.repeat(64);
const rawSecret = 'private-report-credential';
describe('report plugin privacy boundary', () => {
  it('redacts errors and suppresses request logs through parsing and service failures', async () => {
    let logs = '';
    const app = Fastify({ logger: { level: 'trace', stream: { write: (line: string) => { logs += line; } } } });
    const parentHandler = vi.fn((_error, _request, reply) => reply.status(500).send({ message: 'parent handler' }));
    app.setErrorHandler(parentHandler);
    const report = vi.fn(async () => {});
    await app.register(createDiagnosticController({ report }));
    app.get('/ordinary', async () => { throw new Error('ordinary error'); });
    try {
      const send = (payload: string, contentType = 'application/json') => app.inject({ method: 'POST', url: `/api/webgl-play/reports/${token}`, headers: { 'content-type': contentType }, payload });
      const good = await send(JSON.stringify({ 'csp-report': { 'script-sample': rawSecret } }));
      expect(good.statusCode).toBe(204);
      const malformed = await send(`{"secret":"${rawSecret}"`);
      expect(malformed.statusCode).toBe(400);
      const tooLarge = await send(rawSecret.repeat(2000));
      expect(tooLarge.statusCode).toBe(413);
      expect((await send(rawSecret, 'application/csp-report')).statusCode).toBe(204);
      expect(report).toHaveBeenLastCalledWith(token, null);
      for (const status of [403, 429, 500]) {
        report.mockRejectedValueOnce(new AppError(status, `${token} ${rawSecret}`));
        const response = await send('{}');
        expect(response.statusCode).toBe(status);
        expect(response.json()).toEqual({ ok: false, error: { code: 'REPORT_REJECTED', message: 'Report rejected' } });
      }
      for (const response of [good, malformed, tooLarge]) {
        expect(response.body).not.toContain(token);
        expect(response.body).not.toContain(rawSecret);
      }
      expect(parentHandler).not.toHaveBeenCalled();
      expect(logs).not.toContain(token);
      expect(logs).not.toContain(rawSecret);
      expect((await app.inject('/ordinary')).statusCode).toBe(500);
      expect(parentHandler).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });
});
