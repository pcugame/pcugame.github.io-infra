import { BuildReviewSchema, BuildReviewSummarySchema, type BuildReview } from '@pcu/contracts';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { conflict, forbidden, notFound } from '../../shared/errors.js';
import { withAssetMutationTransaction } from '../assets/mutation-transaction.js';
import { queueDurableDeletions } from '../orphan/outbox.js';
import type { BuildReviewRepository, BuildReviewWorkerPort } from './ports.js';

const include = { session: true } as const;
type Row = Prisma.BuildReviewGetPayload<{ include: typeof include }>;
function metadata(row: Omit<Row, 'inspection'>) {
	return {
		...row,
		projectId: row.session.projectId,
		kind: row.session.kind,
		originalName: row.session.originalName,
		totalBytes: Number(row.session.totalBytes),
		decision: row.session.state === 'CANCELLED' && row.decision === 'PENDING' ? 'CANCELLED' : row.decision,
		createdAt: row.createdAt.toISOString(),
		decidedAt: row.decidedAt?.toISOString() ?? null,
	};
}
function project(row: Row): BuildReview {
	return BuildReviewSchema.parse({ ...metadata(row), inspection: row.inspection });
}
async function role(tx: Prisma.TransactionClient, actorId: number) {
	const actor = await tx.user.findUnique({ where: { id: actorId }, select: { role: true } });
	if (!actor || !['ADMIN', 'OPERATOR'].includes(actor.role)) throw forbidden();
	return actor.role;
}
export function createBuildReviewRepository(
	client: PrismaClient,
): BuildReviewRepository & BuildReviewWorkerPort {
	return {
		async list(actorId, projectId) {
			await role(client, actorId);
			return (
				await client.buildReview.findMany({
					where: {
						decision: 'PENDING',
						session: { state: 'AWAITING_REVIEW', ...(projectId ? { projectId } : {}) },
					},
					include,
					omit: { inspection: true },
					orderBy: { createdAt: 'asc' },
					take: 100,
				})
			).map((row) => BuildReviewSummarySchema.parse(metadata(row)));
		},
		async detail(actorId, id) {
			await role(client, actorId);
			const row = await client.buildReview.findUnique({ where: { id }, include });
			if (!row) throw notFound();
			return project(row);
		},
		async decide(actorId, id, run) {
			return withAssetMutationTransaction(client, async (tx) => {
				const found = await tx.buildReview.findUnique({ where: { id }, select: { sessionId: true } });
				if (!found) throw notFound();
				// All decisions/cancellation lock the source row before the review row.
				await tx.$queryRaw`SELECT id FROM asset_upload_sessions WHERE id = ${found.sessionId} FOR UPDATE`;
				await tx.$queryRaw`SELECT id FROM build_reviews WHERE id = ${id} FOR UPDATE`;
				await tx.$queryRaw`SELECT id FROM users WHERE id = ${actorId} FOR SHARE`;
				const currentRole = await role(tx, actorId);
				const row = await tx.buildReview.findUnique({ where: { id }, include });
				if (!row) throw notFound();
				return run(
					{
						review: project(row),
						state: row.session.state,
						currentRole,
						currentIdentity: row.session.sourceIdentity,
						currentGeneration: row.session.generation,
					},
					async (decision) => {
						const entryPath = decision.entryPath ?? project(row).inspection.entryPath;
						await tx.buildReview.update({
							where: { id },
							data: {
								decision: decision.decision,
								reason: decision.reason,
								entryPath,
								decidedBy: actorId,
								decidedAt: new Date(),
								version: { increment: 1 },
							},
						});
						const approved = decision.decision === 'APPROVED';
						await tx.assetUploadSession.update({
							where: { id: row.sessionId },
							data: {
								state: approved ? 'VERIFYING' : 'REJECTED',
								validationLeaseToken: null,
								validationLeaseUntil: null,
								validationAttemptCount: 0,
								validationError: approved ? null : decision.reason,
							},
						});
						if (!approved) {
							if (row.session.resultRepresentationId)
								await tx.assetRepresentation.update({
									where: { id: row.session.resultRepresentationId },
									data: { state: 'DELETED', error: decision.reason },
								});
							if (row.session.resultAssetId)
								await tx.asset.update({
									where: { id: row.session.resultAssetId },
									data: { status: 'DELETED' },
								});
							await queueDurableDeletions(tx, [
								{
									bucket: row.session.bucket,
									storageKey: row.session.objectKey,
									reason: 'build-review-rejected',
								},
							]);
						}
						return project(await tx.buildReview.findUniqueOrThrow({ where: { id }, include }));
					},
				);
			});
		},
		async awaitReview(input) {
			return client.$transaction(async (tx) => {
				const owned = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
     SELECT id FROM asset_upload_sessions WHERE id = ${input.sessionId} AND generation = ${input.generation}
     AND source_identity = ${input.sourceIdentity} AND state = 'VERIFYING'::"AssetUploadSessionState"
     AND validation_lease_token = ${input.token} AND validation_lease_until > clock_timestamp() FOR UPDATE`);
				if (!owned.length) return false;
				const existing = await tx.buildReview.findUnique({
					where: { sessionId_generation: { sessionId: input.sessionId, generation: input.generation } },
				});
				if (existing && existing.sourceIdentity !== input.sourceIdentity)
					throw conflict('Review source changed');
				if (existing?.decision === 'APPROVED')
					throw conflict('Approved source needs a new validation decision');
				if (!existing)
					await tx.buildReview.create({
						data: {
							sessionId: input.sessionId,
							generation: input.generation,
							sourceIdentity: input.sourceIdentity,
							validatorVersion: input.inspection.version,
							inspection: input.inspection as unknown as Prisma.InputJsonValue,
						},
					});
				const transitioned = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
     UPDATE asset_upload_sessions SET state = 'AWAITING_REVIEW'::"AssetUploadSessionState",
      validation_lease_token = NULL, validation_lease_until = NULL, validation_error = ${input.inspection.reasons.join('; ').slice(0, 2000)}, updated_at = clock_timestamp()
     WHERE id = ${input.sessionId} AND generation = ${input.generation} AND source_identity = ${input.sourceIdentity}
      AND state = 'VERIFYING'::"AssetUploadSessionState" AND validation_lease_token = ${input.token}
      AND validation_lease_until > clock_timestamp() RETURNING id`);
				if (transitioned.length !== 1) throw conflict('Review validation lease expired');
				return true;
			});
		},
		async approval(sessionId, generation, sourceIdentity) {
			const row = await client.buildReview.findUnique({
				where: { sessionId_generation: { sessionId, generation } },
			});
			return row?.decision === 'APPROVED' &&
				row.validatorVersion === 'build-package-v1' &&
				row.sourceIdentity === sourceIdentity
				? { sourceIdentity, generation, entryPath: row.entryPath }
				: null;
		},
	};
}
