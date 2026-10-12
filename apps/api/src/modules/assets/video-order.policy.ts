import { conflict } from '../../shared/errors.js';
import { compareProjectVideos } from '../../shared/project-video-order.js';

export const MAX_PROJECT_VIDEOS = 5;

export function assertVideoCount(count: number, message = 'A project supports at most 5 videos'): void {
	if (count > MAX_PROJECT_VIDEOS) throw conflict(message);
}

export function assertVideoCapacity(ready: number, reserved: number): void {
	assertVideoCount(ready + reserved + 1);
}

export function orderedProjectVideos<T extends { id: number; videoSortOrder: number | null; createdAt: Date }>(videos: readonly T[]): T[] {
	return [...videos].sort(compareProjectVideos);
}

export function videoOrderAssignments(ids: readonly number[]): { id: number; videoSortOrder: number }[] {
	assertVideoCount(ids.length);
	return ids.map((id, videoSortOrder) => ({ id, videoSortOrder }));
}

export function normalizedVideoOrder<T extends { id: number; videoSortOrder: number | null }>(videos: readonly T[]): (T & { videoSortOrder: number })[] {
	assertVideoCount(videos.length);
	return videos.map((video, videoSortOrder) => ({ ...video, videoSortOrder }));
}

export function videoOrderNeedsRewrite(videos: readonly { videoSortOrder: number | null }[]): boolean {
	return videos.some((video, index) => video.videoSortOrder !== index);
}
