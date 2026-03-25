import type { FastifyInstance } from 'fastify';
import { promises as fsp, createWriteStream } from 'node:fs';
import { pipeline as streamPipeline } from 'node:stream/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { sendOk, sendCreated } from '../../shared/http.js';
import { badRequest, notFound, conflict, forbidden, unauthorized } from '../../shared/errors.js';
import {
  parseBody,
  CreateYearBody,
  UpdateYearBody,
  UpdateProjectBody,
  SubmitProjectPayload,
  AddMemberBody,
  UpdateMemberBody,
  SetPosterBody,
  AssetKindEnum,
} from '../../shared/validation.js';
import { requireLogin, requireRole } from '../../plugins/auth.js';
import { buildStoragePath } from '../../shared/storage-path.js';
import { toSlug } from '../../shared/slug.js';
import type { AssetKind } from '@prisma/client';
import { UploadPipeline } from '../assets/upload/index.js';
import type { SavedFile } from '../assets/upload/index.js';

function assetUrl(storageKey: string, kind: AssetKind): string {
  const base = env().API_PUBLIC_URL;
  if (kind === 'GAME') return `${base}/api/assets/protected/${storageKey}`;
  return `${base}/api/assets/public/${storageKey}`;
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ── Year ─────────────────────────────────────────────────

  // GET /api/admin/years
  app.get('/years', { preHandler: requireLogin }, async (_req, reply) => {
    const years = await prisma.year.findMany({
      orderBy: [{ sortOrder: 'asc' }, { year: 'desc' }],
      include: { _count: { select: { projects: true } } },
    });
    const items = years.map((y) => ({
      id: y.id,
      year: y.year,
      title: y.title || undefined,
      isOpen: y.isOpen,
      sortOrder: y.sortOrder,
      projectCount: y._count.projects,
    }));
    sendOk(reply, { items });
  });

  // POST /api/admin/years
  app.post(
    '/years',
    { preHandler: requireRole('ADMIN', 'OPERATOR') },
    async (request, reply) => {
      const { year, title, isOpen, sortOrder } = parseBody(CreateYearBody, request.body);

      const existing = await prisma.year.findUnique({ where: { year } });
      if (existing) throw conflict(`Year ${year} already exists`);

      const created = await prisma.year.create({
        data: { year, title, isOpen, sortOrder },
      });
      sendCreated(reply, { id: created.id, year: created.year });
    },
  );

  // PATCH /api/admin/years/:id
  app.patch<{ Params: { id: string } }>(
    '/years/:id',
    { preHandler: requireRole('ADMIN', 'OPERATOR') },
    async (request, reply) => {
      const year = await prisma.year.findUnique({ where: { id: request.params.id } });
      if (!year) throw notFound('Year not found');

      const { title, isOpen: newIsOpen, sortOrder } = parseBody(UpdateYearBody, request.body);
      const updated = await prisma.year.update({
        where: { id: year.id },
        data: {
          ...(title !== undefined ? { title } : {}),
          ...(newIsOpen !== undefined ? { isOpen: newIsOpen } : {}),
          ...(sortOrder !== undefined ? { sortOrder } : {}),
        },
        include: { _count: { select: { projects: true } } },
      });
      sendOk(reply, {
        id: updated.id,
        year: updated.year,
        title: updated.title || undefined,
        isOpen: updated.isOpen,
        sortOrder: updated.sortOrder,
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
  app.patch<{ Params: { id: string } }>(
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
        parseBody(UpdateProjectBody, request.body);

      const updated = await prisma.project.update({
        where: { id: project.id },
        data: {
          ...(title !== undefined ? { title } : {}),
          ...(summary !== undefined ? { summary } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(youtubeUrl !== undefined ? { youtubeUrl: youtubeUrl ?? '' } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(sortOrder !== undefined ? { sortOrder } : {}),
          ...(downloadPolicy !== undefined ? { downloadPolicy } : {}),
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
    const pipeline = new UploadPipeline();

    try {
      // ── Collect multipart parts ───────────────────────────────
      const parts = request.parts();
      let payloadJson = '';
      interface FilePart { tmpPath: string; fieldname: string; filename: string; }
      const fileParts: FilePart[] = [];

      for await (const part of parts) {
        if (part.type === 'field') {
          if (part.fieldname === 'payload') payloadJson = part.value as string;
        } else {
          const tmpPath = path.join(os.tmpdir(), crypto.randomUUID());
          pipeline.trackTempFile(tmpPath);
          await streamPipeline(part.file, createWriteStream(tmpPath));
          fileParts.push({
            tmpPath,
            fieldname: part.fieldname,
            filename: part.filename ?? '',
          });
        }
      }

      if (!payloadJson) throw badRequest('Missing payload field');

      // ── Parse & validate payload ───────────────────────────────
      let rawPayload: unknown;
      try {
        rawPayload = JSON.parse(payloadJson);
      } catch {
        throw badRequest('Invalid payload JSON');
      }

      const {
        year: yearNum,
        title,
        summary,
        description,
        youtubeUrl,
        autoPublish,
        members,
      } = parseBody(SubmitProjectPayload, rawPayload);

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

      // ── Validate, process, and move files via upload pipeline ─
      const savedFiles: SavedFile[] = [];
      for (const fp of fileParts) {
        let kind: AssetKind;
        if (fp.fieldname === 'poster') kind = 'POSTER';
        else if (fp.fieldname === 'images[]') kind = 'IMAGE';
        else if (fp.fieldname === 'gameFile') kind = 'GAME';
        else continue;

        const saved = await pipeline.processFile(fp.tmpPath, kind, fp.filename);
        savedFiles.push(saved);
      }

      const status = autoPublish ? 'PUBLISHED' : 'DRAFT';

      // ── DB transaction — if this fails, committed files are rolled back ─
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

      const adminEditUrl = `${cfg.WEB_PUBLIC_URL}/admin/projects/${project.id}/edit`;
      const publicUrl =
        status === 'PUBLISHED'
          ? `${cfg.WEB_PUBLIC_URL}/years/${yearNum}/${slug}`
          : undefined;

      sendCreated(reply, {
        id: project.id,
        slug: project.slug,
        year: yearNum,
        status,
        adminEditUrl,
        publicUrl,
      });
    } catch (err) {
      await pipeline.rollbackCommitted();
      throw err;
    } finally {
      await pipeline.cleanupTemp();
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

      const pipeline = new UploadPipeline();

      try {
        // Collect all parts first so 'kind' is set before processing
        let kind: AssetKind = 'IMAGE';
        let fileTmpPath: string | null = null;
        let fileOriginalName = '';

        const parts = request.parts();
        for await (const part of parts) {
          if (part.type === 'field' && part.fieldname === 'kind') {
            const parsed = AssetKindEnum.safeParse(part.value);
            if (!parsed.success) throw badRequest(`Invalid asset kind: ${part.value}`);
            kind = parsed.data;
          } else if (part.type === 'file' && part.fieldname === 'file') {
            const tmpPath = path.join(os.tmpdir(), crypto.randomUUID());
            pipeline.trackTempFile(tmpPath);
            await streamPipeline(part.file, createWriteStream(tmpPath));
            fileTmpPath = tmpPath;
            fileOriginalName = part.filename ?? '';
          }
        }

        if (!fileTmpPath) throw badRequest('No file provided');

        const savedFile = await pipeline.processFile(fileTmpPath, kind, fileOriginalName);

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
      } catch (err) {
        await pipeline.rollbackCommitted();
        throw err;
      } finally {
        await pipeline.cleanupTemp();
      }
    },
  );

  // PATCH /api/admin/projects/:id/poster
  app.patch<{ Params: { id: string } }>(
    '/projects/:id/poster',
    { preHandler: requireLogin },
    async (request, reply) => {
      const project = await prisma.project.findUnique({ where: { id: request.params.id } });
      if (!project) throw notFound('Project not found');

      const user = request.currentUser!;
      if (user.role !== 'ADMIN' && user.role !== 'OPERATOR') {
        if (project.creatorId !== user.id) throw forbidden('Not project owner');
        if (project.status !== 'DRAFT') throw forbidden('Cannot edit non-draft project');
      }

      const { assetId } = parseBody(SetPosterBody, request.body);
      const asset = await prisma.asset.findFirst({
        where: { id: assetId, projectId: project.id },
      });
      if (!asset) throw notFound('Asset not found');

      await prisma.project.update({ where: { id: project.id }, data: { posterAssetId: assetId } });
      sendOk(reply, { posterAssetId: assetId });
    },
  );

  // POST /api/admin/projects/:id/members
  app.post<{ Params: { id: string } }>(
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

      const { name, studentId, sortOrder } = parseBody(AddMemberBody, request.body);

      const member = await prisma.projectMember.create({
        data: { projectId: project.id, name, studentId, sortOrder },
      });
      sendCreated(reply, { id: member.id });
    },
  );

  // PATCH /api/admin/projects/:id/members/:memberId
  app.patch<{ Params: { id: string; memberId: string } }>(
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

      const { name, studentId, sortOrder } = parseBody(UpdateMemberBody, request.body);
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
