import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { LabBertScoreResponseSchema } from '@pcu/contracts';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { LabConfig } from './config.js';
import { claimBertScores, finishBertScore, renewBertLease } from './bertscore-repository.js';

const responseSchema = z.object({ results: z.array(LabBertScoreResponseSchema).min(1).max(4) });
export async function processNextBertScores(db: PrismaClient, config: LabConfig, signal?: AbortSignal): Promise<boolean> {
  if (!config.enabled || !config.bertScoreUrl || signal?.aborted) return false;
  const claims = await claimBertScores(db);
  if (!claims.length) return false;
  const controller = new AbortController();
  const workSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]);
  const heartbeat = (async () => {
    try {
      while (!workSignal.aborted) {
        await delay(1000, undefined, { signal: workSignal });
        const renewed = await Promise.all(claims.map(c => renewBertLease(db, c)));
        if (renewed.every(v => !v)) break;
      }
    } catch { /* Leave interrupted jobs recoverable by lease expiry. */ }
    controller.abort();
  })();
  try {
    const response = await fetch(config.bertScoreUrl + '/score', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: workSignal,
      body: JSON.stringify({ pairs: claims.map(c => ({ candidate: c.candidate, reference: c.reference })) }),
    });
    if (!response.ok) throw new Error('BERTSCORE_HTTP_' + response.status);
    const { results } = responseSchema.parse(await response.json());
    if (results.length !== claims.length) throw new Error('BERTSCORE_INVALID_RESPONSE');
    if (!signal?.aborted && !controller.signal.aborted) {
      for (const [i, claim] of claims.entries()) await finishBertScore(db, claim, results[i]!);
    }
  } catch (error) {
    if (!signal?.aborted && !controller.signal.aborted) {
      const reason = error instanceof Error && /^BERTSCORE_HTTP_\d+$/.test(error.message) ? error.message : 'BERTSCORE_UNAVAILABLE_OR_INVALID';
      for (const claim of claims) await finishBertScore(db, claim, { status: 'FAILED', reason });
    }
  } finally {
    controller.abort();
    await heartbeat;
  }
  return true;
}
