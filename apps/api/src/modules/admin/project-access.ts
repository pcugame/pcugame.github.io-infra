import type { FastifyRequest } from 'fastify';
import type { Project, UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { notFound, forbidden, unauthorized } from '../../shared/errors.js';

/**
 * Pure permission check — no DB access, fully testable.
 *
 * Rules:
 * - ADMIN / OPERATOR: always allowed (any project, any status).
 * - USER: must be the project creator OR a linked project member.
 *
 * Throws `forbidden` on denial. Does NOT check authentication (caller
 * must ensure the user is logged in before calling this).
 */
export function assertWriteAccess(
	role: UserRole,
	creatorId: number,
	userId: number,
	opts: { isMember?: boolean } = {},
): void {
	if (role === 'ADMIN' || role === 'OPERATOR') return;

	if (creatorId !== userId && !opts.isMember) {
		throw forbidden('Not project owner or member');
	}
}

/**
 * Load a project by ID and verify the current user has write access.
 *
 * - ADMIN / OPERATOR: always allowed.
 * - Other roles: must be the project creator or a linked member (ProjectMember.userId).
 */
export async function loadProjectWithAccess(
	request: FastifyRequest,
	projectId: number,
): Promise<Project> {
	const user = request.currentUser;
	if (!user) throw unauthorized();

	const project = await prisma.project.findUnique({ where: { id: projectId } });
	if (!project) throw notFound('Project not found');

	// Check if user is a linked member of this project
	const isMember = user.role !== 'ADMIN' && user.role !== 'OPERATOR'
		? !!(await prisma.projectMember.findFirst({
				where: { projectId, userId: user.id },
			}))
		: false;

	assertWriteAccess(user.role, project.creatorId, user.id, { isMember });
	return project;
}
