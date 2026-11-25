import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	LAB_NICKNAME_PROTOCOL,
	LAB_NICKNAME_SYSTEM_PROMPT,
	LabResultSchema,
	LabRunSchema,
} from '@pcu/contracts';
import { createLabRepository } from '../modules/lab/repository.js';
import { claimCase, finishCase } from '../modules/benchmark-worker/repository.js';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';

const migration = '20261125100000_lab_nickname_only';
const sql = await readFile(
	new URL(`../../prisma/migrations/${migration}/migration.sql`, import.meta.url),
	'utf8',
);

async function fixture() {
	const database = await createIsolatedMigratedDatabase(process.env.DATABASE_URL!, migration);
	const db = database.createClient();
	const owner = await db.user.create({ data: { googleSub: 'migration-lab', role: 'BETA_TESTER' } });
	const exhibition = await db.exhibition.create({
		data: { title: 'Preserved graduation exhibition', year: 2099 },
	});
	const project = await db.project.create({
		data: {
			exhibitionId: exhibition.id,
			creatorId: owner.id,
			title: 'Preserved project',
			slug: randomUUID(),
		},
	});
	const datasetIds: string[] = [];
	for (const [index, type] of ['context_terms', 'nickname_legacy', 'nickname_risk'].entries()) {
		const id = randomUUID();
		datasetIds.push(id);
		const version = String(index + 1);
		const nickname = '가상닉네임';
		const body =
			type === 'nickname_risk'
				? {
						id: 'case',
						nickname,
						reference: {
							expectedReason: '보존할 기대 근거',
							expectedScore: 65,
							scoreRange: [50, 80],
							sources: ['https://example.org/human'],
						},
						split: 'test',
						familyId: 'family',
						tags: ['review'],
					}
				: type === 'nickname_legacy'
					? { id: 'case', nickname }
					: { id: 'case', term: 'retired', context: 'retired', language: 'en' };
		await db.$executeRaw`INSERT INTO "LabDataset" (id,"ownerId",name,version,hash,count,"datasetType","schemaVersion") VALUES (${id},${owner.id},'snapshot',${version},${'hash-' + version},1,${type},${version})`;
		await db.$executeRaw`INSERT INTO "LabTestCase" ("datasetId","caseId",ordinal,term,context,language,body,split,"familyId") VALUES (${id},'case',0,${nickname},'','ko',${JSON.stringify(body)}::jsonb,'test','family')`;
		for (const status of ['COMPLETED', 'QUEUED', 'RUNNING', 'CANCELLED']) {
			const runId = randomUUID();
			const protocol = type === 'nickname_risk' ? LAB_NICKNAME_PROTOCOL : 'legacy-custom-v1';
			await db.$executeRaw`INSERT INTO "LabRun" (id,"ownerId","datasetId","datasetHash","systemPrompt","promptHash",model,provider,"searchMode",temperature,"maxTokens",size,status,"datasetType","schemaVersion","evaluationProtocol",split) VALUES (${runId},${owner.id},${id},${'hash-' + version},${LAB_NICKNAME_SYSTEM_PROMPT},'preserved-prompt-hash','fixture','ollama','no_search',0,256,1,${status},${type},${version},${protocol},'test')`;
			const output =
				status === 'COMPLETED'
					? type === 'nickname_risk'
						? {
								schemaVersion: '2',
								nickname,
								interpretedTerm: null,
								reason: '보존할 모델 근거',
								score: 62,
								confidence: 0.4,
								sourceIds: ['S1'],
								abstained: false,
							}
						: { schemaVersion: '1', controversyScore: 30 }
					: null;
			const resultStatus = {
				COMPLETED: 'SUCCEEDED',
				QUEUED: 'PENDING',
				RUNNING: 'RUNNING',
				CANCELLED: 'CANCELLED',
			}[status]!;
			await db.$executeRaw`INSERT INTO "LabResult" ("runId","datasetId","caseId",ordinal,status,output,history,sources,attempts,"leaseToken","leaseUntil") VALUES (${runId},${id},'case',0,${resultStatus},${output ? JSON.stringify(output) : null}::jsonb,'[{"event":"preserved"}]'::jsonb,'[{"id":"S1","url":"https://example.org/model","title":"Evidence","snippet":"Collected excerpt","collectedAt":"2026-11-25T00:00:00.000Z"}]'::jsonb,1,${status === 'RUNNING' ? 'old-lease' : null},${status === 'RUNNING' ? new Date(0) : null})`;
		}
	}
	await db.labRoleAudit.create({
		data: { actorId: owner.id, targetId: owner.id, beforeRole: 'USER', afterRole: 'BETA_TESTER' },
	});
	const untouched = async () => ({
		users: await db.user.findMany(),
		exhibitions: await db.exhibition.findMany(),
		projects: await db.project.findMany(),
		audits: await db.labRoleAudit.findMany(),
	});
	const snapshot = async () => ({
		datasets: await db.$queryRaw`SELECT * FROM "LabDataset" ORDER BY id`,
		cases: await db.$queryRaw`SELECT * FROM "LabTestCase" ORDER BY "datasetId"`,
		runs: await db.$queryRaw`SELECT * FROM "LabRun" ORDER BY id`,
		results: await db.$queryRaw`SELECT * FROM "LabResult" ORDER BY "runId"`,
		untouched: await untouched(),
	});
	return { database, db, owner, project, datasetIds, snapshot, untouched };
}

