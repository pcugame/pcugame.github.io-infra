import type { FastifyPluginAsync } from 'fastify';
import type { Actor } from '../../../application/http-input.js';
import { sendCreated } from '../../../shared/http.js';
import {
	AddMemberBody,
	SwapMembersBody,
	UpdateMemberBody,
	parseBody,
	parseIntParam,
} from '../../../shared/validation.js';
import { requireLogin } from '../../../plugins/auth.js';
import type { createMemberService } from './service.js';

export interface MemberControllerDependencies {
	service: ReturnType<typeof createMemberService>;
	access: {
		loadProjectWithAccess(actor: Actor, projectId: number): Promise<unknown>;
	};
}

export function createMemberController(deps: MemberControllerDependencies): FastifyPluginAsync {
	return async function memberController(app): Promise<void> {
		app.post<{ Params: { id: string } }>(
			'/projects/:id/members',
			{ preHandler: requireLogin },
			async (request, reply) => {
				const projectId = parseIntParam(request.params.id);
				await deps.access.loadProjectWithAccess(request.currentUser!, projectId);
				const data = parseBody(AddMemberBody, request.body);
				sendCreated(reply, await deps.service.addMember(projectId, data));
			},
		);

		app.patch<{ Params: { id: string; memberId: string } }>(
			'/projects/:id/members/:memberId',
			{ preHandler: requireLogin },
			async (request, reply) => {
				const projectId = parseIntParam(request.params.id);
				const memberId = parseIntParam(request.params.memberId, 'Member ID');
				await deps.access.loadProjectWithAccess(request.currentUser!, projectId);
				await deps.service.updateMember(
					projectId,
					memberId,
					parseBody(UpdateMemberBody, request.body),
				);
				reply.status(204).send();
			},
		);

		app.delete<{ Params: { id: string; memberId: string } }>(
			'/projects/:id/members/:memberId',
			{ preHandler: requireLogin },
			async (request, reply) => {
				const projectId = parseIntParam(request.params.id);
				const memberId = parseIntParam(request.params.memberId, 'Member ID');
				await deps.access.loadProjectWithAccess(request.currentUser!, projectId);
				await deps.service.deleteMember(projectId, memberId);
				reply.status(204).send();
			},
		);

		app.patch<{ Params: { id: string } }>(
			'/projects/:id/members/swap',
			{ preHandler: requireLogin },
			async (request, reply) => {
				const projectId = parseIntParam(request.params.id);
				await deps.access.loadProjectWithAccess(request.currentUser!, projectId);
				const { memberIdA, memberIdB } = parseBody(SwapMembersBody, request.body);
				await deps.service.swapMemberOrder(projectId, memberIdA, memberIdB);
				reply.status(204).send();
			},
		);
	};
}
