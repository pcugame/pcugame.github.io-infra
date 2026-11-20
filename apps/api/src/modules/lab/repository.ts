import { createHash, randomUUID } from 'node:crypto';
import {
	LAB_ACTIVE_RUN_LIMIT,
	LAB_CASE_ATTEMPT_LIMIT,
	LAB_PAGE_SIZE,
	LabCaseSchema,
	LabDatasetSchema,
	LabResultSchema,
	LabRunSchema,
	formatLabExport,
	labCaseFields,
	parseLabJsonl,
	type LabCreateRun,
	type LabResult,
	type UserRole,
} from '@pcu/contracts';
import { Prisma, type PrismaClient, type LabRun } from '../../generated/prisma/client.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';

type Actor = { id: number; role: UserRole };
type Page = { page: number; q: string };
type Tx = Prisma.TransactionClient;
type ResultRow = Prisma.LabResultGetPayload<{ include: { testCase: { select: { body: true } } } }>;
const withCase = { testCase: { select: { body: true } } } as const;
const betaRoles = ['USER', 'BETA_TESTER'] as const;
const userFields = { id: true, email: true, name: true, role: true };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const offset = (page: number) => (page - 1) * LAB_PAGE_SIZE;
const scope = (actor: Actor) => (actor.role === 'ADMIN' ? {} : { ownerId: actor.id });

function matchesCase(q: string): Prisma.LabTestCaseWhereInput {
	const contains = { contains: q, mode: 'insensitive' as const };
	return q ? { OR: [{ caseId: contains }, { term: contains }, { context: contains }] } : {};
}

function resultView(row: ResultRow): LabResult {
	return LabResultSchema.parse({ ...row, testCase: row.testCase.body });
}

async function readableRun(db: Tx, actor: Actor, id: string) {
	const run = await db.labRun.findFirst({ where: { id, ...scope(actor) } });
	if (!run) throw notFound('Run not found');
	return run;
}

async function readableDataset(db: Tx, actor: Actor, id: string) {
	const dataset = await db.labDataset.findFirst({ where: { id, ...scope(actor) } });
	if (!dataset) throw notFound('Dataset not found');
	return dataset;
}

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
      count(output->>'controversyScore')::int AS scored, avg((output->>'controversyScore')::float8) AS "meanScore",
      count(*) FILTER (WHERE output->>'abstained'='true')::int AS abstained
    FROM "LabResult" e JOIN "LabDataset" d ON e."datasetId" = d.id
    WHERE "runId" IN (${Prisma.join(runs.map((r) => r.id))}) GROUP BY "runId", d.version`;
	const byId = new Map(counts.map((item) => [item.runId, item]));
	return runs.map((r) => {
		const totals = byId.get(r.id)!;
		return LabRunSchema.parse({
			...r,
			...totals,
			createdAt: r.createdAt.toISOString(),
			startedAt: r.startedAt?.toISOString() ?? null,
			completedAt: r.completedAt?.toISOString() ?? null,
			stats: { meanScore: totals.meanScore, scored: totals.scored, abstained: totals.abstained },
		});
	});
}

export function createLabRepository(db: PrismaClient) {
	return {
		async datasets(actor: Actor, page: number) {
			const datasets = await db.labDataset.findMany({
				where: scope(actor),
				orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
				skip: offset(page),
				take: LAB_PAGE_SIZE,
			});
			return datasets.map((r) => LabDatasetSchema.parse({ ...r, createdAt: r.createdAt.toISOString() }));
		},
		async upload(actor: Actor, name: string, jsonl: string) {
			let cases;
			try {
				cases = parseLabJsonl(jsonl);
			} catch (e) {
				throw badRequest(e instanceof Error ? e.message : 'Invalid dataset', 'VALIDATION_ERROR');
			}
			const version = 'nickname' in cases[0]! ? '2' : '1';
			const hash = sha(jsonl);
			const rows = cases.map((body, ordinal) => ({
				caseId: body.id,
				ordinal,
				...labCaseFields(body),
				body,
			}));
			const dataset = await db.$transaction(async (tx) => {
				const id = randomUUID();
				const inserted = await tx.labDataset.createMany({
					data: { id, ownerId: actor.id, name, hash, count: rows.length, version },
					skipDuplicates: true,
				});
				if (inserted.count)
					await tx.labTestCase.createMany({ data: rows.map((row) => ({ ...row, datasetId: id })) });
				return tx.labDataset.findUniqueOrThrow({ where: { ownerId_hash: { ownerId: actor.id, hash } } });
			});
			return LabDatasetSchema.parse({ ...dataset, createdAt: dataset.createdAt.toISOString() });
		},
		async cases(actor: Actor, datasetId: string, query: Page) {
			await readableDataset(db, actor, datasetId);
			const where = { datasetId, ...matchesCase(query.q) };
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
		async createRun(actor: Actor, request: LabCreateRun, provider: string) {
			return db.$transaction(async (tx) => {
				// Serialize the per-owner capacity check with other creates and retries.
				await tx.$queryRaw`SELECT id FROM users WHERE id=${actor.id} FOR UPDATE`;
				const active = await tx.labRun.count({
					where: { ownerId: actor.id, status: { in: ['QUEUED', 'RUNNING'] } },
				});
				if (active >= LAB_ACTIVE_RUN_LIMIT) throw conflict('Three evaluations are already queued or running');
				const dataset = await readableDataset(tx, actor, request.datasetId);
				const cases = await tx.labTestCase.findMany({
					where: { datasetId: dataset.id, caseId: { in: request.caseIds } },
					orderBy: { ordinal: 'asc' },
					select: { caseId: true },
					take: request.size,
				});
				if (cases.length !== request.size) throw badRequest('Invalid case selection');
				const { caseIds, ...settings } = request;
				const run = await tx.labRun.create({
					data: {
						...settings,
						ownerId: actor.id,
						provider,
						promptHash: sha(request.systemPrompt),
						datasetHash: dataset.hash,
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
				if (action === 'retry') await tx.$queryRaw`SELECT id FROM users WHERE id=${visible.ownerId} FOR UPDATE`;
				await tx.$queryRaw`SELECT id FROM "LabRun" WHERE id=${id} FOR UPDATE`;
				const run = await readableRun(tx, actor, id);
				if (action === 'cancel') {
					if (run.status === 'COMPLETED') throw conflict('Run already completed');
					if (run.status !== 'CANCELLED') {
						await tx.labResult.updateMany({
							where: { runId: id, status: { in: ['PENDING', 'RUNNING'] } },
							data: { status: 'CANCELLED', leaseToken: null, leaseUntil: null },
						});
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
					await tx.labRun.update({ where: { id }, data: { status: 'QUEUED', completedAt: null } });
				}
				return { runId: id };
			});
		},
		async compare(actor: Actor, query: Page & { left: string; right: string }) {
			return db.$transaction(
				async (tx) => {
					const sides = [query.left, query.right];
					for (const id of sides) await readableRun(tx, actor, id);
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
		async exportRun(actor: Actor, id: string, format: 'json' | 'jsonl' | 'csv') {
			const { run, results } = await db.$transaction(
				async (tx) => {
					const [run] = await runViews(tx, [await readableRun(tx, actor, id)]);
					const results = await tx.labResult.findMany({
						where: { runId: id },
						orderBy: { ordinal: 'asc' },
						include: withCase,
					});
					return { run: run!, results };
				},
				{ isolationLevel: 'RepeatableRead' },
			);
			return formatLabExport(run, results.map(resultView), format);
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