describe.runIf(process.env.RUN_POSTGRES_INTEGRATION === 'true')('nickname-only Lab cleanup migration', () => {
	it('removes only retired experiments, preserves Phase 1 history and resumes pending work', async () => {
		const f = await fixture();
		try {
			const { db, datasetIds } = f;
			const before = await f.snapshot();
			const preservedId = datasetIds[2]!;
			const preserved = await db.$queryRaw<
				Record<string, unknown>[]
			>`SELECT * FROM "LabRun" WHERE "datasetId"=${preservedId} ORDER BY id`;
			const results = await db.labResult.findMany({
				where: { datasetId: preservedId },
				orderBy: { runId: 'asc' },
			});
			const cases = await db.$queryRaw<
				Record<string, unknown>[]
			>`SELECT * FROM "LabTestCase" WHERE "datasetId"=${preservedId}`;
			const datasets = await db.$queryRaw<
				Record<string, unknown>[]
			>`SELECT * FROM "LabDataset" WHERE id=${preservedId}`;
			await db.$executeRawUnsafe(sql);
			expect(await db.labDataset.findMany()).toEqual(datasets.map(({ datasetType: _type, ...row }) => row));
			expect(await db.$queryRaw`SELECT * FROM "LabRun" ORDER BY id`).toEqual(
				preserved.map(({ datasetType: _type, ...row }) => row),
			);
			expect(await db.labTestCase.findMany()).toEqual(
				cases.map(({ term, context: _context, language: _language, ...row }) => ({ ...row, nickname: term })),
			);
			expect(await db.labResult.findMany({ orderBy: { runId: 'asc' } })).toEqual(results);
			expect(await f.untouched()).toEqual(before.untouched);
			const columns = await db.$queryRaw<
				{ column_name: string }[]
			>`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name IN ('LabDataset','LabRun','LabTestCase')`;
			expect(columns.map((c) => c.column_name)).not.toEqual(expect.arrayContaining(['datasetType']));
			for (const name of ['term', 'context', 'language', 'datasetType'])
				expect(columns.map((c) => c.column_name)).not.toContain(name);
			// Exercise the current repository only after its additive successor schema exists.
			await db.$executeRawUnsafe(await readFile(new URL(
				'../../prisma/migrations/20261125120000_lab_human_evaluation/migration.sql', import.meta.url,
			), 'utf8'));
			await db.$executeRawUnsafe(await readFile(new URL(
				'../../prisma/migrations/20261125130000_lab_editable_prompts/migration.sql', import.meta.url,
			), 'utf8'));
			const repo = createLabRepository(db);
			const actor = { id: f.owner.id, role: 'BETA_TESTER' as const };
			for (const run of await repo.runs(actor, 1)) {
				LabRunSchema.parse(run);
				expect(run).toMatchObject({ systemPrompt: LAB_NICKNAME_SYSTEM_PROMPT,
					promptHash: 'preserved-prompt-hash', actionPrompt: null, answerPrompt: null });
				const rows = await repo.results(actor, run.id, { page: 1, q: '' });
				LabResultSchema.array().parse(rows.items);
				expect(JSON.parse((await repo.exportRun(actor, run.id, 'json')).content).results).toHaveLength(1);
			}
			// Both a queued case and an expired lease survive and can be claimed again.
			for (let i = 0; i < 2; i++) {
				const claim = await claimCase(db, 1);
				if (!claim || claim === 'reaped') throw new Error('Expected preserved work');
				expect(claim.item.input).toEqual({ nickname: '가상닉네임' });
				expect(
					await finishCase(db, claim, {
						output: null,
						error: 'TEST_FAILURE',
						retryable: false,
						sources: [],
						searchCount: 0,
						toolSucceeded: false,
						toolSupport: 'unknown',
						toolCalls: 0,
						jsonAttempts: 1,
						outputFormat: 'schema',
						durationMs: 1,
					}),
				).toBe(true);
			}
			expect(await claimCase(db, 1)).toBeNull();
		} finally {
			await f.database.close();
		}
	}, 60000);

	for (const failure of ['invalid case', 'unknown type', 'inconsistent run', 'live lease'] as const) {
		it(`rolls back cleanup and preserves exhibition data on ${failure}`, async () => {
			const f = await fixture();
			try {
				const { db, datasetIds } = f;
				const id = datasetIds[2]!;
				if (failure === 'invalid case')
					await db.$executeRaw`UPDATE "LabTestCase" SET body=body-'reference' WHERE "datasetId"=${id}`;
				if (failure === 'unknown type')
					await db.$executeRaw`UPDATE "LabDataset" SET "datasetType"='unrecognized' WHERE id=${id}`;
				if (failure === 'inconsistent run')
					await db.$executeRaw`UPDATE "LabRun" SET "datasetType"='context_terms' WHERE "datasetId"=${id}`;
				if (failure === 'live lease')
					await db.$executeRaw`UPDATE "LabResult" SET "leaseUntil"=CURRENT_TIMESTAMP+interval '1 hour' WHERE "datasetId"=${id} AND status='RUNNING'`;
				const before = await f.snapshot();
				const migrationClient = f.database.createClient();
				try {
					await expect(migrationClient.$executeRawUnsafe(sql)).rejects.toThrow(
						/Invalid Phase 1|Unrecognized or inconsistent|active leases/,
					);
				} finally {
					await migrationClient.$executeRawUnsafe('ROLLBACK');
					await migrationClient.$disconnect();
				}
				expect(await f.snapshot()).toEqual(before);
				// The late validation failure has rolled back both deletions and column DDL.
				const columns = await db.$queryRaw<
					{ column_name: string }[]
				>`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='LabTestCase'`;
				expect(columns.map((c) => c.column_name)).toEqual(
					expect.arrayContaining(['term', 'context', 'language']),
				);
				expect(columns.map((c) => c.column_name)).not.toContain('nickname');
			} finally {
				await f.database.close();
			}
		}, 60000);
	}
});
