import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { queueDurableDeletions } from '../orphan/outbox.js';
import type { ClaimedProjectPublicationJob, ProjectPublicationRepository } from './ports.js';
import {
	createProjectPublicationPlan,
	parseProjectPublicationPlan,
	publicationCleanupTargets,
	type ProjectPublicationPlan,
} from './plan.js';

function safeError(error: string): string { return error.slice(0, 2_000); }

function planFingerprint(plan: ProjectPublicationPlan): string {
	const normalized = {
		...plan,
		objects: [...plan.objects].sort((left, right) => (
			`${left.targetBucket}\0${left.targetObjectKey}`.localeCompare(`${right.targetBucket}\0${right.targetObjectKey}`)
		)),
		representations: [...plan.representations].sort((left, right) => left.id.localeCompare(right.id)),
		webglDeployments: [...plan.webglDeployments].sort((left, right) => left.id.localeCompare(right.id)),
	};
	const stable = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(stable);
		if (value && typeof value === 'object') {
			return Object.fromEntries(Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, nested]) => [key, stable(nested)]));
		}
		return value;
	};
	return JSON.stringify(stable(normalized));
}

async function rebuildProjectPublicationPlan(
	tx: Prisma.TransactionClient,
	input: { projectId: number; submissionId: string },
): Promise<ProjectPublicationPlan> {
	const [protectedBucket, publicBucket, items] = await Promise.all([
		tx.storageBucket.findUnique({ where: { visibility: 'PROTECTED' } }),
		tx.storageBucket.findUnique({ where: { visibility: 'PUBLIC' } }),
		tx.projectSubmissionItem.findMany({
			where: { submissionId: input.submissionId },
			orderBy: { id: 'asc' },
			include: {
				uploadSession: true,
				resultAsset: { include: { representations: { orderBy: { id: 'asc' } } } },
				resultRepresentation: true,
				resultWebglDeployment: true,
			},
		}),
	]);
	if (!protectedBucket || !publicBucket) throw new Error('canonical storage bucket registry is incomplete');
	const representations: Parameters<typeof createProjectPublicationPlan>[0]['representations'] = [];
	const webglDeployments: Parameters<typeof createProjectPublicationPlan>[0]['webglDeployments'] = [];
	for (const item of items) {
		const session = item.uploadSession;
		const asset = item.resultAsset;
		const source = item.resultRepresentation;
		if (!item.required || item.state !== 'READY' || !session || session.state !== 'READY'
			|| item.boundGeneration === null || session.generation !== item.boundGeneration
			|| session.resultAssetId !== item.resultAssetId
			|| session.resultRepresentationId !== item.resultRepresentationId
			|| !asset || asset.id !== item.resultAssetId || asset.projectId !== input.projectId
			|| asset.exhibitionId !== null || asset.kind !== item.kind || asset.status !== 'READY'
			|| !source || source.id !== item.resultRepresentationId || source.assetId !== asset.id
			|| source.state !== 'READY'
			|| source.role !== (item.kind === 'WEBGL' ? 'WEBGL_SOURCE' : 'ORIGINAL')
			|| source.sourceIdentityAlgorithm !== session.sourceIdentityAlgorithm
			|| source.sourceIdentity !== session.sourceIdentity) {
			throw new Error(`submission item ${item.id} lost its asset, generation, or source ownership fence`);
		}
		if (item.kind === 'IMAGE' || item.kind === 'POSTER') {
			const publicationRoles = new Set(['ORIGINAL', 'CARD_480', 'DISPLAY_960']);
			const imageRepresentations = asset.representations.filter((representation) => publicationRoles.has(representation.role));
			if (imageRepresentations.length !== 3 || new Set(imageRepresentations.map(({ role }) => role)).size !== 3) {
				throw new Error(`submission item ${item.id} lost an image publication role`);
			}
			for (const representation of imageRepresentations) {
				if (!['ORIGINAL', 'CARD_480', 'DISPLAY_960'].includes(representation.role)
					|| representation.state !== 'READY'
					|| representation.sourceIdentityAlgorithm !== session.sourceIdentityAlgorithm
					|| representation.sourceIdentity !== session.sourceIdentity) {
					throw new Error(`submission item ${item.id} image role lost its source fence`);
				}
				representations.push({
					...representation,
					role: representation.role as 'ORIGINAL' | 'CARD_480' | 'DISPLAY_960',
					generation: session.generation,
				});
			}
		}
		if (item.kind === 'WEBGL') {
			const deployment = item.resultWebglDeployment;
			if (!deployment || deployment.id !== item.resultWebglDeploymentId
				|| deployment.projectId !== input.projectId
				|| deployment.sourceRepresentationId !== source.id || deployment.state !== 'READY') {
				throw new Error(`submission item ${item.id} lost its WebGL deployment fence`);
			}
			webglDeployments.push(deployment);
		}
	}
	return createProjectPublicationPlan({
		projectId: input.projectId,
		submissionId: input.submissionId,
		protectedBucket: protectedBucket.bucket,
		publicBucket: publicBucket.bucket,
		representations,
		webglDeployments,
	});
}

