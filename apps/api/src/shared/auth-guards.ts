import type { UserRole } from '@pcu/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, unauthorized } from './errors.js';

/**
 * Framework guards live separately from session resolution so feature graphs
 * do not acquire the session adapter's cryptographic/runtime dependencies.
 */
export async function requireLogin(
	request: FastifyRequest,
	_reply: FastifyReply,
): Promise<void> {
	if (!request.currentUser) throw unauthorized();
}

export function requireRole(...roles: UserRole[]) {
	return async (
		request: FastifyRequest,
		_reply: FastifyReply,
	): Promise<void> => {
		if (!request.currentUser) throw unauthorized();
		if (!roles.includes(request.currentUser.role)) {
			throw forbidden('Insufficient permissions');
		}
	};
}
