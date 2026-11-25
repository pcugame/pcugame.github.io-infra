import { createHash, randomUUID } from 'node:crypto';
import { LabCaseSchema, LabOutputSchema, type LabBertScoreResponse } from '@pcu/contracts';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

export const BERT_LEASE_MS = 30_000;
export const BERT_MAX_ATTEMPTS = 3;
export const BERT_TOTAL_ATTEMPTS = 12;
export type BertClaim = { runId: string; caseId: string; token: string; inputHash: string; candidate: string; reference: string };

// Called in the generation transaction, never by a scan/backfill of historical results.
export async function enqueueBertScore(tx: Prisma.TransactionClient, runId: string, caseId: string) {
  const result = await tx.labResult.findUniqueOrThrow({ where: { runId_caseId: { runId, caseId } }, include: { testCase: true } });
  if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(result.status)) return;
  const output = result.output ? LabOutputSchema.parse(result.output) : null;
  const reference = LabCaseSchema.parse(result.testCase.body).reference.expectedReason;
  const candidate = output?.reason ?? '';
  const inputHash = createHash('sha256').update(JSON.stringify({ reference, candidate })).digest('hex');
  const reason = result.status !== 'SUCCEEDED' ? 'GENERATION_' + result.status : !candidate.trim() || !reference.trim() ? 'EMPTY_REASON' : null;
  const data = { inputHash, status: reason ? 'SKIPPED' : 'PENDING', reason, attempts: 0, retryBase: 0,
    leaseToken: null, leaseUntil: null, nextAttemptAt: new Date(), precision: null, recall: null, f1: null,
    identity: Prisma.DbNull, completedAt: reason ? new Date() : null };
  await tx.labBertScore.upsert({ where: { runId_caseId: { runId, caseId } }, create: { runId, caseId, ...data }, update: data });
}

export async function claimBertScores(db: PrismaClient): Promise<BertClaim[]> {
  return db.$transaction(async tx => {
    // One CPU batch globally, even when multiple benchmark worker processes are running.
    await tx.$queryRaw`SELECT 1 AS held FROM pg_advisory_xact_lock(796405103, 1)`;
    const [active] = await tx.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM "LabBertScore"
      WHERE status='RUNNING' AND "leaseUntil" > clock_timestamp() AT TIME ZONE 'UTC'`;
    if (Number(active?.count)) return [];
    const rows = await tx.$queryRaw<{ runId: string; caseId: string; inputHash: string; attempts: number; retryBase: number }[]>`
      SELECT "runId", "caseId", "inputHash", attempts, "retryBase" FROM "LabBertScore"
      WHERE (status='PENDING' AND "nextAttemptAt" <= clock_timestamp() AT TIME ZONE 'UTC')
        OR (status='RUNNING' AND "leaseUntil" <= clock_timestamp() AT TIME ZONE 'UTC')
      ORDER BY "nextAttemptAt", "runId", "caseId" LIMIT 4 FOR UPDATE SKIP LOCKED`;
    const claims: BertClaim[] = [];
    for (const row of rows) {
      const where = { runId_caseId: { runId: row.runId, caseId: row.caseId } };
      if (row.attempts >= BERT_TOTAL_ATTEMPTS || row.attempts - row.retryBase >= BERT_MAX_ATTEMPTS) {
        await tx.labBertScore.update({ where, data: { status: 'FAILED', reason: 'ATTEMPT_LIMIT', leaseToken: null, leaseUntil: null, completedAt: new Date() } });
        continue;
      }
      const token = randomUUID();
      await tx.$executeRaw`UPDATE "LabBertScore" SET status='RUNNING', attempts=attempts+1, "leaseToken"=${token},
        "leaseUntil"=(clock_timestamp() AT TIME ZONE 'UTC') + ${BERT_LEASE_MS} * interval '1 millisecond'
        WHERE "runId"=${row.runId} AND "caseId"=${row.caseId}`;
      const result = await tx.labResult.findUniqueOrThrow({ where, include: { testCase: true } });
      claims.push({ runId: row.runId, caseId: row.caseId, inputHash: row.inputHash, token,
        candidate: LabOutputSchema.parse(result.output).reason, reference: LabCaseSchema.parse(result.testCase.body).reference.expectedReason });
    }
    return claims;
  });
}

export async function renewBertLease(db: PrismaClient, claim: BertClaim) {
  return (await db.$executeRaw`UPDATE "LabBertScore" SET
    "leaseUntil"=(clock_timestamp() AT TIME ZONE 'UTC') + ${BERT_LEASE_MS} * interval '1 millisecond'
    WHERE "runId"=${claim.runId} AND "caseId"=${claim.caseId} AND "leaseToken"=${claim.token}
    AND status='RUNNING' AND "leaseUntil" > clock_timestamp() AT TIME ZONE 'UTC'`) === 1;
}

export async function finishBertScore(db: PrismaClient, claim: BertClaim, outcome: LabBertScoreResponse | { status: 'FAILED'; reason: string }) {
  return db.$transaction(async tx => {
    // Same lock order as cancellation and generation completion.
    await tx.$queryRaw`SELECT id FROM "LabRun" WHERE id=${claim.runId} FOR UPDATE`;
    const score = outcome.status === 'SUCCEEDED' ? outcome : null;
    const identity = 'identity' in outcome ? JSON.stringify(outcome.identity) : null;
    const failed = outcome.status === 'FAILED';
    return (await tx.$executeRaw`UPDATE "LabBertScore" SET
      status=CASE WHEN ${failed} AND attempts < ${BERT_TOTAL_ATTEMPTS} AND attempts-"retryBase" < ${BERT_MAX_ATTEMPTS} THEN 'PENDING' ELSE ${outcome.status} END,
      precision=${score?.precision ?? null}, recall=${score?.recall ?? null}, f1=${score?.f1 ?? null}, identity=${identity}::jsonb,
      reason=${'reason' in outcome ? outcome.reason : null}, "leaseToken"=NULL, "leaseUntil"=NULL,
      "nextAttemptAt"=(clock_timestamp() AT TIME ZONE 'UTC') + (attempts-"retryBase") * interval '5 seconds',
      "completedAt"=CASE WHEN ${failed} AND attempts < ${BERT_TOTAL_ATTEMPTS} AND attempts-"retryBase" < ${BERT_MAX_ATTEMPTS} THEN NULL ELSE clock_timestamp() AT TIME ZONE 'UTC' END
      WHERE "runId"=${claim.runId} AND "caseId"=${claim.caseId} AND "leaseToken"=${claim.token} AND "inputHash"=${claim.inputHash}
      AND status='RUNNING' AND "leaseUntil" > clock_timestamp() AT TIME ZONE 'UTC'`) === 1;
  });
}
