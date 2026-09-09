import { createHash } from 'node:crypto';
import type { ExportProgress, ExportResult } from '@pcu/contracts';
import { Prisma, type PrismaClient } from '../../../generated/prisma/client.js';
import { conflict } from '../../../shared/errors.js';
import type {
	ClaimedExportJob,
	ExportJobStatus,
	ExportProjectSnapshot,
	ExportSnapshot,
	ExportSnapshotObject,
} from './ports.js';

export class ExportSnapshotInvariantError extends Error {
	constructor(public readonly code: 'MISSING' | 'DUPLICATE' | 'MALFORMED', message: string) {
		super(message);
		this.name = 'ExportSnapshotInvariantError';
	}
}

function asSafeNumber(value: bigint, label: string): number {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 0) {
		throw new ExportSnapshotInvariantError('MALFORMED', `${label} has an invalid size`);
	}
	return number;
}

function snapshotHash(snapshot: ExportSnapshot): string {
	return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function initialProgress(year: number | null): ExportProgress {
	return {
		year,
		startedAt: 0,
		phase: 'preparing',
		totalProjects: 0,
		currentProjectIndex: 0,
		currentProjectTitle: null,
		currentProjectFiles: [],
		totalFiles: 0,
		downloaded: 0,
		skipped: 0,
		failed: 0,
	};
}

function canonicalObject(input: {
	assetId: number;
	kind: ExportSnapshotObject['kind'];
	originalName: string;
	role: ExportSnapshotObject['role'];
	representation: {
		id: string;
		bucket: string;
		objectKey: string;
		mimeType: string;
		sizeBytes: bigint;
		etag: string | null;
		updatedAt: Date;
	};
}): ExportSnapshotObject {
	return {
		id: input.representation.id,
		assetId: input.assetId,
		kind: input.kind,
		role: input.role,
		bucket: input.representation.bucket,
		objectKey: input.representation.objectKey,
		mimeType: input.representation.mimeType,
		sizeBytes: asSafeNumber(input.representation.sizeBytes, `representation ${input.representation.id}`),
		etag: input.representation.etag,
		representationUpdatedAt: input.representation.updatedAt.toISOString(),
		originalName: input.originalName,
		source: 'canonical',
	};
}

function assertUniqueOwnership(projects: ExportProjectSnapshot[]): void {
	const ownerByObject = new Map<string, string>();
	for (const project of projects) {
		for (const object of project.objects) {
			const physical = `${object.bucket}\0${object.objectKey}`;
			const owner = `${project.id}:${object.assetId}:${object.role}`;
			const previous = ownerByObject.get(physical);
			if (previous && previous !== owner) {
				throw new ExportSnapshotInvariantError(
					'DUPLICATE',
					`Object ${object.bucket}/${object.objectKey} has duplicate canonical ownership`,
				);
			}
			ownerByObject.set(physical, owner);
		}
	}
}

export function createExportRepository(
	client: PrismaClient,
	_buckets?: { publicBucket: string; protectedBucket: string },
) {
	return {
		async createJob(input: {
			id: string;
			requestedById: number;
			year: number | null;
			dryRun: boolean;
		}): Promise<{ id: string }> {
			try {
				return await client.exportJob.create({
					data: { ...input, progress: initialProgress(input.year) },
					select: { id: true },
				});
			} catch (error) {
				if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
					throw conflict('Export is already in progress');
				}
				throw error;
			}
		},

		async latestJob(): Promise<ExportJobStatus | null> {
			const job = await client.exportJob.findFirst({ orderBy: { createdAt: 'desc' } });
			return job ? {
				id: job.id,
				state: job.state,
				progress: job.progress as ExportProgress | null,
				result: job.result as ExportResult | null,
				error: job.error,
			} : null;
		},

		async claimNext(token: string, leaseMs: number): Promise<ClaimedExportJob | null> {
			const rows = await client.$queryRaw<Array<{
				id: string;
				year: number | null;
				dryRun: boolean;
				claimToken: string;
				attemptCount: number;
				maxAttempts: number;
				createdAt: Date;
				snapshot: ExportSnapshot | null;
				snapshotHash: string | null;
			}>>(Prisma.sql`
				WITH exhausted AS (
					UPDATE "export_jobs" SET "state" = 'FAILED',
						"error" = 'Export worker lease expired after the maximum attempts',
						"claim_token" = NULL, "claim_until" = NULL,
						"finished_at" = clock_timestamp(), "updated_at" = clock_timestamp()
					WHERE "state" = 'RUNNING' AND "claim_until" <= clock_timestamp()
						AND "attempt_count" >= "max_attempts"
					RETURNING "id"
				), candidate AS (
					SELECT "id" FROM "export_jobs"
					WHERE (
						("state" = 'QUEUED' AND "next_attempt_at" <= clock_timestamp())
						OR ("state" = 'RUNNING' AND "claim_until" <= clock_timestamp())
					) AND "attempt_count" < "max_attempts"
					ORDER BY "created_at"
					LIMIT 1 FOR UPDATE SKIP LOCKED
				)
				UPDATE "export_jobs" AS job
				SET "state" = 'RUNNING', "claim_token" = ${token},
					"claim_until" = clock_timestamp() + (${leaseMs} * INTERVAL '1 millisecond'),
					"attempt_count" = job."attempt_count" + 1,
					"started_at" = COALESCE(job."started_at", clock_timestamp()),
					"error" = NULL, "updated_at" = clock_timestamp()
				FROM candidate WHERE job."id" = candidate."id"
				RETURNING job."id", job."year", job."dry_run" AS "dryRun",
					job."claim_token" AS "claimToken", job."attempt_count" AS "attemptCount",
					job."max_attempts" AS "maxAttempts", job."created_at" AS "createdAt",
					job."snapshot", job."snapshot_hash" AS "snapshotHash"
			`);
			const row = rows[0];
			return row ? { ...row, createdAt: row.createdAt.toISOString() } : null;
		},

		async heartbeat(input: {
			id: string;
			token: string;
			leaseMs: number;
			progress: ExportProgress;
		}): Promise<boolean> {
			const updated = await client.$executeRaw(Prisma.sql`
				UPDATE "export_jobs" SET
					"claim_until" = clock_timestamp() + (${input.leaseMs} * INTERVAL '1 millisecond'),
					"progress" = ${JSON.stringify(input.progress)}::jsonb,
					"updated_at" = clock_timestamp()
				WHERE "id" = ${input.id} AND "state" = 'RUNNING'
					AND "claim_token" = ${input.token} AND "claim_until" > clock_timestamp()
			`);
			return updated === 1;
		},

		async loadOrCreateSnapshot(job: ClaimedExportJob): Promise<{
			snapshot: ExportSnapshot;
			hash: string;
		}> {
			if (job.snapshot && job.snapshotHash) {
				if (job.snapshot.projects.some((project) => project.objects.some(
					(object) => (object as { source: string }).source !== 'canonical',
				))) throw new ExportSnapshotInvariantError('MALFORMED', 'Persisted export snapshot contains a non-canonical object');
				return { snapshot: job.snapshot, hash: job.snapshotHash };
			}
			const rows = await client.project.findMany({
				where: {
					changeRequestDraft: null,
					OR: [
						{ assets: { some: { status: 'READY' } } },
						{ currentWebglDeploymentId: { not: null } },
					],
					...(job.year === null ? {} : { exhibition: { year: job.year } }),
				},
				orderBy: [{ exhibition: { year: 'asc' } }, { sortOrder: 'asc' }, { id: 'asc' }],
				include: {
					exhibition: { select: { year: true, title: true } },
					members: { orderBy: { sortOrder: 'asc' }, select: { name: true, studentId: true, sortOrder: true } },
					assets: {
						where: { status: 'READY', kind: { in: ['GAME', 'VIDEO', 'IMAGE', 'POSTER', 'THUMBNAIL'] } },
						orderBy: [{ kind: 'asc' }, { id: 'asc' }],
						include: { representations: true },
					},
					currentWebglDeployment: { include: { sourceRepresentation: { include: { asset: true } } } },
				},
			});

			const projects: ExportProjectSnapshot[] = [];
			for (const project of rows) {
				const objects: ExportSnapshotObject[] = [];
				for (const asset of project.assets) {
					const original = asset.representations.find((representation) => representation.role === 'ORIGINAL');
					if (!original || original.state !== 'READY') {
						throw new ExportSnapshotInvariantError('MISSING', `Asset ${asset.id} has no READY ORIGINAL representation`);
					}
					objects.push(canonicalObject({ assetId: asset.id, kind: asset.kind, originalName: asset.originalName, role: 'ORIGINAL', representation: original }));
					if (asset.kind === 'IMAGE' || asset.kind === 'POSTER' || asset.kind === 'THUMBNAIL') {
						for (const role of ['CARD_480', 'DISPLAY_960'] as const) {
							const rendition = asset.representations.find((representation) => representation.role === role);
							if (rendition?.state === 'READY') {
								objects.push(canonicalObject({ assetId: asset.id, kind: asset.kind, originalName: `${role.toLowerCase()}.webp`, role, representation: rendition }));
							}
						}
					}
				}

				if (project.currentWebglDeploymentId !== null) {
					const deployment = project.currentWebglDeployment;
					const representation = deployment?.sourceRepresentation;
					if (!deployment || deployment.id !== project.currentWebglDeploymentId
						|| deployment.state !== 'READY' || !representation
						|| representation.role !== 'WEBGL_SOURCE' || representation.state !== 'READY') {
						throw new ExportSnapshotInvariantError('MISSING', `Project ${project.id} has an unresolved current WebGL source`);
					}
					objects.push(canonicalObject({
						assetId: representation.assetId,
						kind: 'WEBGL',
						originalName: representation.asset.originalName || 'webgl.zip',
						role: 'WEBGL_SOURCE',
						representation,
					}));
				}
				projects.push({
					id: project.id,
					title: project.title,
					exhibition: project.exhibition,
					currentWebglDeploymentId: project.currentWebglDeploymentId,
					members: project.members,
					objects,
				});
			}
			assertUniqueOwnership(projects);
			const snapshot: ExportSnapshot = {
				version: 1,
				jobId: job.id,
				year: job.year,
				createdAt: job.createdAt,
				projects,
			};
			const hash = snapshotHash(snapshot);
			const updated = await client.$executeRaw(Prisma.sql`
				UPDATE "export_jobs" SET "snapshot" = ${JSON.stringify(snapshot)}::jsonb,
					"snapshot_hash" = ${hash}, "updated_at" = clock_timestamp()
				WHERE "id" = ${job.id} AND "state" = 'RUNNING'
					AND "claim_token" = ${job.claimToken} AND "claim_until" > clock_timestamp()
					AND "snapshot" IS NULL
			`);
			if (updated !== 1) throw new Error('Export snapshot claim was lost');
			return { snapshot, hash };
		},

		async snapshotStillCurrent(snapshot: ExportSnapshot): Promise<boolean> {
			const projectPointers = await client.project.findMany({
				where: { id: { in: snapshot.projects.map((project) => project.id) }, changeRequestDraft: null },
				select: { id: true, currentWebglDeploymentId: true },
			});
			const pointerByProject = new Map(projectPointers.map((project) => [project.id, project]));
			for (const project of snapshot.projects) {
				const current = pointerByProject.get(project.id);
				if (!current || current.currentWebglDeploymentId !== project.currentWebglDeploymentId) return false;
			}
			const canonical = snapshot.projects.flatMap((project) => project.objects);
			if (canonical.length > 0) {
				const rows = await client.assetRepresentation.findMany({
					where: { id: { in: canonical.map((object) => object.id) } },
				});
				const byId = new Map(rows.map((row) => [row.id, row]));
				for (const object of canonical) {
					const current = byId.get(object.id);
					if (!current || current.state !== 'READY' || current.bucket !== object.bucket
						|| current.objectKey !== object.objectKey
						|| current.updatedAt.toISOString() !== object.representationUpdatedAt
						|| asSafeNumber(current.sizeBytes, `representation ${current.id}`) !== object.sizeBytes) return false;
				}
			}
			return true;
		},

		async complete(input: {
			id: string;
			token: string;
			snapshotHash: string;
			result: ExportResult;
		}): Promise<boolean> {
			const updated = await client.$executeRaw(Prisma.sql`
				UPDATE "export_jobs" SET "state" = 'READY',
					"result" = ${JSON.stringify(input.result)}::jsonb,
					"claim_token" = NULL, "claim_until" = NULL,
					"finished_at" = clock_timestamp(), "updated_at" = clock_timestamp()
				WHERE "id" = ${input.id} AND "state" = 'RUNNING'
					AND "claim_token" = ${input.token} AND "claim_until" > clock_timestamp()
					AND "snapshot_hash" = ${input.snapshotHash}
			`);
			return updated === 1;
		},

		async retryOrFail(input: {
			id: string;
			token: string;
			attemptCount: number;
			maxAttempts: number;
			error: string;
			retryDelayMs: number;
		}): Promise<'QUEUED' | 'FAILED' | 'LOST'> {
			const terminal = input.attemptCount >= input.maxAttempts;
			const rows = await client.$queryRaw<Array<{ state: 'QUEUED' | 'FAILED' }>>(Prisma.sql`
				UPDATE "export_jobs" SET
					"state" = ${terminal ? 'FAILED' : 'QUEUED'}::"ExportJobState",
					"error" = ${input.error.slice(0, 2_000)},
					"claim_token" = NULL, "claim_until" = NULL,
					"next_attempt_at" = clock_timestamp() + (${input.retryDelayMs} * INTERVAL '1 millisecond'),
					"finished_at" = ${terminal ? Prisma.sql`clock_timestamp()` : Prisma.sql`NULL`},
					"updated_at" = clock_timestamp()
				WHERE "id" = ${input.id} AND "state" = 'RUNNING' AND "claim_token" = ${input.token}
					AND "claim_until" > clock_timestamp()
				RETURNING "state"
			`);
			return rows[0]?.state ?? 'LOST';
		},

		async failInvariant(input: { id: string; token: string; error: string }): Promise<boolean> {
			const updated = await client.$executeRaw(Prisma.sql`
				UPDATE "export_jobs" SET "state" = 'FAILED', "error" = ${input.error.slice(0, 2_000)},
					"claim_token" = NULL, "claim_until" = NULL,
					"finished_at" = clock_timestamp(), "updated_at" = clock_timestamp()
				WHERE "id" = ${input.id} AND "state" = 'RUNNING'
					AND "claim_token" = ${input.token} AND "claim_until" > clock_timestamp()
			`);
			return updated === 1;
		},
	};
}
