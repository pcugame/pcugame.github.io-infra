import type { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { sendOk } from '../../shared/http.js';
import { notFound } from '../../shared/errors.js';
import { sanitizeStudentId } from '../../shared/student-id.js';
import { isPosterUrlSafe } from '../../shared/poster-validation.js';

function publicAssetUrl(storageKey: string): string {
  return `${env().API_PUBLIC_URL}/api/assets/public/${storageKey}`;
}

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/public/years
  app.get('/years', async (_request, reply) => {
    const years = await prisma.year.findMany({
      orderBy: [{ sortOrder: 'asc' }, { year: 'desc' }],
      include: {
        _count: { select: { projects: { where: { status: 'PUBLISHED' } } } },
      },
    });
    const items = years.map((y) => ({
      id: y.id,
      year: y.year,
      title: y.title || undefined,
      projectCount: y._count.projects,
    }));
    sendOk(reply, { items });
  });

  // GET /api/public/years/:year/projects
  app.get<{ Params: { year: string } }>('/years/:year/projects', async (request, reply) => {
    const yearNum = parseInt(request.params.year, 10);
    if (isNaN(yearNum)) throw notFound('Year not found');

    const yearRecords = await prisma.year.findMany({ where: { year: yearNum } });
    if (yearRecords.length === 0) throw notFound('Year not found');

    const yearIds = yearRecords.map((y) => y.id);
    const yearMap = new Map(yearRecords.map((y) => [y.id, y]));

    const projects = await prisma.project.findMany({
      where: { yearId: { in: yearIds }, status: 'PUBLISHED' },
      orderBy: { sortOrder: 'asc' },
      include: {
        members: { orderBy: { sortOrder: 'asc' } },
        poster: true,
      },
    });

    const exhibitions = yearRecords.map((y) => ({
      id: y.id,
      title: y.title || `${yearNum} 전시`,
    }));

    const items = projects.map((p) => {
      const yr = yearMap.get(p.yearId);
      return {
        id: p.id,
        slug: p.slug,
        title: p.title,
        summary: p.summary || undefined,
        posterUrl: isPosterUrlSafe(p.poster) ? publicAssetUrl(p.poster!.storageKey) : undefined,
        members: p.members.map((m) => ({ name: m.name, studentId: sanitizeStudentId(m.studentId) })),
        exhibitionId: p.yearId,
        exhibitionTitle: yr?.title || `${yearNum} 전시`,
      };
    });

    sendOk(reply, { year: yearNum, exhibitions, items, empty: items.length === 0 });
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
      let yearIds: string[] | undefined;
      if (yearNum !== undefined && !isNaN(yearNum)) {
        const ys = await prisma.year.findMany({ where: { year: yearNum } });
        if (ys.length > 0) yearIds = ys.map((y) => y.id);
      }
      project = await prisma.project.findFirst({
        where: {
          slug: idOrSlug,
          status: 'PUBLISHED',
          ...(yearIds ? { yearId: { in: yearIds } } : {}),
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
      isLegacy: project.isLegacy,
      video: project.videoUrl
        ? {
            provider: 'NAS' as const,
            url: project.videoUrl,
            mimeType: project.videoMimeType || 'video/mp4',
          }
        : null,
      members: project.members.map((m) => ({
        id: m.id,
        name: m.name,
        studentId: sanitizeStudentId(m.studentId),
      })),
      images,
      posterUrl: isPosterUrlSafe(project.poster) ? publicAssetUrl(project.poster!.storageKey) : undefined,
      gameDownloadUrl: gameAsset
        ? `${env().API_PUBLIC_URL}/api/assets/protected/${gameAsset.storageKey}`
        : undefined,
      downloadPolicy: project.downloadPolicy,
      status: 'PUBLISHED' as const,
    });
  });
}
