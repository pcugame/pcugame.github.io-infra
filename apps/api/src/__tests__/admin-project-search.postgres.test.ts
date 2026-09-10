import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createProjectCrudRepository } from '../modules/admin/project/crud.repository.js';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';

const enabled = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';

describe.runIf(enabled)('admin project search PostgreSQL', () => {
	let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>;
	let db: PrismaClient;
	let adminId: number;
	const queryEvents: string[] = [];

	beforeAll(async () => {
		database = await createIsolatedMigratedDatabase(process.env['DATABASE_URL']!);
		db = database.createClient({ log: [{ emit: 'event', level: 'query' }] });
		(db as PrismaClient<'query'>).$on('query', (event) => queryEvents.push(event.query));
		adminId = (await db.user.create({ data: {
			googleSub: randomUUID(),
			email: `${randomUUID()}@test.invalid`,
			role: 'ADMIN',
		} })).id;
		const exhibition = await db.exhibition.create({ data: {
			year: 2097,
			title: 'Independent Games Showcase',
		} });
		await db.project.createMany({ data: Array.from({ length: 20 }, (_, index) => ({
			exhibitionId: exhibition.id,
			creatorId: adminId,
			slug: `showcase-${index}`,
			title: `Project ${index}`,
			summary: index === 0 ? 'Special summary' : '',
			status: 'PUBLISHED' as const,
		})) });
		const projects = await db.project.findMany({ select: { id: true } });
		await db.projectMember.createMany({ data: projects.map(({ id }, index) => ({
			projectId: id,
			name: `Member ${index}`,
			studentId: `3100${String(index).padStart(4, '0')}`,
		})) });
	});

	afterAll(async () => {
		await database?.close();
	});

	it('installs trigram indexes for every substring-search column', async () => {
		const indexes = await db.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
			SELECT indexname, indexdef
			FROM pg_indexes
			WHERE schemaname = current_schema()
				AND indexname IN (
					'exhibitions_title_trgm_idx',
					'projects_title_trgm_idx',
					'projects_summary_trgm_idx',
					'project_members_name_trgm_idx',
					'project_members_student_id_trgm_idx'
				)
		`;

		expect(indexes).toHaveLength(5);
		expect(indexes.every(({ indexdef }) => indexdef.includes('USING gin'))).toBe(true);
		expect(indexes.every(({ indexdef }) => indexdef.includes('gin_trgm_ops'))).toBe(true);
	});

	it('matches mixed year and exhibition-title tokens without per-result queries', async () => {
		const repository = createProjectCrudRepository(db);
		async function list(limit: number) {
			queryEvents.length = 0;
			const result = await repository.findProjectsForUser(adminId, true, {
				page: 1,
				limit,
				search: '2097 games',
				sort: 'createdAt',
				order: 'desc',
			});
			return { result, queryCount: queryEvents.length };
		}

		const one = await list(1);
		const fullPage = await list(20);

		expect(one.result).toMatchObject({ totalItems: 20 });
		expect(one.result.items).toHaveLength(1);
		expect(fullPage.result.items).toHaveLength(20);
		expect(fullPage.queryCount).toBe(one.queryCount);
		expect(fullPage.queryCount).toBeGreaterThan(0);
	});
});
