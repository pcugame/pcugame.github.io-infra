import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type { AwardRepository } from './ports.js';
import { notFound } from '../../shared/errors.js';
import { queueDurableDeletions } from '../orphan/outbox.js';
async function read(tx: Prisma.TransactionClient, id: number) {
 const e = await tx.exhibition.findUnique({ where: { id }, include: {
  projects: { where: { changeRequestDraft: null }, select: { id: true, title: true }, orderBy: { id: 'asc' } },
  awards: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], include: { recipients: true, asset: { include: { representations: true } } } },
  assets: { where: { kind: 'IMAGE', projectId: null, status: 'READY' }, include: { representations: true } },
 } });
 if (!e) throw notFound('Exhibition not found');
 return { candidates: e.projects, version: e.awardsVersion, items: e.awards, assets: e.assets };
}
export function createAwardRepository(client: PrismaClient): AwardRepository {
 return {
  read: id => client.$transaction(tx => read(tx, id), { isolationLevel: 'RepeatableRead' }),
  mutate: (id, projectIds, validate) => client.$transaction(async tx => {
   const sorted = [...new Set(projectIds)].sort((a,b) => a-b);
   if (sorted.length) await tx.$queryRaw(Prisma.sql`SELECT id FROM projects WHERE id IN (${Prisma.join(sorted)}) ORDER BY id FOR UPDATE`);
   const projects = await tx.project.findMany({ where: { id: { in: sorted } }, select: { id: true, exhibitionId: true, changeRequestDraft: { select: { id: true } } } });
   const exhibitionId = id ?? projects[0]?.exhibitionId;
   if (exhibitionId === undefined) throw notFound('Project not found');
   await tx.$queryRaw`SELECT id FROM exhibitions WHERE id = ${exhibitionId} FOR UPDATE`;
   const snapshot = await read(tx, exhibitionId);
   const change = validate({ ...snapshot, exhibitionId, projects: projects.map(p => ({ ...p, staging: p.changeRequestDraft !== null })) });
   if (change.kind === 'create') await tx.exhibitionAward.create({ data: { exhibitionId, name: change.name, builtinKey: change.builtinKey, assetId: change.assetId, sortOrder: snapshot.items.length ? Math.max(...snapshot.items.map(a => a.sortOrder)) + 1 : 0 } });
   if (change.kind === 'edit') await tx.exhibitionAward.update({ where: { id: change.awardId! }, data: { name: change.name, builtinKey: change.builtinKey, assetId: change.assetId } });
   if (change.kind === 'delete') await tx.exhibitionAward.delete({ where: { id: change.awardId } });
   if (change.kind === 'order') for (const [sortOrder, id] of change.awardIds.entries()) await tx.exhibitionAward.update({ where: { id }, data: { sortOrder } });
   if (change.kind === 'recipients') {
    await tx.projectAward.deleteMany({ where: { awardId: change.awardId, projectId: { in: change.removeProjectIds } } });
    await tx.projectAward.createMany({ data: change.addProjectIds.map(projectId => ({ exhibitionId, projectId, awardId: change.awardId })), skipDuplicates: true });
   }
   if (change.kind === 'project') {
    await tx.projectAward.deleteMany({ where: { projectId: change.projectId } });
    await tx.projectAward.createMany({ data: change.awardIds.map(awardId => ({ exhibitionId, projectId: change.projectId, awardId })) });
   }
   if (change.kind === 'asset-delete') {
    const asset = snapshot.assets.find(a => a.id === change.assetId)!;
    await queueDurableDeletions(tx, asset.representations.map(r => ({ bucket: r.bucket, storageKey: r.objectKey, reason: 'award-image-delete' })));
    await tx.asset.delete({ where: { id: asset.id } });
   }
   await tx.exhibition.update({ where: { id: exhibitionId }, data: { awardsVersion: { increment: 1 } } });
   return read(tx, exhibitionId);
  }),
 };
}
