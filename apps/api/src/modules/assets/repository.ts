import type { PrismaClient } from '../../generated/prisma/client.js';
import type { AssetsRepository } from './ports.js';
export function createAssetsRepository(client: PrismaClient): AssetsRepository {
 return {
		/** Canonical domain identity lookup; status is deliberately not hidden. */
		findAssetByIdForDownload(id: number) {
			return client.asset.findUnique({
				where: { id },
				include: {
     exhibition: { select: { visibility: true } },
					project: {
						select: {
							creatorId: true,
							visibility: true,
							exhibition: {select:{visibility:true}},
							title: true,
							status: true,
							members: {
								select: { id: true, userId: true, name: true, studentId: true, sortOrder: true },
								orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
							},
							changeRequestDraft: {
								select: {
									actorId: true,
									state: true,
									project: { select: {
										creatorId: true,
										members: { select: { userId: true } },
									} },
								},
							},
						},
					},
					representations: {
						where: { role: { in: ['ORIGINAL', 'PLAYBACK', 'WEBGL_SOURCE'] } },
						select: { role: true, bucket: true, objectKey: true, state: true },
					},
				},
			});
		},

 };
}
