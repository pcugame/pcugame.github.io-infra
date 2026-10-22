import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { forbidden, notFound } from '../../shared/errors.js';
import { withAssetMutationTransaction } from '../assets/mutation-transaction.js';
import { enqueuePlayback } from './playback.repository.js';
import type { VideoRetryRepository } from './retry.service.js';

export function createVideoRetryRepository(client: PrismaClient): VideoRetryRepository {
	return {
		retry(actorId, projectId, assetId, run) {
			return withAssetMutationTransaction(client, async (tx) => {
				await tx.$queryRaw(Prisma.sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
				await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${actorId} FOR SHARE`);
				const actor = await tx.user.findUnique({ where: { id: actorId }, select: { role: true } });
				if (!actor) throw forbidden();
				await run(actor.role, async () => {
					const project = await tx.project.findUnique({ where: { id: projectId }, include: { changeRequestDraft: { select: { id: true } } } });
					if (!project) throw notFound('Project not found');
					if (project.changeRequestDraft) throw forbidden('Staged change-request projects cannot be modified through project routes');
					const asset = await tx.asset.findUnique({ where: { id: assetId } });
					if (!asset || asset.projectId !== projectId || asset.kind !== 'VIDEO') throw notFound('Video not found');
                    const submission = await tx.projectSubmission.findUnique({ where: { projectId }, select: { state: true } });
                    if (submission?.state === 'FINALIZING') return false;
                    return enqueuePlayback(tx, assetId);
				});
			});
		},
	};
}
