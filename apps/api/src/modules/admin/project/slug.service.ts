import { toSlug } from '../../../shared/slug.js';

/** Generate a unique slug for a project within an exhibition */
export async function generateUniqueSlug(
	repository: { findProjectByExhibitionAndSlug(exhibitionId: number, slug: string): Promise<unknown | null> },
	exhibitionId: number,
	title: string,
): Promise<string> {
	const baseSlug = toSlug(title);
	let slug = baseSlug;
	let attempt = 0;
	while (await repository.findProjectByExhibitionAndSlug(exhibitionId, slug)) {
		attempt++;
		slug = `${baseSlug}-${attempt}`;
	}
	return slug;
}

/** Next candidate in the `-1`, `-2`, ... series used when we lose the slug race. */
export function nextSlugCandidate(baseSlug: string, attempt: number): string {
	return attempt === 0 ? baseSlug : `${baseSlug}-${attempt}`;
}
