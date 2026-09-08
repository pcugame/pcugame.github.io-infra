/** Human-readable video roles used consistently in public and admin UI. */
export function getVideoLabel(video: {
	role?: 'MAIN' | 'ADDITIONAL';
	sortOrder?: number | null;
}): string {
	if (video.role === 'MAIN' || video.sortOrder === 0) return '메인 영상';
	if (typeof video.sortOrder === 'number') return `추가 영상 ${video.sortOrder}`;
	return '추가 영상';
}

export function getAdminVideoLabel(sortOrder: number | null | undefined): string {
	if (sortOrder === 0) return '메인 영상';
	if (typeof sortOrder === 'number') return `추가 영상 ${sortOrder}`;
	return '순서 미지정';
}
