/** Legacy NULL orders follow assigned slots with a deterministic timestamp/id tie-break. */
export function compareProjectVideos(
	a: { id: number; videoSortOrder?: number | null; createdAt?: Date },
	b: { id: number; videoSortOrder?: number | null; createdAt?: Date },
): number {
	return (a.videoSortOrder ?? Infinity) - (b.videoSortOrder ?? Infinity)
		|| (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0) || a.id - b.id;
}
