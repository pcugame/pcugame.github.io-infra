import { inferWebglDisplayMode, parseWebglDisplayAnalysis, resolveWebglDisplay, type WebglDisplaySettings, type WebglDisplaySettingsResponse } from '@pcu/contracts';
import type { Actor } from '../../../application/http-input.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { forbidden, notFound } from '../../../shared/errors.js';
import { assertProjectWriteAccessInTransaction } from '../../admin/project-access.service.js';

export interface WebglDisplayRepository {
	read(actor: Actor, projectId: number): Promise<WebglDisplaySettingsResponse>;
	write(actor: Actor, projectId: number, settings: WebglDisplaySettings): Promise<WebglDisplaySettingsResponse>;
}

function assertOwner(actor: Actor, creatorId: number): void {
	if (actor.role !== 'ADMIN' && actor.role !== 'OPERATOR' && actor.id !== creatorId) {
		throw forbidden('Only the project owner or administrators may configure WebGL display size');
	}
}
const displaySelect = {
	webglDisplayMode: true, webglDisplayWidth: true, webglDisplayHeight: true,
	currentWebglDeploymentId: true,
	currentWebglDeployment: { select: { id: true, state: true, displayAnalysis: true } },
} as const;
function serializeDisplay(project: {
	webglDisplayMode: string; webglDisplayWidth: number | null; webglDisplayHeight: number | null;
	currentWebglDeploymentId: string | null;
	currentWebglDeployment: { id: string; state: string; displayAnalysis: unknown } | null;
}): WebglDisplaySettingsResponse {
	const webglDisplayMode = project.webglDisplayMode as WebglDisplaySettingsResponse['webglDisplayMode'];
	const analysis = project.currentWebglDeployment?.id === project.currentWebglDeploymentId
		&& project.currentWebglDeployment?.state === 'READY'
		? parseWebglDisplayAnalysis(project.currentWebglDeployment.displayAnalysis) : null;
	const settings = { webglDisplayMode, webglDisplayWidth: project.webglDisplayWidth, webglDisplayHeight: project.webglDisplayHeight };
	return { ...settings, analysis, effective: resolveWebglDisplay({ ...settings, analysis }) };
}

export function createWebglDisplayRepository(client: PrismaClient): WebglDisplayRepository {
	return {
		async read(actor, projectId) {
			const project = await client.project.findUnique({
				where: { id: projectId },
				select: { ...displaySelect, creatorId: true, changeRequestDraft: { select: { id: true } } },
			});
			if (!project || project.changeRequestDraft) throw notFound('Project not found');
			assertOwner(actor, project.creatorId);
			return serializeDisplay(project);
		},
		write(actor, projectId, settings) {
			return client.$transaction(async (tx) => {
				// Includes row locks, exhibition closure policy and private staging rejection.
				const project = await assertProjectWriteAccessInTransaction(tx, actor, projectId);
				assertOwner(actor, project.creatorId);
				const updated = await tx.project.update({
					where: { id: projectId }, data: { ...settings, webglDisplayMode: inferWebglDisplayMode(settings), version: { increment: 1 } }, select: displaySelect,
				});
				return serializeDisplay(updated);
			});
		},
	};
}
