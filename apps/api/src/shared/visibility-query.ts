import type { Prisma } from '../generated/prisma/client.js';
import { readableVisibilities, type VisibilityActor } from './visibility.js';

export function exhibitionVisibilityWhere(actor: VisibilityActor): Prisma.ExhibitionWhereInput {
	return { visibility: { in: readableVisibilities(actor) } };
}
export function projectVisibilityWhere(actor: VisibilityActor): Prisma.ProjectWhereInput {
 return { publicationStatus: 'PUBLIC', exhibition: exhibitionVisibilityWhere(actor), hiddenCancelled: false };
}
