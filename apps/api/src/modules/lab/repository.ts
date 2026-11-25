import { randomUUID } from 'node:crypto';
import {
	LAB_ACTIVE_RUN_LIMIT,
	LAB_CASE_ATTEMPT_LIMIT,
	LAB_PAGE_SIZE,
	LabCaseSchema,
	LabDatasetSchema,
	LabRunSchema,
	formatLabExport, LabHumanReviewSchema, labReviewResult, labBertScoreSummary, type LabBertScoreSummary,
	parseLabUpload,
	LAB_DATASET_IDENTITY,
	labPromptSettings,
	labPromptSnapshot,
	LAB_NICKNAME_PROTOCOL,
  labFamilyKey,
	type LAB_RESEARCH_PROFILE,
	type LabUpload,
	type LabSplitSchema,
	type LabCreateRun,
} from '@pcu/contracts';
import type { z } from 'zod';
import { Prisma, type PrismaClient, type LabRun } from '../../generated/prisma/client.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';

import { betaRoles, userFields, sha, offset, scope, withCase, matchesCase, resultView, readableRun, readableDataset, type Actor } from './access.js';
import { createLabHumanRepository, freezeLabFamilies } from './human-repository.js';

type Page = { page: number; q: string; split?: z.infer<typeof LabSplitSchema> };
type Tx = Prisma.TransactionClient;

// Aggregate within PostgreSQL. Progress polling never transfers case bodies or response text.
async function runViews(db: Tx, runs: LabRun[]) {
	if (!runs.length) return [];
	type Counts = {
		datasetVersion: string;
		runId: string;
		success: number;
		failed: number;
		cancelled: number;
		scored: number;
		abstained: number;
		meanScore: number | null;
	};
	const counts = await db.$queryRaw<Counts[]>`
    SELECT "runId", d.version AS "datasetVersion", count(*) FILTER (WHERE status='SUCCEEDED')::int AS success,
      count(*) FILTER (WHERE status='FAILED')::int AS failed,
      count(*) FILTER (WHERE status='CANCELLED')::int AS cancelled,
      count(output->>'score')::int AS scored, avg((output->>'score')::float8) AS "meanScore",
      count(*) FILTER (WHERE output->>'abstained'='true')::int AS abstained
    FROM "LabResult" e JOIN "LabDataset" d ON e."datasetId" = d.id
    WHERE "runId" IN (${Prisma.join(runs.map((r) => r.id))}) GROUP BY "runId", d.version`;
  const bertCounts = await db.$queryRaw<(LabBertScoreSummary & { runId: string })[]>`
    SELECT "runId", count(*) FILTER (WHERE status='SUCCEEDED')::int AS measured,
      count(*) FILTER (WHERE status='PENDING')::int AS pending, count(*) FILTER (WHERE status='RUNNING')::int AS running,
      count(*) FILTER (WHERE status='FAILED')::int AS failed, count(*) FILTER (WHERE status='SKIPPED')::int AS skipped,
      count(*) FILTER (WHERE status='CANCELLED')::int AS cancelled,
      avg(precision) FILTER (WHERE status='SUCCEEDED') AS precision, avg(recall) FILTER (WHERE status='SUCCEEDED') AS recall,
      avg(f1) FILTER (WHERE status='SUCCEEDED') AS f1 FROM "LabBertScore"
    WHERE "runId" IN (${Prisma.join(runs.map(r => r.id))}) GROUP BY "runId"`;
  const bertById = new Map(bertCounts.map(r => [r.runId, r]));
	const byId = new Map(counts.map((item) => [item.runId, item]));
	return runs.map((r) => {
		const totals = byId.get(r.id)!;
    const bert = bertById.get(r.id) ?? labBertScoreSummary([]);
    const bertScore = { ...bert, missing: r.size - bert.measured,
      waiting: r.size - bert.measured - bert.pending - bert.running - bert.failed - bert.skipped - bert.cancelled };
		return LabRunSchema.parse({
			...r,
			...totals, bertScore,
			createdAt: r.createdAt.toISOString(),
			startedAt: r.startedAt?.toISOString() ?? null,
			completedAt: r.completedAt?.toISOString() ?? null,
			stats: { meanScore: totals.meanScore, scored: totals.scored, abstained: totals.abstained },
		});
	});
}

