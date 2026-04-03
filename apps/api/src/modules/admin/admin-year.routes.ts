import type { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { sendOk, sendCreated } from '../../shared/http.js';
import { notFound, conflict } from '../../shared/errors.js';
import { parseBody, CreateYearBody, UpdateYearBody } from '../../shared/validation.js';
import { requireLogin, requireRole } from '../../plugins/auth.js';

export async function adminYearRoutes(app: FastifyInstance): Promise<void> {
	// GET /years
	app.get('/years', { preHandler: requireLogin }, async (_req, reply) => {
		const years = await prisma.year.findMany({
			orderBy: [{ sortOrder: 'asc' }, { year: 'desc' }],
			include: { _count: { select: { projects: true } } },
		});
		const items = years.map((y) => ({
			id: y.id,
			year: y.year,
			title: y.title || undefined,
			isUploadEnabled: y.isUploadEnabled,
			sortOrder: y.sortOrder,
			projectCount: y._count.projects,
		}));
		sendOk(reply, { items });
	});

	// POST /years
	app.post(
		'/years',
		{ preHandler: requireRole('ADMIN', 'OPERATOR') },
		async (request, reply) => {
			const { year, title, isUploadEnabled, sortOrder } = parseBody(CreateYearBody, request.body);

			const existing = await prisma.year.findUnique({
				where: { year_title: { year, title: title || '' } },
			});
			if (existing) throw conflict(`"${title || year}" 전시회가 이미 존재합니다`);

			const created = await prisma.year.create({
				data: { year, title, isUploadEnabled, sortOrder },
			});
			sendCreated(reply, { id: created.id, year: created.year });
		},
	);

	// DELETE /years/:id — cascade-deletes all projects, members, assets (DB records only)
	app.delete<{ Params: { id: string } }>(
		'/years/:id',
		{ preHandler: requireRole('ADMIN', 'OPERATOR') },
		async (request, reply) => {
			const year = await prisma.year.findUnique({
				where: { id: request.params.id },
				include: { _count: { select: { projects: true } } },
			});
			if (!year) throw notFound('Year not found');

			await prisma.year.delete({ where: { id: year.id } });
			reply.status(204).send();
		},
	);

	// PATCH /years/:id
	app.patch<{ Params: { id: string } }>(
		'/years/:id',
		{ preHandler: requireRole('ADMIN', 'OPERATOR') },
		async (request, reply) => {
			const year = await prisma.year.findUnique({ where: { id: request.params.id } });
			if (!year) throw notFound('Year not found');

			const { title, isUploadEnabled: newIsUploadEnabled, sortOrder } = parseBody(UpdateYearBody, request.body);
			const updated = await prisma.year.update({
				where: { id: year.id },
				data: {
					...(title !== undefined ? { title } : {}),
					...(newIsUploadEnabled !== undefined ? { isUploadEnabled: newIsUploadEnabled } : {}),
					...(sortOrder !== undefined ? { sortOrder } : {}),
				},
				include: { _count: { select: { projects: true } } },
			});
			sendOk(reply, {
				id: updated.id,
				year: updated.year,
				title: updated.title || undefined,
				isUploadEnabled: updated.isUploadEnabled,
				sortOrder: updated.sortOrder,
				projectCount: updated._count.projects,
			});
		},
	);
}
