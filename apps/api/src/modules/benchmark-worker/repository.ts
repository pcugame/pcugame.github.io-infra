import { LAB_CASE_ATTEMPT_LIMIT } from '@pcu/contracts';
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type { Attempt, WorkItem } from './evaluate.js';

export const LEASE_MS = 30_000;
const MAX_ATTEMPTS = 3;
export type Claim = {
	runId: string;
	caseId: string;
	token: string;
	item: WorkItem;
};

async function finalize(tx: Prisma.TransactionClient, runId: string) {
	await tx.$executeRaw`UPDATE "LabRun" SET status='COMPLETED', "completedAt"=clock_timestamp() AT TIME ZONE 'UTC'
		WHERE id=${runId} AND status='RUNNING' AND NOT EXISTS
		(SELECT 1 FROM "LabResult" WHERE "runId"=${runId} AND status IN ('PENDING','RUNNING'))`;
}

export async function claimCase(db: PrismaClient, concurrency: number): Promise<Claim | 'reaped' | null> {
	return db.$transaction(
		async (tx) => {
			// Serialize capacity admission across all worker processes. This lock is
			// released before external I/O; a durable, renewable lease owns the slot.
			await tx.$queryRaw`SELECT 1 AS held FROM pg_advisory_xact_lock(796405101, 1)`;
			const [capacity] = await tx.$queryRaw<{ active: bigint }[]>`SELECT COUNT(*) AS active FROM "LabResult"
			WHERE status='RUNNING' AND "leaseUntil" > clock_timestamp() AT TIME ZONE 'UTC'`;
			if (Number(capacity?.active) >= concurrency) return null;
			const [run] = await tx.$queryRaw<
				({ id: string } & Omit<WorkItem, 'testCase'>)[]
			>`SELECT id, model, provider, temperature,
			"maxTokens", "searchMode", "systemPrompt" FROM "LabRun" r
			WHERE status IN ('QUEUED','RUNNING') AND EXISTS
			(SELECT 1 FROM "LabResult" e WHERE e."runId"=r.id AND (e.status='PENDING'
				OR (e.status='RUNNING' AND e."leaseUntil" <= clock_timestamp() AT TIME ZONE 'UTC')))
			ORDER BY "createdAt", id LIMIT 1 FOR UPDATE SKIP LOCKED`;
			if (!run) return null;
			const [result] = await tx.$queryRaw<
				{
					caseId: string;
					datasetId: string;
					attempts: number;
					retryBase: number;
					status: string;
				}[]
			>`SELECT "caseId","datasetId",attempts,"retryBase",status FROM "LabResult" WHERE "runId"=${run.id}
			AND (status='PENDING' OR (status='RUNNING' AND "leaseUntil" <= clock_timestamp() AT TIME ZONE 'UTC'))
			ORDER BY ordinal LIMIT 1 FOR UPDATE`;
			if (!result) return null;
			if (result.status === 'RUNNING') {
				await tx.$executeRaw`UPDATE "LabResult" SET history = history || jsonb_build_object(
				'event','lease_expired','attempt',attempts,'at',clock_timestamp()) WHERE "runId"=${run.id} AND "caseId"=${result.caseId}`;
			}
			if (result.attempts >= LAB_CASE_ATTEMPT_LIMIT || result.attempts - result.retryBase >= MAX_ATTEMPTS) {
				await tx.$executeRaw`UPDATE "LabResult" SET status='FAILED', error='ATTEMPT_LIMIT', "leaseToken"=NULL, "leaseUntil"=NULL
				WHERE "runId"=${run.id} AND "caseId"=${result.caseId}`;
				await finalize(tx, run.id);
				return 'reaped';
			}
			const token = randomUUID();
			await tx.$executeRaw`UPDATE "LabResult" SET status='RUNNING', attempts=attempts+1, "leaseToken"=${token},
			"leaseUntil"=(clock_timestamp() AT TIME ZONE 'UTC') + ${LEASE_MS} * interval '1 millisecond',
			history=history || jsonb_build_object('event','started','attempt',attempts+1,'at',clock_timestamp())
			WHERE "runId"=${run.id} AND "caseId"=${result.caseId}`;
			await tx.$executeRaw`UPDATE "LabRun" SET status='RUNNING',"startedAt"=COALESCE("startedAt",clock_timestamp() AT TIME ZONE 'UTC')
			WHERE id=${run.id} AND status='QUEUED'`;
			const { caseId: id, ...fields } = await tx.labTestCase.findUniqueOrThrow({
				where: { datasetId_caseId: { datasetId: result.datasetId, caseId: result.caseId } },
				select: { caseId: true, term: true, language: true, context: true },
			});
			return { runId: run.id, caseId: id, token, item: { ...run, testCase: { id, ...fields } } };
		},
		{ isolationLevel: 'ReadCommitted' },
	);
}

export async function renewLease(db: PrismaClient, claim: Claim) {
	const count = await db.$executeRaw`UPDATE "LabResult" SET
		"leaseUntil"=(clock_timestamp() AT TIME ZONE 'UTC') + ${LEASE_MS} * interval '1 millisecond'
		WHERE "runId"=${claim.runId} AND "caseId"=${claim.caseId} AND "leaseToken"=${claim.token} AND status='RUNNING'
		AND "leaseUntil" > clock_timestamp() AT TIME ZONE 'UTC'`;
	return count === 1;
}

export async function finishCase(db: PrismaClient, claim: Claim, attempt: Attempt) {
	return db.$transaction(
		async (tx) => {
			const [run] = await tx.$queryRaw<
				{ status: string }[]
			>`SELECT status FROM "LabRun" WHERE id=${claim.runId} FOR UPDATE`;
			if (run?.status !== 'RUNNING') return false;
			const history = JSON.stringify({
				event: 'finished',
				at: new Date().toISOString(),
				durationMs: attempt.durationMs,
				searchCount: attempt.searchCount,
				toolSupport: attempt.toolSupport,
				toolCalls: attempt.toolCalls,
				toolSucceeded: attempt.toolSucceeded,
				jsonAttempts: attempt.jsonAttempts,
				outputFormat: attempt.outputFormat,
				generationUsage: attempt.generationUsage,
				suppliedSourceIds: attempt.suppliedSourceIds,
				error: attempt.error,
			});
			const changed = await tx.$executeRaw`UPDATE "LabResult" SET
			status=CASE WHEN ${!!attempt.output} THEN 'SUCCEEDED' WHEN ${attempt.retryable} AND attempts < ${LAB_CASE_ATTEMPT_LIMIT} AND attempts-"retryBase" < ${MAX_ATTEMPTS}
				THEN 'PENDING' ELSE 'FAILED' END, "leaseToken"=NULL, "leaseUntil"=NULL,
			output=${attempt.output ? JSON.stringify(attempt.output) : null}::jsonb, sources=${JSON.stringify(attempt.sources)}::jsonb,
			"durationMs"=${attempt.durationMs}, "searchCount"=${attempt.searchCount}, "jsonValid"=${!!attempt.output},
			error=${attempt.error}, "toolSupport"=${attempt.toolSupport}, "toolSucceeded"=${attempt.toolSucceeded},
			history=history || (${history}::jsonb || jsonb_build_object('attempt',attempts))
			WHERE "runId"=${claim.runId} AND "caseId"=${claim.caseId} AND "leaseToken"=${claim.token} AND status='RUNNING'
			AND "leaseUntil" > clock_timestamp() AT TIME ZONE 'UTC'`;
			if (changed !== 1) return false;
			await finalize(tx, claim.runId);
			return true;
		},
		{ isolationLevel: 'ReadCommitted' },
	);
}
