import { Prisma, type PrismaClient } from '../../../generated/prisma/client.js';
import type { ExportProgress, ExportResult } from '@pcu/contracts';
import type { ExportProject } from './ports.js';
import { conflict } from '../../../shared/errors.js';
import { parseWebglEntryKey } from '../../webgl/paths.js';

export interface ClaimedExportJob {
	id: string;
	year: number | null;
	dryRun: boolean;
	claimToken: string;
}

export function createExportRepository(client: PrismaClient) {
	return {
		async createJob(input: {
			id: string;
			requestedById: number;
			year: number | null;
			dryRun: boolean;
		}): Promise<{ id: string }> {
			try {
				return await client.exportJob.create({
					data: {
						...input,
						progress: {
							year: input.year,
							startedAt: Date.now(),
							phase: 'preparing',
							totalProjects: 0,
							currentProjectIndex: 0,
							currentProjectTitle: null,
							currentProjectFiles: [],
							totalFiles: 0,
							downloaded: 0,
							skipped: 0,
							failed: 0,
						},
					},
					select: { id: true },
				});
			} catch (error) {
				if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
					throw conflict('Export is already in progress');
				}
				throw error;
			}
		},

		async latestJob(): Promise<{
			id: string;
			status: string;
			progress: ExportProgress | null;
			result: ExportResult | null;
			error: string | null;
		} | null> {
			const job = await client.exportJob.findFirst({ orderBy: { createdAt: 'desc' } });
			return job ? {
				id: job.id,
				status: job.status,
				progress: job.progress as ExportProgress | null,
				result: job.result as ExportResult | null,
				error: job.error,
			} : null;
		},

		async claimNext(token: string, leaseMs: number): Promise<ClaimedExportJob | null> {
			const rows = await client.$queryRaw<Array<ClaimedExportJob>>(Prisma.sql`
				WITH candidate AS (
					SELECT "id"
					FROM "export_jobs"
					WHERE "status" = 'QUEUED'
						OR ("status" = 'RUNNING' AND "claim_until" <= clock_timestamp())
					ORDER BY "created_at"
					LIMIT 1
					FOR UPDATE SKIP LOCKED
				)
				UPDATE "export_jobs" AS job
				SET "status" = 'RUNNING',
					"claim_token" = ${token},
					"claim_until" = clock_timestamp() + (${leaseMs} * INTERVAL '1 millisecond'),
					"started_at" = COALESCE(job."started_at", clock_timestamp()),
					"updated_at" = clock_timestamp()
				FROM candidate
				WHERE job."id" = candidate."id"
				RETURNING job."id", job."year", job."dry_run" AS "dryRun",
					job."claim_token" AS "claimToken"
			`);
			return rows[0] ?? null;
		},

		async heartbeat(
			id: string,
			token: string,
			leaseMs: number,
			progress: ExportProgress | null,
		): Promise<boolean> {
			const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "export_jobs"
				SET "claim_until" = clock_timestamp() + (${leaseMs} * INTERVAL '1 millisecond'),
					"progress" = ${JSON.stringify(progress)}::jsonb,
					"updated_at" = clock_timestamp()
				WHERE "id" = ${id} AND "status" = 'RUNNING'
					AND "claim_token" = ${token} AND "claim_until" > clock_timestamp()
				RETURNING "id"
			`);
			return rows.length === 1;
		},

		async complete(id: string, token: string, result: ExportResult): Promise<boolean> {
			const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "export_jobs"
				SET "status" = 'COMPLETED', "result" = ${JSON.stringify(result)}::jsonb,
					"claim_token" = NULL, "claim_until" = NULL,
					"finished_at" = clock_timestamp(), "updated_at" = clock_timestamp()
				WHERE "id" = ${id} AND "status" = 'RUNNING'
					AND "claim_token" = ${token} AND "claim_until" > clock_timestamp()
				RETURNING "id"
			`);
			return rows.length === 1;
		},

		async fail(id: string, token: string, error: string): Promise<boolean> {
			const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "export_jobs"
				SET "status" = 'FAILED', "error" = ${error.slice(0, 500)},
					"claim_token" = NULL, "claim_until" = NULL,
					"finished_at" = clock_timestamp(), "updated_at" = clock_timestamp()
				WHERE "id" = ${id} AND "status" = 'RUNNING'
					AND "claim_token" = ${token} AND "claim_until" > clock_timestamp()
				RETURNING "id"
			`);
			return rows.length === 1;
		},

		/** Fetch all projects that have READY assets, optionally filtered by year. */
		async findProjectsWithAssets(yearFilter?: number): Promise<ExportProject[]> {
			const projects = await client.project.findMany({
				where: {
					OR: [
						{ assets: { some: { status: 'READY' } } },
						{ webglEntryKey: { not: '' } },
					],
					...(yearFilter ? { exhibition: { year: yearFilter } } : {}),
				},
				include: {
					exhibition: { select: { year: true, title: true } },
					members: {
						orderBy: { sortOrder: 'asc' },
						select: { name: true, studentId: true, sortOrder: true },
					},
					assets: {
						where: { status: 'READY' },
						orderBy: [{ kind: 'asc' }, { id: 'asc' }],
						select: {
							id: true,
							kind: true,
							storageKey: true,
							originalName: true,
							mimeType: true,
							sizeBytes: true,
						},
					},
				},
				orderBy: [
					{ exhibition: { year: 'asc' } },
					{ sortOrder: 'asc' },
					{ id: 'asc' },
				],
			});
			const currentDeployments = projects.flatMap((project) => {
				const parsed = parseWebglEntryKey(project.id, project.webglEntryKey);
				return parsed ? [{ projectId: project.id, deploymentId: parsed.deploymentId }] : [];
			});
			const sourceSessions = currentDeployments.length === 0
				? []
				: await client.gameUploadSession.findMany({
					where: {
						status: 'COMPLETED',
						uploadKind: 'WEBGL',
						storageKey: { not: null },
						OR: currentDeployments.map(({ projectId, deploymentId }) => ({
							projectId,
							webglDeploymentId: deploymentId,
						})),
					},
					select: { projectId: true, webglDeploymentId: true, storageKey: true },
				});
			const sourceByDeployment = new Map(sourceSessions.map((session) => [
				`${session.projectId}/${session.webglDeploymentId}`,
				session.storageKey!,
			]));
			return projects.map((project) => {
				const parsed = parseWebglEntryKey(project.id, project.webglEntryKey);
				return {
					...project,
					webglSourceKey: parsed
						? sourceByDeployment.get(`${project.id}/${parsed.deploymentId}`) ?? null
						: null,
				};
			});
		},
	};
}
