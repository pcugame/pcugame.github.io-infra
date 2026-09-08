import { describe, expect, it, vi } from 'vitest';
import { createProjectSerializer, type SerializableProject } from '../modules/admin/project/serializer.js';
import { getProjectDetail, type PublicServiceDependencies } from '../modules/public/service.js';

const assets = [
	{ id: 2, videoSortOrder: null, createdAt: new Date(30) },
	{ id: 10, videoSortOrder: 1, createdAt: new Date(5) },
	{ id: 9, videoSortOrder: null, createdAt: new Date(20) },
	{ id: 5, videoSortOrder: 0, createdAt: new Date(40) },
	{ id: 8, videoSortOrder: null, createdAt: new Date(20) },
	{ id: 7, videoSortOrder: null, createdAt: new Date(10) },
].map((asset) => ({
	...asset, storageKey: null, playbackStorageKey: null, mimeType: 'video/mp4', playbackMimeType: '', sizeBytes: 10n, playbackSizeBytes: 0n, playbackStatus: 'PENDING' as const, playbackError: '', kind: 'VIDEO' as const, originalName: `${asset.id}.mp4`,
	representations: [
		{ role: 'ORIGINAL', state: 'READY', bucket: 'protected', objectKey: `original/${asset.id}`, mimeType: 'video/mp4', sizeBytes: 10n },
		{ role: 'PLAYBACK', state: asset.id === 5 ? 'FAILED' : 'READY', error: asset.id === 5 ? 'encoder failed' : null,
			bucket: 'protected', objectKey: `playback/${asset.id}`, mimeType: 'video/mp4', sizeBytes: 10n },
	],
}));
const project: SerializableProject = {
	id: 1, title: 'Videos', slug: 'videos', exhibition: { year: 2026 }, summary: '', description: '', githubUrl: '',
	platforms: [], isIncomplete: false, status: 'PUBLISHED', sortOrder: 0, posterAssetId: null, poster: null,
	members: [], assets,
};

describe('ordered project video responses', () => {
	it.each(['admin', 'public'] as const)('%s preserves FAILED main and every legacy overflow video in deterministic order', async (surface) => {
		const result = surface === 'admin'
			? createProjectSerializer('https://api.test').serializeProjectDetail(project)
			: await getProjectDetail({
				apiPublicUrl: 'https://api.test',
				repository: { findPublishedProjectById: vi.fn().mockResolvedValue(project) },
			} as unknown as PublicServiceDependencies, '1');
		expect(result.videos.map((video) => video.assetId)).toEqual([5, 10, 7, 8, 9, 2]);
		expect(result.video).toBe(result.videos[0]);
		expect(result.video).toMatchObject({ assetId: 5, sortOrder: 0, role: 'MAIN', playbackStatus: 'FAILED', playbackError: 'encoder failed' });
		expect(result.video).not.toHaveProperty('url');
		expect(result.videos.slice(1).every((video) => video.role === 'ADDITIONAL')).toBe(true);
		expect(result.videos.slice(2).every((video) => video.sortOrder === null)).toBe(true);
	});
	it('uses the first legacy NULL video as MAIN without inventing a stored order', () => {
		const result = createProjectSerializer('https://api.test').serializeProjectDetail({ ...project, assets: assets.filter((asset) => asset.videoSortOrder === null) });
		expect(result.video).toMatchObject({ assetId: 7, sortOrder: null, role: 'MAIN' });
		expect(result.videos.slice(1).every((video) => video.role === 'ADDITIONAL')).toBe(true);
	});
});
