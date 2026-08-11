import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createImportRepository } from '../modules/admin/import/repository.js';
import { createImportService } from '../modules/admin/import/service.js';

const runPostgresIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';
const BARRIER_NAMESPACE = 50_100;
const BARRIER_KEY = 10;

describe.runIf(runPostgresIntegration)('import transaction invariants with PostgreSQL', () => {
	let control: PrismaClient;
	let operationA: PrismaClient;
	let operationB: PrismaClient;
	let blocker: PrismaClient;
	let creatorId: number;
	const testId = randomUUID();
	const rollbackFailureTitle = `ticket-010-forced-failure-${testId}`;
	const concurrentTitle = `ticket-010-concurrent-${testId}`;
	const exhibitionTitles: string[] = [];

	async function waitForBothImportsAtAdvisoryBarrier(): Promise<void> {
		for (let attempt = 0; attempt < 300; attempt += 1) {
			const rows = await control.$queryRaw<Array<{ waiting: bigint }>>`
				SELECT COUNT(*)::bigint AS "waiting"
				FROM pg_stat_activity
				WHERE datname = current_database()
					AND state = 'active'
					AND wait_event_type = 'Lock'
					AND wait_event = 'advisory'
			`;
			if ((rows[0]?.waiting ?? 0n) >= 2n) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error('Timed out waiting for both import transactions at the PostgreSQL barrier');
	}

	async function dropFaultTriggers(): Promise<void> {
		await control.$executeRawUnsafe('DROP TRIGGER IF EXISTS ticket_010_import_failure ON projects');
		await control.$executeRawUnsafe('DROP FUNCTION IF EXISTS ticket_010_fail_import_project()');
		await control.$executeRawUnsafe('DROP TRIGGER IF EXISTS ticket_010_import_barrier ON projects');
		await control.$executeRawUnsafe('DROP FUNCTION IF EXISTS ticket_010_barrier_import_project()');
	}

	beforeAll(async () => {
		const databaseUrl = process.env['DATABASE_URL'];
		if (!databaseUrl) throw new Error('DATABASE_URL is required for PostgreSQL integration tests');
		control = createPrismaClientForDatabase(databaseUrl);
		operationA = createPrismaClientForDatabase(databaseUrl);
		operationB = createPrismaClientForDatabase(databaseUrl);
		blocker = createPrismaClientForDatabase(databaseUrl);
		await Promise.all([
			control.$connect(),
			operationA.$connect(),
			operationB.$connect(),
			blocker.$connect(),
		]);
		await dropFaultTriggers();
		const creator = await control.user.create({
			data: {
				googleSub: `ticket-010-${testId}`,
				email: `ticket-010-${testId}@example.test`,
				name: 'Ticket 010 Import',
				role: 'ADMIN',
			},
		});
		creatorId = creator.id;
	});

	afterAll(async () => {
		if (!control) return;
		await blocker.$executeRaw`SELECT pg_advisory_unlock(${BARRIER_NAMESPACE}, ${BARRIER_KEY})`
			.catch(() => undefined);
		await dropFaultTriggers().catch(() => undefined);
		await control.exhibition.deleteMany({ where: { title: { in: exhibitionTitles } } });
		await control.user.deleteMany({ where: { id: creatorId } });
		await Promise.all([
			control.$disconnect(),
			operationA.$disconnect(),
			operationB.$disconnect(),
			blocker.$disconnect(),
		]);
	});

	it('rolls back the exhibition, first project, and members when a later create fails', async () => {
		await control.$executeRawUnsafe(`
			CREATE FUNCTION ticket_010_fail_import_project()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				IF NEW.title = '${rollbackFailureTitle}' THEN
					RAISE EXCEPTION 'ticket 010 forced middle create failure';
				END IF;
				RETURN NEW;
			END;
			$$
		`);
		await control.$executeRawUnsafe(`
			CREATE TRIGGER ticket_010_import_failure
			BEFORE INSERT ON projects
			FOR EACH ROW EXECUTE FUNCTION ticket_010_fail_import_project()
		`);

		const exhibitionTitle = `Ticket 010 rollback ${testId}`;
		exhibitionTitles.push(exhibitionTitle);
		const firstTitle = `ticket-010-first-${testId}`;
		const service = createImportService({
			repository: createImportRepository(operationA),
		});

		await expect(service.executeImport(JSON.stringify({
			years: [{ year: 2090, title: exhibitionTitle }],
			projects: [
				{
					year: 2090,
					title: firstTitle,
					slug: `ticket-010-first-${testId}`,
					members: [{ name: 'First Member', studentId: '010-1' }],
				},
				{
					year: 2090,
					title: rollbackFailureTitle,
					slug: `ticket-010-failure-${testId}`,
					members: [{ name: 'Failure Member', studentId: '010-2' }],
				},
			],
		}), creatorId)).rejects.toThrow('ticket 010 forced middle create failure');

		expect(await control.exhibition.count({ where: { title: exhibitionTitle } })).toBe(0);
		expect(await control.project.count({
			where: { title: { in: [firstTitle, rollbackFailureTitle] } },
		})).toBe(0);
		expect(await control.projectMember.count({
			where: { project: { title: { in: [firstTitle, rollbackFailureTitle] } } },
		})).toBe(0);

		await control.$executeRawUnsafe('DROP TRIGGER ticket_010_import_failure ON projects');
		await control.$executeRawUnsafe('DROP FUNCTION ticket_010_fail_import_project()');
	});

	it('lets one concurrent slug insert commit and fully rolls back the conflicting transaction', async () => {
		const exhibitionTitle = `Ticket 010 concurrent exhibition ${testId}`;
		exhibitionTitles.push(exhibitionTitle);
		const exhibition = await control.exhibition.create({
			data: { year: 2091, title: exhibitionTitle },
		});
		await control.$executeRawUnsafe(`
			CREATE FUNCTION ticket_010_barrier_import_project()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				IF NEW.title = '${concurrentTitle}' THEN
					PERFORM pg_advisory_xact_lock(${BARRIER_NAMESPACE}, ${BARRIER_KEY});
				END IF;
				RETURN NEW;
			END;
			$$
		`);
		await control.$executeRawUnsafe(`
			CREATE TRIGGER ticket_010_import_barrier
			BEFORE INSERT ON projects
			FOR EACH ROW EXECUTE FUNCTION ticket_010_barrier_import_project()
		`);
		await blocker.$executeRaw`SELECT pg_advisory_lock(${BARRIER_NAMESPACE}, ${BARRIER_KEY})`;

		const raw = JSON.stringify({
			years: [{ year: 2091, title: exhibitionTitle }],
			projects: [{
				year: 2091,
				title: concurrentTitle,
				slug: `ticket-010-shared-${testId}`,
				members: [{ name: 'Concurrent Member', studentId: '010-concurrent' }],
			}],
		});
		const importA = createImportService({
			repository: createImportRepository(operationA),
		}).executeImport(raw, creatorId);
		const importB = createImportService({
			repository: createImportRepository(operationB),
		}).executeImport(raw, creatorId);

		await waitForBothImportsAtAdvisoryBarrier();
		await blocker.$executeRaw`SELECT pg_advisory_unlock(${BARRIER_NAMESPACE}, ${BARRIER_KEY})`;
		const outcomes = await Promise.allSettled([importA, importB]);
		expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
		expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
		const projects = await control.project.findMany({
			where: { exhibitionId: exhibition.id, slug: `ticket-010-shared-${testId}` },
			include: { members: true },
		});
		expect(projects).toHaveLength(1);
		expect(projects[0]?.members).toHaveLength(1);
		expect(await control.exhibition.count({ where: { id: exhibition.id } })).toBe(1);

		await control.$executeRawUnsafe('DROP TRIGGER ticket_010_import_barrier ON projects');
		await control.$executeRawUnsafe('DROP FUNCTION ticket_010_barrier_import_project()');
	});
});
