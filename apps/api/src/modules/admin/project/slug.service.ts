import { toSlug } from '../../../shared/slug.js';
import * as repo from './repository.js';

/** Generate a unique slug for a project within an exhibition */
export async function generateUniqueSlug(exhibitionId: number, title: string): Promise<string> {
	const baseSlug = toSlug(title);
	let slug = baseSlug;
	let attempt = 0;
	while (await repo.findProjectByExhibitionAndSlug(exhibitionId, slug)) {
		attempt++;
		slug = `${baseSlug}-${attempt}`;
	}
	return slug;
}

/** Next candidate in the `-1`, `-2`, ... series used when we lose the slug race. */
export function nextSlugCandidate(baseSlug: string, attempt: number): string {
	return attempt === 0 ? baseSlug : `${baseSlug}-${attempt}`;
}
