import type { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { sendCreated } from '../../shared/http.js';
import { notFound } from '../../shared/errors.js';
import { parseBody, AddMemberBody, UpdateMemberBody } from '../../shared/validation.js';
import { requireLogin } from '../../plugins/auth.js';
import { loadProjectWithAccess } from './project-access.js';

export async function adminMemberRoutes(app: FastifyInstance): Promise<void> {
	// POST /projects/:id/members
	app.post<{ Params: { id: string } }>(
		'/projects/:id/members',
		{ preHandler: requireLogin },
		async (request, reply) => {
			await loadProjectWithAccess(request, request.params.id, { requireDraft: true });

			const { name, studentId, sortOrder } = parseBody(AddMemberBody, request.body);

			const member = await prisma.projectMember.create({
				data: { projectId: request.params.id, name, studentId, sortOrder },
			});
			sendCreated(reply, { id: member.id });
		},
	);

	// PATCH /projects/:id/members/:memberId
	app.patch<{ Params: { id: string; memberId: string } }>(
		'/projects/:id/members/:memberId',
		{ preHandler: requireLogin },
		async (request, reply) => {
			await loadProjectWithAccess(request, request.params.id, { requireDraft: true });

			const member = await prisma.projectMember.findFirst({
				where: { id: request.params.memberId, projectId: request.params.id },
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

	// DELETE /projects/:id/members/:memberId
	app.delete<{ Params: { id: string; memberId: string } }>(
		'/projects/:id/members/:memberId',
		{ preHandler: requireLogin },
		async (request, reply) => {
			await loadProjectWithAccess(request, request.params.id, { requireDraft: true });

			const member = await prisma.projectMember.findFirst({
				where: { id: request.params.memberId, projectId: request.params.id },
			});
			if (!member) throw notFound('Member not found');

			await prisma.projectMember.delete({ where: { id: member.id } });
			reply.status(204).send();
		},
	);
}