export function createLabRepository(db: PrismaClient) {
	return {
		...createLabHumanRepository(db),
		async datasets(actor: Actor, page: number) {
			const datasets = await db.labDataset.findMany({
				where: scope(actor),
				orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
				skip: offset(page),
				take: LAB_PAGE_SIZE,
			});
			return datasets.map((r) => LabDatasetSchema.parse({ ...r, createdAt: r.createdAt.toISOString() }));
		},
		async upload(actor: Actor, input: LabUpload) {
			let cases;
			try {
				cases = parseLabUpload(input);
			} catch (e) {
				throw badRequest(e instanceof Error ? e.message : 'Invalid dataset', 'VALIDATION_ERROR');
			}
			const identity = LAB_DATASET_IDENTITY;
			const name = input.name;
			const hash = sha(JSON.stringify({ ...identity, cases }));
			const rows = cases.map((body, ordinal) => ({
				caseId: body.id,
				ordinal,
				nickname: body.nickname,
				split: body.split ?? null,
				familyId: body.familyId ?? null,
				body,
			}));
			const dataset = await db.$transaction(async (tx) => {
				const id = randomUUID();
				const inserted = await tx.labDataset.createMany({
					data: { id, ownerId: actor.id, name, hash, count: rows.length, ...identity },
					skipDuplicates: true,
				});
				if (inserted.count)
					await tx.labTestCase.createMany({ data: rows.map((row) => ({ ...row, datasetId: id })) });
				await freezeLabFamilies(tx, cases);
				return tx.labDataset.findUniqueOrThrow({ where: { ownerId_hash: { ownerId: actor.id, hash } } });
			});
			return LabDatasetSchema.parse({ ...dataset, createdAt: dataset.createdAt.toISOString() });
		},
		async cases(actor: Actor, datasetId: string, query: Page) {
			await readableDataset(db, actor, datasetId);
			const where = { datasetId, split: query.split, ...matchesCase(query.q) };
			const [rows, total] = await Promise.all([
				db.labTestCase.findMany({
					where,
					select: { body: true },
					orderBy: { ordinal: 'asc' },
					skip: offset(query.page),
					take: LAB_PAGE_SIZE,
				}),
				db.labTestCase.count({ where }),
			]);
			return { items: rows.map((r) => LabCaseSchema.parse(r.body)), total };
		},
		async createRun(actor: Actor, request: LabCreateRun, provider: string, profile?: typeof LAB_RESEARCH_PROFILE) {
			const prompts = labPromptSettings(request, !!profile, provider === 'transformers-generate');
			return db.$transaction(async (tx) => {
				// Serialize the per-owner capacity check with other creates and retries.
				await tx.$queryRaw`SELECT id FROM users WHERE id=${actor.id} FOR UPDATE`;
				const active = await tx.labRun.count({
					where: { ownerId: actor.id, status: { in: ['QUEUED', 'RUNNING'] } },
				});
				if (active >= LAB_ACTIVE_RUN_LIMIT) throw conflict('Three evaluations are already queued or running');
				const dataset = await readableDataset(tx, actor, request.datasetId);
				const cases = await tx.labTestCase.findMany({
					where: { datasetId: dataset.id, split: request.split, caseId: { in: request.caseIds } },
					orderBy: { ordinal: 'asc' },
					select: { caseId: true, nickname: true, familyId: true, split: true },
					take: request.size,
				});
				if (cases.length !== request.size) throw badRequest('Invalid case selection');
        const plan = await freezeLabFamilies(tx, cases.map(c => ({ nickname: c.nickname, familyId: c.familyId ?? undefined, split: (c.split ?? undefined) as 'train' | 'validation' | 'test' | undefined })));
        if (cases.some(c => c.split === 'test' || (c.familyId && plan[labFamilyKey(c.familyId)] === 'test')) && !request.finalTest)
          throw badRequest('test 표현군은 튜닝에서 제외됩니다. 설정을 확정하고 최종 평가 사용을 명시하세요.');
				const { caseIds, ...settings } = request;
				const run = await tx.labRun.create({
					data: {
						...settings,
						ownerId: actor.id,
						provider,
						...prompts,
						promptHash: sha(labPromptSnapshot(prompts)),
						datasetHash: dataset.hash,
						schemaVersion: dataset.schemaVersion,
						evaluationProtocol: profile ?? LAB_NICKNAME_PROTOCOL,
					},
				});
				const ids = caseIds ?? cases.map((c) => c.caseId);
				await tx.labResult.createMany({
					data: ids.map((caseId, ordinal) => ({ runId: run.id, datasetId: dataset.id, caseId, ordinal })),
				});
				return { runId: run.id };
			});
		},
		async runs(actor: Actor, page: number) {
			return db.$transaction(
				async (tx) =>
					runViews(
						tx,
						await tx.labRun.findMany({
							where: scope(actor),
							orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
							skip: offset(page),
							take: LAB_PAGE_SIZE,
						}),
					),
				{ isolationLevel: 'RepeatableRead' },
			);
		},
		async run(actor: Actor, id: string) {
			return db.$transaction(async (tx) => (await runViews(tx, [await readableRun(tx, actor, id)]))[0]!, {
				isolationLevel: 'RepeatableRead',
			});
		},
		async results(actor: Actor, id: string, query: Page & { status?: string }) {
			await readableRun(db, actor, id);
			const where = { runId: id, status: query.status, testCase: matchesCase(query.q) };
			const [rows, total] = await db.$transaction(
				[
					db.labResult.findMany({
						where,
						include: withCase,
						orderBy: { ordinal: 'asc' },
						skip: offset(query.page),
						take: LAB_PAGE_SIZE,
					}),
					db.labResult.count({ where }),
				],
				{ isolationLevel: 'RepeatableRead' },
			);
			return { items: rows.map(resultView), total };
		},
		async changeRun(actor: Actor, id: string, action: 'cancel' | 'retry') {
			return db.$transaction(async (tx) => {
				const visible = await readableRun(tx, actor, id);
				if (action === 'retry')
					await tx.$queryRaw`SELECT id FROM users WHERE id=${visible.ownerId} FOR UPDATE`;
				await tx.$queryRaw`SELECT id FROM "LabRun" WHERE id=${id} FOR UPDATE`;
				const run = await readableRun(tx, actor, id);
				if (action === 'cancel') {
					if (run.status === 'COMPLETED') throw conflict('Run already completed');
					if (run.status !== 'CANCELLED') {
						await tx.labResult.updateMany({
							where: { runId: id, status: { in: ['PENDING', 'RUNNING'] } },
							data: { status: 'CANCELLED', leaseToken: null, leaseUntil: null },
						});
            const cancelled = await tx.labResult.findMany({ where: { runId: id, status: 'CANCELLED' }, select: { caseId: true } });
            await tx.labBertScore.createMany({ data: cancelled.map(r => ({ runId: id, caseId: r.caseId, status: 'SKIPPED',
              inputHash: '', reason: 'GENERATION_CANCELLED', completedAt: new Date() })), skipDuplicates: true });
            await tx.labBertScore.updateMany({ where: { runId: id, status: { in: ['PENDING', 'RUNNING'] } },
              data: { status: 'CANCELLED', reason: 'RUN_CANCELLED', leaseToken: null, leaseUntil: null, completedAt: new Date() } });
						await tx.labRun.update({ where: { id }, data: { status: 'CANCELLED', completedAt: new Date() } });
					}
				} else {
					if (run.status !== 'COMPLETED' && run.status !== 'CANCELLED')
						throw conflict('Wait for a terminal run before retrying');
					if (
						(await tx.labRun.count({
							where: { ownerId: run.ownerId, status: { in: ['QUEUED', 'RUNNING'] } },
						})) >= LAB_ACTIVE_RUN_LIMIT
					)
						throw conflict('Too many active runs');
					const changed = await tx.$executeRaw`UPDATE "LabResult" SET status='PENDING', "retryBase"=attempts,
            error=NULL, "jsonValid"=false, "leaseToken"=NULL, "leaseUntil"=NULL,
            history=history || jsonb_build_object('event','manual_retry','actorId',${actor.id}::int,'at',clock_timestamp())
            WHERE "runId"=${id} AND status='FAILED' AND attempts<${LAB_CASE_ATTEMPT_LIMIT}`;
					if (!changed) throw conflict('No eligible failed cases to retry');
          await tx.labBertScore.deleteMany({ where: { runId: id, status: 'SKIPPED', result: { status: 'PENDING' } } });
					await tx.labRun.update({ where: { id }, data: { status: 'QUEUED', completedAt: null } });
				}
				return { runId: id };
			});
		},
    async retryBertScore(actor: Actor, id: string) {
      return db.$transaction(async tx => {
        await readableRun(tx, actor, id);
        await tx.$queryRaw`SELECT id FROM "LabRun" WHERE id=${id} FOR UPDATE`;
        const changed = await tx.$executeRaw`UPDATE "LabBertScore" SET status='PENDING', "retryBase"=attempts,
          reason=NULL, "completedAt"=NULL, "nextAttemptAt"=clock_timestamp() AT TIME ZONE 'UTC', "leaseToken"=NULL, "leaseUntil"=NULL
          WHERE "runId"=${id} AND status IN ('FAILED','CANCELLED') AND attempts<12`;
        if (!changed) throw conflict('No eligible BERTScore jobs to retry');
        return { runId: id };
      });
    },
		async compare(actor: Actor, query: Page & { left: string; right: string }) {
			return db.$transaction(
				async (tx) => {
					const sides = [query.left, query.right];
					const left = await readableRun(tx, actor, query.left);
					const right = await readableRun(tx, actor, query.right);
					if (left.datasetHash !== right.datasetHash || left.schemaVersion !== right.schemaVersion)
						throw badRequest('Compare runs from the same dataset snapshot and schema');
					const keys = await tx.labResult.findMany({
						where: { runId: { in: sides }, testCase: matchesCase(query.q) },
						select: { caseId: true },
						distinct: ['caseId'],
						orderBy: { caseId: 'asc' },
					});
					const ids = keys
						.slice(offset(query.page), offset(query.page) + LAB_PAGE_SIZE)
						.map((row) => row.caseId);
					const rows = await tx.labResult.findMany({
						where: { runId: { in: sides }, caseId: { in: ids } },
						include: withCase,
					});
					const map = new Map(rows.map((r) => [r.runId + '/' + r.caseId, resultView(r)]));
					return {
						items: ids.map((caseId) => ({
							caseId,
							left: map.get(query.left + '/' + caseId) ?? null,
							right: map.get(query.right + '/' + caseId) ?? null,
						})),
						total: keys.length,
					};
				},
				{ isolationLevel: 'RepeatableRead' },
			);
		},
		async exportRun(actor: Actor, id: string, format: 'json' | 'jsonl' | 'csv', threshold = 50) {
			const { run, results, reviews, dataset, generatedAt } = await db.$transaction(
				async (tx) => {
					const [run] = await runViews(tx, [await readableRun(tx, actor, id)]);
					const results = await tx.labResult.findMany({
						where: { runId: id },
						orderBy: { ordinal: 'asc' },
						include: withCase,
					});
          const reviews = await tx.labHumanReview.findMany({ where: { runId: id }, orderBy: [{ caseId: 'asc' }, { revision: 'asc' }] });
          const dataset = await tx.labDataset.findUniqueOrThrow({ where: { id: run!.datasetId } });
          const [snapshot] = await tx.$queryRaw<{ at: Date }[]>`SELECT transaction_timestamp() AS at`;
					return { run: run!, results: results.map(resultView), reviews,
            dataset: LabDatasetSchema.parse({ ...dataset, createdAt: dataset.createdAt.toISOString() }), generatedAt: snapshot!.at.toISOString() };
				},
				{ isolationLevel: 'RepeatableRead' },
			);
			const hashes = new Map(results.map(r => [r.caseId, sha(JSON.stringify(labReviewResult(r)))]));
      return formatLabExport(run, results, format, { threshold, dataset, generatedAt,
        reviews: reviews.map(r => ({ ...LabHumanReviewSchema.parse({ ...r, createdAt: r.createdAt.toISOString() }),
          resultSnapshot: r.resultSnapshot, valid: hashes.get(r.caseId) === r.resultHash })) });
		},
		async users(q: string, page: number) {
			const contains = { contains: q, mode: 'insensitive' as const };
			const exactId = /^\d{1,9}$/.test(q) ? [{ id: Number(q) }] : [];
			const items = await db.user.findMany({
				where: { role: { in: [...betaRoles] }, OR: [{ name: contains }, { email: contains }, ...exactId] },
				select: userFields,
				orderBy: { id: 'asc' },
				skip: offset(page),
				take: LAB_PAGE_SIZE,
			});
			return { items };
		},
		async changeRole(actor: Actor, id: number, role: 'BETA_TESTER' | 'USER') {
			return db.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT id FROM users WHERE id=${id} FOR UPDATE`;
				const user = await tx.user.findFirst({
					where: { id, role: { in: [...betaRoles] } },
					select: userFields,
				});
				if (!user) throw notFound('Eligible user not found');
				if (user.role === role) return user;
				const updated = await tx.user.update({
					where: { id, role: user.role },
					data: { role },
					select: userFields,
				});
				await tx.labRoleAudit.create({
					data: { actorId: actor.id, targetId: id, beforeRole: user.role, afterRole: role },
				});
				return updated;
			});
		},
	};
}
