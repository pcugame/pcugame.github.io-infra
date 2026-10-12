import type { PrismaClient } from '../../generated/prisma/client.js';
import { notFound } from '../../shared/errors.js';
import { queueDurableDeletions } from '../orphan/outbox.js';
import type { AssetDeletionUnitOfWork, AssetDeletionSnapshot } from './ports.js';
import { getProjectVideos, rewriteProjectVideoOrder } from './video-order.repository.js';
import { withAssetMutationTransaction, ASSET_MUTATION_TRANSACTION_POLICY, type AssetMutationTransactionPolicy } from './mutation-transaction.js';

export function createAssetDeletionUnitOfWork(
 client: PrismaClient,
 policy: AssetMutationTransactionPolicy = ASSET_MUTATION_TRANSACTION_POLICY,
): AssetDeletionUnitOfWork {
 return {
  run: (assetId, actor, operation) => withAssetMutationTransaction(client, async tx => {
   const candidate = await tx.asset.findUnique({ where: { id: assetId }, select: { projectId: true } });
   if (!candidate || candidate.projectId === null) throw notFound('Asset not found');
   await tx.$queryRaw`SELECT id FROM projects WHERE id = ${candidate.projectId} FOR UPDATE`;
   const project = await tx.project.findUnique({
    where: { id: candidate.projectId },
    select: { id: true, creatorId: true, exhibitionId: true, status: true, posterAssetId: true, version: true, changeRequestDraft: { select: { id: true } } },
   });
   if (!project) throw notFound('Project not found');
   await tx.$queryRaw`SELECT id FROM exhibitions WHERE id = ${project.exhibitionId} FOR UPDATE`;
   const exhibition = await tx.exhibition.findUniqueOrThrow({ where: { id: project.exhibitionId }, select: { isModificationEnabled: true } });
   const members = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM project_members WHERE project_id = ${project.id} AND user_id = ${actor.id} FOR SHARE`;
   await tx.$queryRaw`SELECT id FROM assets WHERE id = ${assetId} FOR UPDATE`;
   await tx.$queryRaw`SELECT id FROM asset_representations WHERE asset_id = ${assetId} ORDER BY id FOR UPDATE`;
   const asset = await tx.asset.findUnique({ where: { id: assetId }, select: { id: true, projectId: true, kind: true, status: true, representations: { select: { role: true, bucket: true, objectKey: true } } } });
   if (!asset || asset.projectId !== project.id) throw notFound('Asset not found');
   const submission = await tx.projectSubmission.findUnique({ where: { projectId: project.id }, select: { state: true } });
   const snapshot: AssetDeletionSnapshot = {
    ...asset, projectId: project.id,
    project: { id: project.id, exhibitionId: project.exhibitionId, creatorId: project.creatorId, status: project.status, posterAssetId: project.posterAssetId, version: project.version,
     isModificationEnabled: exhibition.isModificationEnabled, isChangeRequestDraft: project.changeRequestDraft !== null, isMember: members.length > 0 },
    submissionState: submission?.state ?? null,
    videos: await getProjectVideos(tx, project.id),
   };
   return operation({ snapshot, async applyDeletion(plan) {
    await tx.asset.update({ where: { id: assetId }, data: { status: 'DELETED' } });
    if (plan.incrementVersion || plan.clearPoster) await tx.project.update({ where: { id: project.id }, data: {
     ...(plan.incrementVersion ? { version: { increment: 1 } } : {}),
     ...(plan.clearPoster ? { posterAssetId: null } : {}),
    } });
    if (plan.videoIds) await rewriteProjectVideoOrder(tx, project.id, plan.videoIds);
    await queueDurableDeletions(tx, snapshot.representations.map(rep => ({
     bucket: rep.bucket, storageKey: rep.objectKey, reason: `${plan.reason}-representation-${rep.role.toLowerCase()}`,
    })));
   } });
  }, policy),
 };
}
