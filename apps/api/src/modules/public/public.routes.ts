import type { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { sendOk } from '../../shared/http.js';
import { notFound } from '../../shared/errors.js';

function publicAssetUrl(storageKey: string): string {
  return `${env().PUBLIC_BASE_URL}/api/assets/public/${storageKey}`;
}

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/public/years
  app.get('/years', async (_request, reply) => {
    const years = await prisma.year.findMany({
      orderBy: { year: 'desc' },
      include: {
        _count: { select: { projects: { where: { status: 'PUBLISHED' } } } },
      },
    });
    const items = years.map((y) => ({
      id: y.id,
      year: y.year,
      title: y.title || undefined,
      projectCount: y._count.projects,
      isPublished: y.isOpen,
    }));
    sendOk(reply, { items });
  });

  // GET /api/public/years/:year/projects
  app.get<{ Params: { year: string } }>('/years/:year/projects', async (request, reply) => {
    const yearNum = parseInt(request.params.year, 10);
    if (isNaN(yearNum)) throw notFound('Year not found');

    const year = await prisma.year.findUnique({ where: { year: yearNum } });
    if (!year) throw notFound('Year not found');

    const projects = await prisma.project.findMany({
      where: { yearId: year.id, status: 'PUBLISHED' },
      orderBy: { sortOrder: 'asc' },
      include: {
        members: { orderBy: { sortOrder: 'asc' } },
        poster: true,
      },
    });

    const items = projects.map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      summary: p.summary || undefined,
      posterUrl: p.poster ? publicAssetUrl(p.poster.storageKey) : undefined,
      members: p.members.map((m) => ({ name: m.name, studentId: m.studentId })),
    }));

    sendOk(reply, { year: yearNum, items, empty: items.length === 0 });
  });

  // GET /api/public/projects/:idOrSlug?year=...
  app.get<{
    Params: { idOrSlug: string };
    Querystring: { year?: string };
  }>('/projects/:idOrSlug', async (request, reply) => {
    const { idOrSlug } = request.params;
    const yearNum = request.query.year ? parseInt(request.query.year, 10) : undefined;

    const includeSpec = {
      year: true,
      members: { orderBy: { sortOrder: 'asc' as const } },
      assets: { where: { status: 'READY' as const } },
      poster: true,
    };

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let project = null;

    if (uuidPattern.test(idOrSlug)) {
      project = await prisma.project.findFirst({
        where: { id: idOrSlug, status: 'PUBLISHED' },
        include: includeSpec,
      });
    }

    if (!project) {
      let yearId: string | undefined;
      if (yearNum !== undefined && !isNaN(yearNum)) {
        const y = await prisma.year.findUnique({ where: { year: yearNum } });
        yearId = y?.id;
      }
      project = await prisma.project.findFirst({
        where: {
          slug: idOrSlug,
          status: 'PUBLISHED',
          ...(yearId ? { yearId } : {}),
        },
        include: includeSpec,
      });
    }

    if (!project) throw notFound('Project not found');

    const images = project.assets
      .filter((a) => a.kind === 'IMAGE' || a.kind === 'POSTER')
      .map((a) => ({
        id: a.id,
        url: publicAssetUrl(a.storageKey),
        kind: a.kind as 'IMAGE' | 'POSTER',
      }));

    const gameAsset = project.assets.find((a) => a.kind === 'GAME');

    sendOk(reply, {
      id: project.id,
      year: project.year.year,
      slug: project.slug,
      title: project.title,
      summary: project.summary || undefined,
      description: project.description || undefined,
      youtubeUrl: project.youtubeUrl || undefined,
      members: project.members.map((m) => ({
        id: m.id,
        name: m.name,
        studentId: m.studentId,
      })),
      images,
      posterUrl: project.poster ? publicAssetUrl(project.poster.storageKey) : undefined,
      gameDownloadUrl: gameAsset
        ? `${env().PUBLIC_BASE_URL}/api/assets/protected/${gameAsset.storageKey}`
        : undefined,
      downloadPolicy: project.downloadPolicy,
      status: 'PUBLISHED' as const,
    });
  });
}
