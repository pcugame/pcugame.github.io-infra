import { awardInclude } from '../../awards/serialization.js';
import type { Prisma } from '../../../generated/prisma/client.js';

export const projectAssetActivityInclude = {
	assetUploads: {
		where: { kind: { in: ['GAME', 'WEBGL', 'VIDEO', 'POSTER'] } },
		// Keep active sessions and the newest terminal attempt without returning upload history.
		distinct: ['kind', 'state'],
		orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
		select: { kind: true, state: true },
	},
	publicationJob: { select: {
		state: true,
		submission: { select: { items: { select: { kind: true, state: true } } } },
	} },
} satisfies Prisma.ProjectInclude;
export const projectDetailInclude = {
	...projectAssetActivityInclude,
	exhibition: true,
 awards: awardInclude,
	changeRequestDraft: { select: { id: true } },
	members: { orderBy: { sortOrder: 'asc' as const } },
	assets: {
		where: { status: 'READY' as const },
		orderBy: { createdAt: 'asc' as const },
		include: { representations: true, playbackJobs: { orderBy: { createdAt: 'desc' as const }, include: { renditions: true } } },
	},
	poster: { include: { representations: { where: { state: 'READY' as const } } } },
	currentWebglDeployment: true,
} as const;

