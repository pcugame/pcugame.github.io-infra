import type { Prisma } from '../generated/prisma/client.js';
import { readableVisibilities, type VisibilityActor } from './visibility.js';

export function exhibitionVisibilityWhere(actor: VisibilityActor): Prisma.ExhibitionWhereInput {
	return { visibility: { in: readableVisibilities(actor) } };
}
export function projectVisibilityWhere(actor: VisibilityActor): Prisma.ProjectWhereInput {
	const audience = { visibility: { in: readableVisibilities(actor) }, exhibition: exhibitionVisibilityWhere(actor) };
	return actor ? { OR: [audience, { creatorId: actor.id }, { members: { some: { userId: actor.id } } }] } : audience;
}
