import type { PrismaClient } from '../../generated/prisma/client.js';
import { z } from 'zod';
export const PublicationTransitionManifest = z.array(z.object({
 id: z.union([z.literal(214), z.literal(215)]), version: z.number().int().positive(), updatedAt: z.string().datetime(),
 publicationStatus: z.enum(['PUBLIC', 'PRIVATE']), title: z.string(),
}).strict()).max(2);
export function createPublicationTransitionRepository(db: PrismaClient) {
 return {
  async preview() {
   const rows = await db.project.findMany({ where: { id: { in: [214, 215] } }, include: { _count: { select: { assets: true, webglDeployments: true, assetUploads: true } } } });
   return { candidates: rows.filter(p => p._count.assets === 0 && p._count.webglDeployments === 0 && p._count.assetUploads === 0).map(p => ({ id: p.id, version: p.version, updatedAt: p.updatedAt.toISOString(), publicationStatus: p.publicationStatus, title: p.title })), inspected: rows.map(p => ({ id: p.id, files: p._count })) };
  },
  async apply(input: unknown) {
   const manifest = PublicationTransitionManifest.parse(input);
   return db.$transaction(async tx => {
    const results: { id: number; result: string }[] = [];
    for (const expected of [...manifest].sort((a, b) => a.id - b.id)) {
     await tx.$queryRaw`SELECT id FROM projects WHERE id = ${expected.id} FOR UPDATE`;
     const row = await tx.project.findUnique({ where: { id: expected.id }, include: { _count: { select: { assets: true, webglDeployments: true, assetUploads: true } } } });
     const auditId = `empty-project-${expected.id}-${expected.version}`;
     if (await tx.publicationException.findUnique({ where: { id: auditId } })) { results.push({ id: expected.id, result: 'already-applied' }); continue; }
     if (!row || row.version !== expected.version || row.updatedAt.toISOString() !== expected.updatedAt || row.publicationStatus !== expected.publicationStatus || row.title !== expected.title || Object.values(row._count).some(count => count !== 0)) { results.push({ id: expected.id, result: 'changed-skipped' }); continue; }
     await tx.project.update({ where: { id: row.id }, data: { publicationStatus: 'PRIVATE', publicationRequested: false, legacyPublication: false, version: { increment: 1 } } });
     await tx.publicationException.create({ data: { id: auditId, projectId: row.id, reason: 'Reviewed empty project transition', kind: 'EMPTY_PROJECT_TRANSITION', projectVersion: row.version + 1, waivedItems: [] } });
     results.push({ id: row.id, result: 'private' });
    }
    return results;
   });
  },
 };
}
