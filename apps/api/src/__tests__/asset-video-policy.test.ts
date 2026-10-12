import { expect, it } from 'vitest';
import { assertVideoCapacity, orderedProjectVideos, videoOrderAssignments } from '../modules/assets/video-order.policy.js';

it('accounts for existing READY videos and unfinished upload reservations together', () => {
	expect(() => assertVideoCapacity(3, 1)).not.toThrow();
	expect(() => assertVideoCapacity(3, 2)).toThrow('at most 5');
});

it('orders legacy NULL slots after assigned slots, breaking ties by creation time and id', () => {
	const videos = [
		{ id: 4, videoSortOrder: null, createdAt: new Date(2) },
		{ id: 2, videoSortOrder: null, createdAt: new Date(1) },
		{ id: 1, videoSortOrder: 0, createdAt: new Date(3) },
		{ id: 3, videoSortOrder: null, createdAt: new Date(1) },
	];
	expect(orderedProjectVideos(videos).map(video => video.id)).toEqual([1, 2, 3, 4]);
	expect(videos[0]!.id).toBe(4);
	expect(videoOrderAssignments([4, 1])).toEqual([{ id: 4, videoSortOrder: 0 }, { id: 1, videoSortOrder: 1 }]);
});
