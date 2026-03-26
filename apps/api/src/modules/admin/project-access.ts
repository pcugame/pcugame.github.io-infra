import type { FastifyRequest } from 'fastify';
import type { Project } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { notFound, forbidden, unauthorized } from '../../shared/errors.js';

/**
 * Load a project by ID and verify the current user has access.
 *
 * - ADMIN / OPERATOR: always allowed.
 * - Other roles: must be the project creator.
 * - If `requireDraft` is true, non-privileged users can only edit DRAFT projects.
 */
export async function loadProjectWithAccess(
	request: FastifyRequest,
	projectId: string,
	opts: { requireDraft?: boolean } = {},
): Promise<Project> {
	const user = request.currentUser;
	if (!user) throw unauthorized();

	const project = await prisma.project.findUnique({ where: { id: projectId } });
	if (!project) throw notFound('Project not found');

	if (user.role === 'ADMIN' || user.role === 'OPERATOR') return project;

	if (project.creatorId !== user.id) throw forbidden('Not project owner');
	if (opts.requireDraft && project.status !== 'DRAFT') {
		throw forbidden('Cannot edit non-draft project');
	}

	return project;
}
