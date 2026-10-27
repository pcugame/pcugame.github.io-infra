import type { FastifyRequest } from 'fastify';

interface AuditLogger {
	info(context: Record<string, unknown>, message: string): void;
	warn(context: Record<string, unknown>, message: string): void;
}

/** Explicit fields only: never serialize request headers, cookies or sessions. */
export async function auditProjectDeletion<T>(
	logger: AuditLogger,
	request: Pick<FastifyRequest, 'id' | 'ip' | 'currentUser'>,
	projectIds: number[],
	deleteProjects: () => Promise<T>,
): Promise<T> {
	const actor = request.currentUser!;
	const context = {
		event: 'project.deletion',
		requestId: request.id,
		ip: request.ip,
		actorId: actor.id,
		actorEmail: actor.email,
		actorName: actor.name,
		actorRole: actor.role,
		projectIds: [...projectIds],
	};
	logger.info({ ...context, outcome: 'requested', occurredAt: new Date().toISOString() }, 'Project deletion requested');
	let result: T;
	try {
		result = await deleteProjects();
	} catch (error) {
		// This describes the request result, not proof that a transaction rolled back.
		logger.warn({ ...context, outcome: 'failed', occurredAt: new Date().toISOString() }, 'Project deletion request failed');
		throw error;
	}
	logger.info({ ...context, outcome: 'completed', occurredAt: new Date().toISOString() }, 'Project deletion request completed');
	return result;
}
