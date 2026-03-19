import type { FastifyInstance } from 'fastify';
import { promises as fsp, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { sendOk, sendCreated } from '../../shared/http.js';
import { badRequest, notFound, conflict, forbidden, unauthorized } from '../../shared/errors.js';
import { requireLogin, requireRole } from '../../plugins/auth.js';
import { generateStorageKey, buildStoragePath } from '../../shared/storage-path.js';
import {
  detectFileType,
  isAllowedImageType,
  isAllowedGameType,
  SIZE_LIMITS,
} from '../../shared/file-signature.js';
import { toSlug } from '../../shared/slug.js';
import type { AssetKind } from '@prisma/client';

function assetUrl(storageKey: string, kind: AssetKind): string {
  const base = env().PUBLIC_BASE_URL;
  if (kind === 'GAME') return `${base}/api/assets/protected/${storageKey}`;
  return `${base}/api/assets/public/${storageKey}`;
}

interface SavedFile {
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
  kind: AssetKind;
}

async function saveFile(
  tmpPath: string,
  kind: AssetKind,
  originalName: string,
): Promise<SavedFile> {
  const cfg = env();

  const stat = await fsp.stat(tmpPath);
  const sizeBytes = stat.size;

  const limits: Record<string, number> = {
    GAME: SIZE_LIMITS.game,
    POSTER: SIZE_LIMITS.poster,
    THUMBNAIL: SIZE_LIMITS.poster,
    IMAGE: SIZE_LIMITS.image,
  };
  const limit = limits[kind] ?? SIZE_LIMITS.image;
  if (sizeBytes > limit) {
    throw badRequest(`File too large for kind ${kind}`);
  }

  // Read header for type detection
  const fd = await fsp.open(tmpPath, 'r');
  const headerBuf = Buffer.alloc(16);
  await fd.read(headerBuf, 0, 16, 0);
  await fd.close();

  const fileType = detectFileType(headerBuf);
  if (!fileType) throw badRequest('Unsupported file type');

  if (kind === 'GAME') {
    if (!isAllowedGameType(fileType)) throw badRequest('Game file must be a ZIP archive');
  } else {
    if (!isAllowedImageType(fileType)) throw badRequest('Images must be JPEG, PNG, or WebP');
  }

  const isPublic = kind !== 'GAME';
  const root = isPublic ? cfg.UPLOAD_ROOT_PUBLIC : cfg.UPLOAD_ROOT_PROTECTED;
  const storageKey = generateStorageKey(fileType.ext);
  const filePath = buildStoragePath(root, storageKey);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.rename(tmpPath, filePath);

  return { storageKey, mimeType: fileType.mime, sizeBytes, originalName, kind };
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ── Year ─────────────────────────────────────────────────

  // GET /api/admin/years
  app.get('/years', { preHandler: requireLogin }, async (_req, reply) => {
    const years = await prisma.year.findMany({
      orderBy: { year: 'desc' },
      include: { _count: { select: { projects: true } } },
    });
    const items = years.map((y) => ({
      id: y.id,
      year: y.year,
      title: y.title || undefined,
      isPublished: y.isOpen,
      sortOrder: 0,
      projectCount: y._count.projects,
    }));
    sendOk(reply, { items });
  });

  // POST /api/admin/years
  app.post<{ Body: { year?: number; title?: string; isPublished?: boolean } }>(
    '/years',
    { preHandler: requireRole('ADMIN', 'OPERATOR') },
    async (request, reply) => {
      const { year, title = '', isPublished = true } = request.body;
      if (!year || !Number.isInteger(year)) throw badRequest('year is required');

      const existing = await prisma.year.findUnique({ where: { year } });
      if (existing) throw conflict(`Year ${year} already exists`);

      const created = await prisma.year.create({ data: { year, title, isOpen: isPublished } });
      sendCreated(reply, { id: created.id, year: created.year });
    },
  );

  // PATCH /api/admin/years/:id
  app.patch<{
    Params: { id: string };
    Body: { title?: string; isPublished?: boolean };
  }>(
    '/years/:id',
    { preHandler: requireRole('ADMIN', 'OPERATOR') },
    async (request, reply) => {
      const year = await prisma.year.findUnique({ where: { id: request.params.id } });
      if (!year) throw notFound('Year not found');

      const { title, isPublished } = request.body;
      const updated = await prisma.year.update({
        where: { id: year.id },
        data: {
          ...(title !== undefined ? { title } : {}),
          ...(isPublished !== undefined ? { isOpen: isPublished } : {}),
        },
        include: { _count: { select: { projects: true } } },
      });
      sendOk(reply, {
        id: updated.id,
        year: updated.year,
        title: updated.title || undefined,
        isPublished: updated.isOpen,
        sortOrder: 0,
        projectCount: updated._count.projects,
      });
    },
  );

  // ── Project ──────────────────────────────────────────────

  // GET /api/admin/projects
  app.get('/projects', { preHandler: requireLogin }, async (request, reply) => {
    const user = request.currentUser!;
    const isPrivileged = user.role === 'ADMIN' || user.role === 'OPERATOR';
    const projects = await prisma.project.findMany({
      where: isPrivileged ? {} : { creatorId: user.id },
      orderBy: { createdAt: 'desc' },
      include: { year: true, creator: true },
    });
    const items = projects.map((p) => ({
      id: p.id,
      title: p.title,
      slug: p.slug,
      year: p.year.year,
      status: p.status,
      createdByUserName: p.creator.name || undefined,
      updatedAt: p.updatedAt.toISOString(),
    }));
    sendOk(reply, { items });
  });

  // GET /api/admin/projects/:id
  app.get<{ Params: { id: string } }>(
    '/projects/:id',
    { preHandler: requireLogin },
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        include: {
          year: true,
          members: { orderBy: { sortOrder: 'asc' } },
          assets: { where: { status: 'READY' }, orderBy: { createdAt: 'asc' } },
          poster: true,
        },
      });
      if (!project) throw notFound('Project not found');

      const user = request.currentUser!;
      if (
        user.role !== 'ADMIN' &&
        user.role !== 'OPERATOR' &&
        project.creatorId !== user.id
      ) {
        throw forbidden('Not your project');
      }

      sendOk(reply, {
        id: project.id,
        title: project.title,
        slug: project.slug,
        year: project.year.year,
        summary: project.summary || undefined,
        description: project.description || undefined,
        youtubeUrl: project.youtubeUrl || undefined,
        status: project.status,
        sortOrder: project.sortOrder,
        downloadPolicy: project.downloadPolicy,
        posterAssetId: project.posterAssetId ?? undefined,
        posterUrl: project.poster
          ? assetUrl(project.poster.storageKey, 'POSTER')
          : undefined,
        members: project.members.map((m) => ({
          id: m.id,
          name: m.name,
          studentId: m.studentId,
          sortOrder: m.sortOrder,
        })),
        assets: project.assets.map((a) => ({
          id: a.id,
          kind: a.kind,
          url: assetUrl(a.storageKey, a.kind),
          originalName: a.originalName,
          size: Number(a.sizeBytes),
        })),
      });
    },
  );

  // PATCH /api/admin/projects/:id
  app.patch<{
    Params: { id: string };
    Body: {
      title?: string;
      summary?: string;
      description?: string;
      youtubeUrl?: string | null;
      status?: string;
      sortOrder?: number;
      downloadPolicy?: string;
    };
  }>(
    '/projects/:id',
    { preHandler: requireLogin },
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
      });
      if (!project) throw notFound('Project not found');

      const user = request.currentUser!;
      if (user.role !== 'ADMIN' && user.role !== 'OPERATOR') {
        if (project.creatorId !== user.id) throw forbidden('Not project owner');
        if (project.status !== 'DRAFT') throw forbidden('Cannot edit non-draft project');
      }

      const { title, summary, description, youtubeUrl, status, sortOrder, downloadPolicy } =
        request.body;

      const updated = await prisma.project.update({
        where: { id: project.id },
        data: {
          ...(title !== undefined ? { title } : {}),
          ...(summary !== undefined ? { summary } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(youtubeUrl !== undefined ? { youtubeUrl: youtubeUrl ?? '' } : {}),
          ...(status !== undefined ? { status: status as never } : {}),
          ...(sortOrder !== undefined ? { sortOrder } : {}),
          ...(downloadPolicy !== undefined ? { downloadPolicy: downloadPolicy as never } : {}),
        },
        include: {
          year: true,
          members: { orderBy: { sortOrder: 'asc' } },
          assets: { where: { status: 'READY' } },
          poster: true,
        },
      });

      sendOk(reply, {
        id: updated.id,
        title: updated.title,
        slug: updated.slug,
        year: updated.year.year,
        summary: updated.summary || undefined,
        description: updated.description || undefined,
        youtubeUrl: updated.youtubeUrl || undefined,
        status: updated.status,
        sortOrder: updated.sortOrder,
        downloadPolicy: updated.downloadPolicy,
        posterAssetId: updated.posterAssetId ?? undefined,
        posterUrl: updated.poster
          ? assetUrl(updated.poster.storageKey, 'POSTER')
          : undefined,
        members: updated.members.map((m) => ({
          id: m.id,
          name: m.name,
          studentId: m.studentId,
          sortOrder: m.sortOrder,
        })),
        assets: updated.assets.map((a) => ({
          id: a.id,
          kind: a.kind,
          url: assetUrl(a.storageKey, a.kind),
          originalName: a.originalName,
          size: Number(a.sizeBytes),
        })),
      });
    },
  );

  // DELETE /api/admin/projects/:id
  app.delete<{ Params: { id: string } }>(
    '/projects/:id',
    { preHandler: requireLogin },
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        include: { assets: true },
      });
      if (!project) throw notFound('Project not found');

      const user = request.currentUser!;
      if (user.role !== 'ADMIN' && user.role !== 'OPERATOR') {
        if (project.creatorId !== user.id) throw forbidden('Not project owner');
        if (project.status !== 'DRAFT') throw forbidden('Cannot delete non-draft project');
      }

      const cfg = env();
      for (const asset of project.assets) {
        const root =
          asset.kind === 'GAME' ? cfg.UPLOAD_ROOT_PROTECTED : cfg.UPLOAD_ROOT_PUBLIC;
        const filePath = buildStoragePath(root, asset.storageKey);
        await fsp.unlink(filePath).catch(() => {});
      }

      await prisma.project.delete({ where: { id: project.id } });
      reply.status(204).send();
    },
  );

  // POST /api/admin/projects/submit (multipart)
  app.post('/projects/submit', { preHandler: requireLogin }, async (request, reply) => {
    const cfg = env();
    const tmpFiles: string[] = [];

    try {
      const parts = request.parts();

      let payloadJson = '';
      interface FilePart {
        tmpPath: string;
        fieldname: string;
        filename: string;
        mimetype: string;
      }
      const fileParts: FilePart[] = [];

      for await (const part of parts) {
        if (part.type === 'field') {
          if (part.fieldname === 'payload') payloadJson = part.value as string;
        } else {
          const tmpPath = path.join(os.tmpdir(), crypto.randomUUID());
          tmpFiles.push(tmpPath);
          await pipeline(part.file, createWriteStream(tmpPath));
          fileParts.push({
            tmpPath,
            fieldname: part.fieldname,
            filename: part.filename ?? '',
            mimetype: part.mimetype,
          });
        }
      }

      if (!payloadJson) throw badRequest('Missing payload field');

      interface SubmitPayload {
        year: number;
        title: string;
        summary?: string;
        description?: string;
        youtubeUrl?: string;
        autoPublish?: boolean;
        members: { name: string; studentId: string; sortOrder?: number }[];
      }
      let payload: SubmitPayload;
      try {
        payload = JSON.parse(payloadJson) as SubmitPayload;
      } catch {
        throw badRequest('Invalid payload JSON');
      }

      const {
        year: yearNum,
        title,
        summary = '',
        description = '',
        youtubeUrl = '',
        autoPublish = false,
        members,
      } = payload;

      if (!yearNum || !title) throw badRequest('year and title are required');
      if (!members || members.length === 0) throw badRequest('At least one member required');

      // Find or create year
      let year = await prisma.year.findUnique({ where: { year: yearNum } });
      if (!year) {
        year = await prisma.year.create({ data: { year: yearNum, isOpen: true } });
      }

      // Generate unique slug
      const baseSlug = toSlug(title);
      let slug = baseSlug;
      let attempt = 0;
      while (
        await prisma.project.findUnique({
          where: { project_year_slug: { yearId: year.id, slug } },
        })
      ) {
        attempt++;
        slug = `${baseSlug}-${attempt}`;
      }

      // Save files
      const savedFiles: SavedFile[] = [];
      for (const fp of fileParts) {
        let kind: AssetKind;
        if (fp.fieldname === 'poster') kind = 'POSTER';
        else if (fp.fieldname === 'images[]') kind = 'IMAGE';
        else if (fp.fieldname === 'gameFile') kind = 'GAME';
        else continue;

        const saved = await saveFile(fp.tmpPath, kind, fp.filename);
        savedFiles.push(saved);
        tmpFiles.splice(tmpFiles.indexOf(fp.tmpPath), 1);
      }

      const status = autoPublish ? 'PUBLISHED' : 'DRAFT';

      // Create project + assets in transaction
      const project = await prisma.$transaction(async (tx) => {
        const p = await tx.project.create({
          data: {
            yearId: year.id,
            slug,
            title,
            summary,
            description,
            youtubeUrl,
            status,
            creatorId: request.currentUser!.id,
            members: {
              create: members.map((m, i) => ({
                name: m.name,
                studentId: m.studentId,
                sortOrder: m.sortOrder ?? i,
              })),
            },
          },
        });

        let posterAssetId: string | null = null;
        for (const sf of savedFiles) {
          const asset = await tx.asset.create({
            data: {
              projectId: p.id,
              kind: sf.kind,
              storageKey: sf.storageKey,
              originalName: sf.originalName,
              mimeType: sf.mimeType,
              sizeBytes: BigInt(sf.sizeBytes),
              isPublic: sf.kind !== 'GAME',
            },
          });
          if (sf.kind === 'POSTER' && !posterAssetId) posterAssetId = asset.id;
        }

        if (posterAssetId) {
          await tx.project.update({ where: { id: p.id }, data: { posterAssetId } });
        }

        return p;
      });

      const adminEditUrl = `${cfg.PUBLIC_BASE_URL}/admin/projects/${project.id}/edit`;
      const publicUrl =
        status === 'PUBLISHED' ? `${cfg.PUBLIC_BASE_URL}/${yearNum}/${slug}` : undefined;

      sendCreated(reply, {
        id: project.id,
        slug: project.slug,
        year: yearNum,
        status,
        adminEditUrl,
        publicUrl,
      });
    } finally {
      for (const t of tmpFiles) {
        await fsp.unlink(t).catch(() => {});
      }
    }
  });

  // POST /api/admin/projects/:id/assets (multipart, add one asset)
  app.post<{ Params: { id: string } }>(
    '/projects/:id/assets',
    { preHandler: requireLogin },
    async (request, reply) => {
      const project = await prisma.project.findUnique({ where: { id: request.params.id } });
      if (!project) throw notFound('Project not found');

      const user = request.currentUser!;
      if (user.role !== 'ADMIN' && user.role !== 'OPERATOR') {
        if (project.creatorId !== user.id) throw forbidden('Not project owner');
        if (project.status !== 'DRAFT') throw forbidden('Cannot edit non-draft project');
      }

      const tmpFiles: string[] = [];
      let kind: AssetKind = 'IMAGE';
      let savedFile: SavedFile | null = null;

      try {
        const parts = request.parts();
        for await (const part of parts) {
          if (part.type === 'field' && part.fieldname === 'kind') {
            kind = part.value as AssetKind;
          } else if (part.type === 'file' && part.fieldname === 'file') {
            const tmpPath = path.join(os.tmpdir(), crypto.randomUUID());
            tmpFiles.push(tmpPath);
            await pipeline(part.file, createWriteStream(tmpPath));
            savedFile = await saveFile(tmpPath, kind, part.filename ?? '');
            tmpFiles.splice(tmpFiles.indexOf(tmpPath), 1);
          }
        }

        if (!savedFile) throw badRequest('No file provided');

        const asset = await prisma.asset.create({
          data: {
            projectId: project.id,
            kind: savedFile.kind,
            storageKey: savedFile.storageKey,
            originalName: savedFile.originalName,
            mimeType: savedFile.mimeType,
            sizeBytes: BigInt(savedFile.sizeBytes),
            isPublic: savedFile.kind !== 'GAME',
          },
        });

        sendCreated(reply, {
          assetId: asset.id,
          url: assetUrl(savedFile.storageKey, savedFile.kind),
        });
      } finally {
        for (const t of tmpFiles) {
          await fsp.unlink(t).catch(() => {});
        }
      }
    },
  );

  // PATCH /api/admin/projects/:id/poster
  app.patch<{ Params: { id: string }; Body: { assetId: string } }>(
    '/projects/:id/poster',
    { preHandler: requireLogin },
    async (request, reply) => {
      const project = await prisma.project.findUnique({ where: { id: request.params.id } });
      if (!project) throw notFound('Project not found');

      const user = request.currentUser!;
      if (user.role !== 'ADMIN' && user.role !== 'OPERATOR') {
        if (project.creatorId !== user.id) throw forbidden('Not project owner');
      }

      const { assetId } = request.body;
      const asset = await prisma.asset.findFirst({
        where: { id: assetId, projectId: project.id },
      });
      if (!asset) throw notFound('Asset not found');

      await prisma.project.update({ where: { id: project.id }, data: { posterAssetId: assetId } });
      sendOk(reply, { posterAssetId: assetId });
    },
  );

  // POST /api/admin/projects/:id/members
  app.post<{
    Params: { id: string };
    Body: { name: string; studentId: string; sortOrder?: number };
  }>(
    '/projects/:id/members',
    { preHandler: requireLogin },
    async (request, reply) => {
      const project = await prisma.project.findUnique({ where: { id: request.params.id } });
      if (!project) throw notFound('Project not found');

      const user = request.currentUser!;
      if (user.role !== 'ADMIN' && user.role !== 'OPERATOR') {
        if (project.creatorId !== user.id) throw forbidden('Not project owner');
        if (project.status !== 'DRAFT') throw forbidden('Cannot edit non-draft project');
      }

      const { name, studentId, sortOrder = 0 } = request.body;
      if (!name || !studentId) throw badRequest('name and studentId required');

      const member = await prisma.projectMember.create({
        data: { projectId: project.id, name, studentId, sortOrder },
      });
      sendCreated(reply, { id: member.id });
    },
  );

  // PATCH /api/admin/projects/:id/members/:memberId
  app.patch<{
    Params: { id: string; memberId: string };
    Body: { name?: string; studentId?: string; sortOrder?: number };
  }>(
    '/projects/:id/members/:memberId',
    { preHandler: requireLogin },
    async (request, reply) => {
      const project = await prisma.project.findUnique({ where: { id: request.params.id } });
      if (!project) throw notFound('Project not found');

      const user = request.currentUser!;
      if (user.role !== 'ADMIN' && user.role !== 'OPERATOR') {
        if (project.creatorId !== user.id) throw forbidden('Not project owner');
        if (project.status !== 'DRAFT') throw forbidden('Cannot edit non-draft project');
      }

      const member = await prisma.projectMember.findFirst({
        where: { id: request.params.memberId, projectId: project.id },
      });
      if (!member) throw notFound('Member not found');

      const { name, studentId, sortOrder } = request.body;
      await prisma.projectMember.update({
        where: { id: member.id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(studentId !== undefined ? { studentId } : {}),
          ...(sortOrder !== undefined ? { sortOrder } : {}),
        },
      });
      reply.status(204).send();
    },
  );

  // DELETE /api/admin/projects/:id/members/:memberId
  app.delete<{ Params: { id: string; memberId: string } }>(
    '/projects/:id/members/:memberId',
    { preHandler: requireLogin },
    async (request, reply) => {
      const project = await prisma.project.findUnique({ where: { id: request.params.id } });
      if (!project) throw notFound('Project not found');

      const user = request.currentUser!;
      if (user.role !== 'ADMIN' && user.role !== 'OPERATOR') {
        if (project.creatorId !== user.id) throw forbidden('Not project owner');
        if (project.status !== 'DRAFT') throw forbidden('Cannot edit non-draft project');
      }

      const member = await prisma.projectMember.findFirst({
        where: { id: request.params.memberId, projectId: project.id },
      });
      if (!member) throw notFound('Member not found');

      await prisma.projectMember.delete({ where: { id: member.id } });
      reply.status(204).send();
    },
  );
}

// Suppress unused import warning
void unauthorized;