export function createProjectPublicationRepository(client: PrismaClient): ProjectPublicationRepository {
	return {
		async claim({ token, leaseMs }) {
			const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				WITH candidate AS (
					SELECT job."id"
					FROM "project_publication_jobs" job
					JOIN "project_submissions" submission
						ON submission."id" = job."submission_id" AND submission."project_id" = job."project_id"
					JOIN "projects" project ON project."id" = job."project_id"
					WHERE job."state" IN ('PENDING', 'PROCESSING')
						AND (job."claim_until" IS NULL OR job."claim_until" <= clock_timestamp())
						AND submission."state" = 'FINALIZING'::"ProjectSubmissionState"
						AND project."status" = 'DRAFT'::"ProjectStatus"
					ORDER BY job."created_at"
					LIMIT 1 FOR UPDATE OF job SKIP LOCKED
				)
				UPDATE "project_publication_jobs" job
				SET "state" = 'PROCESSING'::"ProjectPublicationJobState",
					"claim_token" = ${token},
					"claim_until" = clock_timestamp() + (${leaseMs} * INTERVAL '1 millisecond'),
					"attempt_count" = "attempt_count" + 1,
					"updated_at" = clock_timestamp()
				FROM candidate WHERE job."id" = candidate."id" RETURNING job."id"
			`);
			if (rows.length === 0) return null;
			const job = await client.projectPublicationJob.findUniqueOrThrow({ where: { id: rows[0]!.id } });
			return {
				id: job.id,
				projectId: job.projectId,
				submissionId: job.submissionId,
				attemptCount: job.attemptCount,
				plan: job.plan,
			};
		},

		async validatePlan(job, token) {
			return client.$transaction(async (tx) => {
				await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "projects" WHERE "id" = ${job.projectId} FOR UPDATE`);
				await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "project_submissions" WHERE "id" = ${job.submissionId} FOR UPDATE`);
				await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "project_publication_jobs" WHERE "id" = ${job.id} FOR UPDATE`);
				const current = await tx.projectPublicationJob.findUniqueOrThrow({
					where: { id: job.id }, include: { project: true, submission: true },
				});
				if (current.state === 'CANCELLED' || current.submission.state === 'CANCELLED') return { status: 'CANCELLED' as const };
				if (current.state !== 'PROCESSING' || current.claimToken !== token
					|| !current.claimUntil || current.claimUntil <= new Date()
					|| current.projectId !== job.projectId || current.submissionId !== job.submissionId
					|| current.submission.projectId !== current.projectId
					|| current.project.status !== 'DRAFT' || current.submission.state !== 'FINALIZING') {
					throw new Error('Project publication lease or aggregate fence was lost before plan validation');
				}
				let canonicalPlan: ProjectPublicationPlan | null = null;
				let invalidReason = 'publication plan does not match its canonical DB snapshot';
				try {
					canonicalPlan = await rebuildProjectPublicationPlan(tx, {
						projectId: current.projectId,
						submissionId: current.submissionId,
					});
				} catch (error) {
					invalidReason = error instanceof Error ? error.message : invalidReason;
				}
				try {
					if (!canonicalPlan) throw new Error(invalidReason);
					const persistedPlan = parseProjectPublicationPlan(current.plan);
					const claimedPlan = parseProjectPublicationPlan(job.plan);
					if (persistedPlan.projectId === current.projectId
						&& persistedPlan.submissionId === current.submissionId
						&& planFingerprint(persistedPlan) === planFingerprint(claimedPlan)
						&& planFingerprint(persistedPlan) === planFingerprint(canonicalPlan)) {
						return { status: 'VALID' as const, job: { ...job, plan: canonicalPlan } };
					}
					invalidReason = 'publication plan does not match its canonical DB snapshot';
				} catch (error) {
					invalidReason = error instanceof Error ? error.message : invalidReason;
				}
				if (canonicalPlan) {
					await queueDurableDeletions(tx, canonicalPlan.objects.map((object) => ({
						bucket: object.targetBucket,
						storageKey: object.targetObjectKey,
						reason: 'invalid-project-publication-plan-target',
					})));
				}
				const failed = await tx.projectPublicationJob.updateMany({
					where: { id: job.id, state: 'PROCESSING', claimToken: token, claimUntil: { gt: new Date() } },
					data: {
						state: 'FAILED', claimToken: null, claimUntil: null,
						lastError: safeError(`OPERATOR_REQUIRED: ${invalidReason}`),
					},
				});
				if (failed.count !== 1) throw new Error('Project publication lease was lost while rejecting an invalid plan');
				return { status: 'FAILED' as const, error: invalidReason };
			}, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
		},

		async renew(jobId, token, leaseMs) {
			const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "project_publication_jobs"
				SET "claim_until" = clock_timestamp() + (${leaseMs} * INTERVAL '1 millisecond'),
					"updated_at" = clock_timestamp()
				WHERE "id" = ${jobId} AND "state" = 'PROCESSING'::"ProjectPublicationJobState"
					AND "claim_token" = ${token} AND "claim_until" > clock_timestamp()
				RETURNING "id"
			`);
			return rows.length === 1;
		},

		async complete(job, token) {
			return client.$transaction(async (tx) => {
				await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "projects" WHERE "id" = ${job.projectId} FOR UPDATE`);
				await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "project_submissions" WHERE "id" = ${job.submissionId} FOR UPDATE`);
				await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "project_publication_jobs" WHERE "id" = ${job.id} FOR UPDATE`);
				const current = await tx.projectPublicationJob.findUniqueOrThrow({
					where: { id: job.id }, include: { project: true, submission: true },
				});
				const persistedPlan = parseProjectPublicationPlan(current.plan);
				if (current.projectId !== job.projectId || current.submissionId !== job.submissionId
					|| current.submission.projectId !== current.projectId
					|| persistedPlan.projectId !== current.projectId || persistedPlan.submissionId !== current.submissionId
					|| job.plan.projectId !== job.projectId || job.plan.submissionId !== job.submissionId
					|| planFingerprint(persistedPlan) !== planFingerprint(job.plan)) {
					throw new Error('Project publication job, submission, project, or plan identity changed');
				}
				if (current.state === 'COMPLETED' && current.project.status === 'PUBLISHED'
					&& current.submission.state === 'PUBLISHED') return 'COMPLETED' as const;
				if (current.state === 'CANCELLED' || current.submission.state === 'CANCELLED') {
					// Cancellation may have queued cleanup before this worker's last PUT
					// reached Garage. Re-enqueue the immutable targets after copying has
					// stopped so an already-consumed cleanup task cannot leave late bytes.
					await queueDurableDeletions(tx, publicationCleanupTargets(parseProjectPublicationPlan(current.plan)));
					return 'CANCELLED' as const;
				}
				if (current.state !== 'PROCESSING' || current.claimToken !== token
					|| !current.claimUntil || current.claimUntil <= new Date()
					|| current.project.status !== 'DRAFT' || current.submission.state !== 'FINALIZING') {
					throw new Error('Project publication lease or aggregate fence was lost');
				}
				const invalidItems = await tx.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
					SELECT count(*)::bigint AS "count"
					FROM "project_submission_items" item
					LEFT JOIN "asset_upload_sessions" session ON session."submission_item_id" = item."id"
					LEFT JOIN "assets" asset ON asset."id" = item."result_asset_id"
					LEFT JOIN "asset_representations" representation ON representation."id" = item."result_representation_id"
					LEFT JOIN "asset_representations" playback
						ON playback."asset_id" = asset."id" AND playback."role" = 'PLAYBACK'::"AssetRepresentationRole"
					WHERE item."submission_id" = ${job.submissionId}
						AND (item."state" <> 'READY'::"ProjectSubmissionItemState"
							OR session."state" <> 'READY'::"AssetUploadSessionState"
							OR session."generation" IS DISTINCT FROM item."bound_generation"
							OR session."result_asset_id" IS DISTINCT FROM item."result_asset_id"
							OR session."result_representation_id" IS DISTINCT FROM item."result_representation_id"
							OR asset."project_id" IS DISTINCT FROM ${job.projectId}
							OR asset."kind"::text IS DISTINCT FROM item."kind"::text
							OR asset."status" <> 'READY'::"AssetStatus"
							OR representation."asset_id" IS DISTINCT FROM asset."id"
							OR representation."state" <> 'READY'::"AssetRepresentationState"
							OR (item."kind" = 'VIDEO'::"AssetUploadKind" AND (
								playback."state"::text IS DISTINCT FROM item."playback_state"::text
								OR (item."playback_state" = 'FAILED'::"ProjectSubmissionPlaybackState"
									AND btrim(COALESCE(playback."error", '')) = '')
							)))
				`);
				if ((invalidItems[0]?.count ?? 0n) !== 0n) throw new Error('Publication item fence changed');

				for (const representation of job.plan.representations) {
					const sourceFence = await tx.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
						SELECT count(*)::bigint AS "count"
						FROM "project_submission_items" item
						JOIN "asset_upload_sessions" session ON session."submission_item_id" = item."id"
						JOIN "assets" asset ON asset."id" = item."result_asset_id"
						WHERE item."submission_id" = ${job.submissionId}
							AND item."result_asset_id" = ${representation.assetId}
							AND item."kind" IN ('IMAGE'::"AssetUploadKind", 'POSTER'::"AssetUploadKind")
							AND item."state" = 'READY'::"ProjectSubmissionItemState"
							AND item."bound_generation" = ${representation.generation}
							AND session."generation" = ${representation.generation}
							AND session."result_asset_id" = ${representation.assetId}
							AND session."source_identity_algorithm" = ${representation.sourceIdentityAlgorithm}
							AND session."source_identity" = ${representation.sourceIdentity}
							AND asset."project_id" = ${job.projectId}
					`);
					if (sourceFence[0]?.count !== 1n) throw new Error('Publication image role, source, or generation fence changed');
					const updated = await tx.assetRepresentation.updateMany({
						where: {
							id: representation.id,
							assetId: representation.assetId,
							role: representation.role,
							bucket: representation.sourceBucket,
							objectKey: representation.sourceObjectKey,
							publicationBucket: representation.targetBucket,
							publicationObjectKey: representation.targetObjectKey,
							sizeBytes: BigInt(representation.sizeBytes),
							checksumAlgorithm: 'SHA256', checksum: representation.checksumSha256,
							sourceIdentityAlgorithm: representation.sourceIdentityAlgorithm,
							sourceIdentity: representation.sourceIdentity,
							state: 'READY',
						},
						data: {
							bucket: representation.targetBucket,
							objectKey: representation.targetObjectKey,
							publicationBucket: null,
							publicationObjectKey: null,
						},
					});
					if (updated.count !== 1) throw new Error('Publication image role, source, or generation fence changed');
				}

				for (const deployment of job.plan.webglDeployments) {
					const updated = await tx.webglDeployment.updateMany({
						where: {
							id: deployment.id,
							projectId: job.projectId,
							state: 'READY',
							stagingBucket: deployment.stagingBucket,
							stagingPrefix: deployment.stagingPrefix,
							publicBucket: deployment.publicBucket,
							publicPrefix: deployment.publicPrefix,
						},
						data: {
							objectManifest: deployment.publicManifest as unknown as Prisma.InputJsonValue,
							stagingBucket: null, stagingPrefix: null,
							stagingEntryObjectKey: null, stagingObjectManifest: Prisma.DbNull,
						},
					});
					if (updated.count !== 1) throw new Error('Publication WebGL deployment fence changed');
					const pointer = await tx.project.updateMany({
						where: { id: job.projectId, status: 'DRAFT', currentWebglDeploymentId: null },
						data: { currentWebglDeploymentId: deployment.id },
					});
					if (pointer.count !== 1) throw new Error('Publication WebGL pointer fence changed');
				}

				await queueDurableDeletions(tx, publicationCleanupTargets(job.plan).filter((target) => {
					const isPublicTarget = job.plan.objects.some((object) => object.targetBucket === target.bucket
						&& object.targetObjectKey === target.storageKey);
					return !isPublicTarget;
				}));
				const project = await tx.project.updateMany({ where: { id: job.projectId, status: 'DRAFT' }, data: { status: 'PUBLISHED' } });
				if (project.count !== 1) throw new Error('Project publication CAS failed');
				const submission = await tx.projectSubmission.updateMany({
					where: { id: job.submissionId, state: 'FINALIZING' },
					data: { state: 'PUBLISHED', publishedAt: new Date() },
				});
				if (submission.count !== 1) throw new Error('Submission publication CAS failed');
				await tx.projectPublicationJob.update({
					where: { id: job.id },
					data: { state: 'COMPLETED', completedAt: new Date(), claimToken: null, claimUntil: null, lastError: null },
				});
				return 'COMPLETED' as const;
			}, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
		},

		async release(jobId, token, error, retryDelayMs) {
			const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "project_publication_jobs"
				SET "state" = 'PENDING'::"ProjectPublicationJobState", "claim_token" = NULL,
					"claim_until" = clock_timestamp() + (${retryDelayMs} * INTERVAL '1 millisecond'),
					"last_error" = ${safeError(error)}, "updated_at" = clock_timestamp()
				WHERE "id" = ${jobId} AND "state" = 'PROCESSING'::"ProjectPublicationJobState"
					AND "claim_token" = ${token} RETURNING "id"
			`);
			return rows.length === 1;
		},

		async fail(jobId, token, error) {
			const updated = await client.projectPublicationJob.updateMany({
				where: { id: jobId, state: 'PROCESSING', claimToken: token },
				data: { state: 'FAILED', claimToken: null, claimUntil: null, lastError: safeError(error) },
			});
			return updated.count === 1;
		},

		async queueCancelledCleanup(jobId) {
			await client.$transaction(async (tx) => {
				const job = await tx.projectPublicationJob.findUnique({ where: { id: jobId }, select: { state: true, plan: true } });
				if (!job || job.state !== 'CANCELLED') return;
				await queueDurableDeletions(tx, publicationCleanupTargets(parseProjectPublicationPlan(job.plan)));
			});
		},
	};
}
