import type { FastifyInstance } from 'fastify';
import { createReadStream, promises as fsp } from 'node:fs';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { notFound, forbidden } from '../../shared/errors.js';
import { buildStoragePath } from '../../shared/storage-path.js';
import { requireLogin } from '../../plugins/auth.js';
import { loadProjectWithAccess } from '../admin/project-access.js';

export async function assetsRoutes(app: FastifyInstance): Promise<void> {
  const cfg = env();

  // GET /api/assets/public/:storageKey
  app.get<{ Params: { storageKey: string } }>(
    '/assets/public/:storageKey',
    async (request, reply) => {
      const { storageKey } = request.params;

      const asset = await prisma.asset.findFirst({
        where: { storageKey, isPublic: true, status: 'READY' },
      });
      if (!asset) throw notFound('Asset not found');

      const filePath = buildStoragePath(cfg.UPLOAD_ROOT_PUBLIC, storageKey);
      try {
        await fsp.access(filePath);
      } catch {
        throw notFound('File not found');
      }

      reply.header('Content-Type', asset.mimeType);
      reply.header('Content-Length', asset.sizeBytes.toString());
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      return reply.send(createReadStream(filePath));
    },
  );

  // GET /api/assets/protected/:storageKey
  app.get<{ Params: { storageKey: string } }>(
    '/assets/protected/:storageKey',
    async (request, reply) => {
      const { storageKey } = request.params;

      const asset = await prisma.asset.findFirst({
        where: { storageKey, status: 'READY' },
        include: { project: true },
      });
      if (!asset) throw notFound('Asset not found');

      const policy = asset.project.downloadPolicy;
      if (policy === 'NONE') throw forbidden('Download not allowed');

      if (policy === 'ADMIN_ONLY') {
        const user = request.currentUser;
        if (!user) throw forbidden('Login required');
        if (user.role !== 'ADMIN' && user.role !== 'OPERATOR')
          throw forbidden('Insufficient permissions');
      } else if (policy === 'SCHOOL_ONLY') {
        if (!request.currentUser) throw forbidden('Login required');
      }

      const filePath = buildStoragePath(cfg.UPLOAD_ROOT_PROTECTED, storageKey);
      try {
        await fsp.access(filePath);
      } catch {
        throw notFound('File not found');
      }

      reply.header('Content-Type', asset.mimeType);
      reply.header('Content-Length', asset.sizeBytes.toString());
      reply.header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(asset.originalName)}"`,
      );
      return reply.send(createReadStream(filePath));
    },
  );

  // DELETE /api/admin/assets/:assetId
  app.delete<{ Params: { assetId: string } }>(
    '/admin/assets/:assetId',
    { preHandler: requireLogin },
    async (request, reply) => {
      const asset = await prisma.asset.findUnique({
        where: { id: request.params.assetId },
        include: { project: true },
      });
      if (!asset) throw notFound('Asset not found');

      // Reuse centralized write-access check
      await loadProjectWithAccess(request, asset.projectId, { requireDraft: true });

      await prisma.asset.update({ where: { id: asset.id }, data: { status: 'DELETING' } });

      const root =
        asset.kind === 'GAME' ? cfg.UPLOAD_ROOT_PROTECTED : cfg.UPLOAD_ROOT_PUBLIC;
      const filePath = buildStoragePath(root, asset.storageKey);
      await fsp.unlink(filePath).catch(() => {});

      if (asset.project.posterAssetId === asset.id) {
        await prisma.project
          .update({ where: { id: asset.projectId }, data: { posterAssetId: null } })
          .catch(() => {});
      }

      await prisma.asset.update({ where: { id: asset.id }, data: { status: 'DELETED' } });
      reply.status(204).send();
    },
  );
}
