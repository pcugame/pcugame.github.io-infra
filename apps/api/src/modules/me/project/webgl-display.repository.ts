import type { WebglDisplaySettings } from '@pcu/contracts';
import type { Actor } from '../../../application/http-input.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { forbidden, notFound } from '../../../shared/errors.js';
import { assertProjectWriteAccessInTransaction } from '../../admin/project-access.service.js';

export interface WebglDisplayRepository {
	read(actor: Actor, projectId: number): Promise<WebglDisplaySettings>;
	write(actor: Actor, projectId: number, settings: WebglDisplaySettings): Promise<WebglDisplaySettings>;
}

function assertOwner(actor: Actor, creatorId: number): void {
	if (actor.role !== 'ADMIN' && actor.role !== 'OPERATOR' && actor.id !== creatorId) {
		throw forbidden('Only the project owner or administrators may configure WebGL display size');
	}
}
const displaySelect = { webglDisplayWidth: true, webglDisplayHeight: true } as const;

export function createWebglDisplayRepository(client: PrismaClient): WebglDisplayRepository {
	return {
		async read(actor, projectId) {
			const project = await client.project.findUnique({
				where: { id: projectId },
				select: { ...displaySelect, creatorId: true, changeRequestDraft: { select: { id: true } } },
			});
			if (!project || project.changeRequestDraft) throw notFound('Project not found');
			assertOwner(actor, project.creatorId);
			return { webglDisplayWidth: project.webglDisplayWidth, webglDisplayHeight: project.webglDisplayHeight };
		},
		write(actor, projectId, settings) {
			return client.$transaction(async (tx) => {
				// Includes row locks, exhibition closure policy and private staging rejection.
				const project = await assertProjectWriteAccessInTransaction(tx, actor, projectId);
				assertOwner(actor, project.creatorId);
				return tx.project.update({
					where: { id: projectId }, data: { ...settings, version: { increment: 1 } }, select: displaySelect,
				});
			});
		},
	};
}
