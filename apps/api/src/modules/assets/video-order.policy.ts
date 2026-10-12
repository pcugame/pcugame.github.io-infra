import { conflict } from '../../shared/errors.js';
export const MAX_PROJECT_VIDEOS = 5;
export function assertVideoCount(count: number): void {
 if (count > MAX_PROJECT_VIDEOS) throw conflict('A project supports at most 5 videos');
}

export function normalizedVideoOrder<T extends { id: number; videoSortOrder: number | null }>(videos: readonly T[]): (T & { videoSortOrder: number })[] {
 assertVideoCount(videos.length);
 return videos.map((video, videoSortOrder) => ({ ...video, videoSortOrder }));
}
export function videoOrderNeedsRewrite(videos: readonly { videoSortOrder: number | null }[]): boolean {
 return videos.some((video, index) => video.videoSortOrder !== index);
}
