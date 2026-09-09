import { describe, expect, it } from 'vitest';
import { createProjectSerializer, type SerializableProject } from '../modules/admin/project/serializer.js';

const deploymentId = '123e4567-e89b-42d3-a456-426614174000';

function rep(role: string, bucket: string, objectKey: string, mimeType: string, sizeBytes = 100n) {
	return { role, bucket, objectKey, mimeType, sizeBytes, state: 'READY', width: 1200, height: 800 };
}

describe('Phase 2 admin project serialization', () => {
	it('resolves every user-facing asset URL from representations and the current deployment', () => {
		const project: SerializableProject = {
			id: 7,
			title: 'Canonical game',
			slug: 'canonical-game',
			exhibition: { year: 2026 },
			summary: '',
			description: '',
			githubUrl: '',
			platforms: ['WEB'],
			isIncomplete: false,
			status: 'PUBLISHED',
			sortOrder: 0,
			posterAssetId: 13,
			currentWebglDeploymentId: deploymentId,
			currentWebglDeployment: {
				id: deploymentId,
				projectId: 7,
				publicBucket: 'public',
				publicPrefix: `public/webgl/7/${deploymentId}/`,
				entryObjectKey: `public/webgl/7/${deploymentId}/index.html`,
				state: 'READY',
				createdAt: new Date('2026-08-21T00:00:00.000Z'),
			},
			poster: {
				id: 13,
				kind: 'POSTER',
				status: 'READY',
				representations: [
					rep('ORIGINAL', 'public', 'public/images/13/original/g1.webp', 'image/webp'),
					rep('CARD_480', 'public', 'public/images/13/card-480/g1.webp', 'image/webp'),
				],
			},
			members: [],
			assets: [
				{ id: 10, kind: 'GAME', originalName: 'game.zip', representations: [rep('ORIGINAL', 'protected', 'protected/assets/10/original/g1.zip', 'application/zip')] },
				{ id: 11, kind: 'VIDEO', originalName: 'video.mov', representations: [
					rep('ORIGINAL', 'protected', 'protected/assets/11/original/g1.mov', 'video/quicktime'),
					rep('PLAYBACK', 'protected', 'protected/assets/11/playback/g1.mp4', 'video/mp4'),
				] },
				{ id: 14, kind: 'VIDEO', originalName: 'failed-playback.mov', representations: [
					rep('ORIGINAL', 'protected', 'protected/assets/14/original/g1.mov', 'video/quicktime'),
					{ ...rep('PLAYBACK', 'protected', 'protected/assets/14/playback/g1.mp4', 'video/mp4'), state: 'FAILED', error: 'encoder failed' },
				] },
				{ id: 12, kind: 'IMAGE', originalName: 'image.webp', representations: [
					rep('ORIGINAL', 'public', 'public/images/12/original/g1.webp', 'image/webp'),
					rep('DISPLAY_960', 'public', 'public/images/12/display-960/g1.webp', 'image/webp'),
				] },
				{ id: 15, kind: 'DOCUMENT', originalName: 'guide.pdf', representations: [
					rep('ORIGINAL', 'protected', 'protected/assets/15/original/guide.pdf', 'application/pdf', 1024n),
				] },
				{ id: 16, kind: 'ATTACHMENT', originalName: 'source.zip', representations: [
					rep('ORIGINAL', 'protected', 'protected/assets/16/original/source.zip', 'application/zip', 2048n),
				] },
			],
		};
		const detail = createProjectSerializer('https://api.example.test', {
			publicAssetOrigin: 'https://assets.example.test',
			publicBucket: 'public',
		}).serializeProjectDetail(project);

		expect(detail.assets).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: 10, url: 'https://api.example.test/api/assets/10/download?variant=original' }),
			expect.objectContaining({
				id: 11,
				originalDownloadUrl: 'https://api.example.test/api/assets/11/download?variant=original',
				playbackUrl: 'https://api.example.test/api/assets/11/download?variant=playback',
			}),
			expect.objectContaining({
				id: 12,
				image: expect.objectContaining({
					original: expect.objectContaining({ url: 'https://assets.example.test/public/images/12/original/g1.webp' }),
					renditions: [expect.objectContaining({ url: 'https://assets.example.test/public/images/12/display-960/g1.webp' })],
				}),
			}),
			expect.objectContaining({
				id: 14,
				originalDownloadUrl: 'https://api.example.test/api/assets/14/download?variant=original',
				playbackUrl: undefined,
				playbackStatus: 'FAILED',
				playbackError: 'encoder failed',
			}),
		]));
		const failedVideo = detail.videos.find((candidate) => candidate.playbackStatus === 'FAILED');
		expect(failedVideo).toEqual(expect.objectContaining({
			originalDownloadUrl: 'https://api.example.test/api/assets/14/download?variant=original',
			playbackStatus: 'FAILED',
		}));
		expect(failedVideo).not.toHaveProperty('url');
		expect(detail.poster?.original.url).toBe('https://assets.example.test/public/images/13/original/g1.webp');
		expect(detail.webglUrl).toBe(`https://assets.example.test/public/webgl/7/${deploymentId}/index.html`);
		expect(detail.attachments).toEqual([
			{ assetId: 15, kind: 'DOCUMENT', originalName: 'guide.pdf', mimeType: 'application/pdf', sizeBytes: 1024, downloadUrl: 'https://api.example.test/api/assets/15/download?variant=original' },
			{ assetId: 16, kind: 'ATTACHMENT', originalName: 'source.zip', mimeType: 'application/zip', sizeBytes: 2048, downloadUrl: 'https://api.example.test/api/assets/16/download?variant=original' },
		]);
		expect(JSON.stringify(detail)).not.toMatch(/storageKey|webglEntryKey|\/api\/public\/(images|assets|webgl)/);
	});

	it('fails closed instead of inventing a public URL for a missing canonical original', () => {
		const serialize = createProjectSerializer('https://api.example.test', {
			publicAssetOrigin: 'https://assets.example.test',
			publicBucket: 'public',
		}).serializeProjectDetail;
		const malformed = {
			id: 7, title: 'Missing', slug: 'missing', exhibition: { year: 2026 }, summary: '', description: '',
			githubUrl: '', platforms: [], isIncomplete: false, status: 'PUBLISHED', sortOrder: 0,
			posterAssetId: 13, poster: { id: 13, kind: 'POSTER', status: 'READY', representations: [] },
			members: [], assets: [],
		} as SerializableProject;
		const detail = serialize(malformed);
		expect(detail.poster).toBeUndefined();
		expect(detail.attachments).toEqual([]);
		expect(JSON.stringify(detail)).not.toContain('/api/public/images/');
	});
});
