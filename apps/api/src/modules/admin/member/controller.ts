import type { FastifyInstance } from 'fastify';
import { sendCreated } from '../../../shared/http.js';
import { parseBody, parseIntParam, AddMemberBody, UpdateMemberBody, SwapMembersBody } from '../../../shared/validation.js';
import { requireLogin } from '../../../plugins/auth.js';
import { loadProjectWithAccess } from '../project-access.js';
import * as memberService from './service.js';

/** Register admin member CRUD routes */
export async function memberController(app: FastifyInstance): Promise<void> {
	/** POST /projects/:id/members — add a member to a project */
	app.post<{ Params: { id: string } }>(
		'/projects/:id/members',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const projectId = parseIntParam(request.params.id);
			await loadProjectWithAccess(request, projectId, { requireDraft: true });
			const data = parseBody(AddMemberBody, request.body);
			const result = await memberService.addMember(projectId, data);
			sendCreated(reply, result);
		},
	);

	/** PATCH /projects/:id/members/:memberId — update a member */
	app.patch<{ Params: { id: string; memberId: string } }>(
		'/projects/:id/members/:memberId',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const projectId = parseIntParam(request.params.id);
			const memberId = parseIntParam(request.params.memberId, 'Member ID');
			await loadProjectWithAccess(request, projectId, { requireDraft: true });
			const patch = parseBody(UpdateMemberBody, request.body);
			await memberService.updateMember(projectId, memberId, patch);
			reply.status(204).send();
		},
	);

	/** DELETE /projects/:id/members/:memberId — remove a member */
	app.delete<{ Params: { id: string; memberId: string } }>(
		'/projects/:id/members/:memberId',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const projectId = parseIntParam(request.params.id);
			const memberId = parseIntParam(request.params.memberId, 'Member ID');
			await loadProjectWithAccess(request, projectId, { requireDraft: true });
			await memberService.deleteMember(projectId, memberId);
			reply.status(204).send();
		},
	);

	/** PATCH /projects/:id/members/swap — atomically swap two members' sort order */
	app.patch<{ Params: { id: string } }>(
		'/projects/:id/members/swap',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const projectId = parseIntParam(request.params.id);
			await loadProjectWithAccess(request, projectId, { requireDraft: true });
			const { memberIdA, memberIdB } = parseBody(SwapMembersBody, request.body);
			await memberService.swapMemberOrder(projectId, memberIdA, memberIdB);
			reply.status(204).send();
		},
	);
}
