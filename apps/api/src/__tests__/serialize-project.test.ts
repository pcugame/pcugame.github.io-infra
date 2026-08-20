import { describe, it, expect } from 'vitest';
import { createProjectSerializer } from '../modules/admin/project/serializer.js';

const { protectedAssetUrl, serializeProjectDetail } = createProjectSerializer(
	'https://api.example.com',
	'https://assets.example.com',
);

// ── Helpers ─────────────────────────────────────────────────

function fakeProject(overrides: Record<string, unknown> = {}) {
	return {
		id: 1,
		title: 'Test Project',
		slug: 'test-project',
		exhibition: { year: 2025 },
		summary: 'A summary',
		description: 'A description',
		githubUrl: '',
		platforms: [] as ('PC' | 'MOBILE' | 'WEB')[],
		isIncomplete: false,
		status: 'PUBLISHED' as const,
		sortOrder: 0,
		posterAssetId: null as number | null,
		webglEntryKey: '',
		poster: null as { storageKey: string; kind: 'POSTER' | 'IMAGE' | 'THUMBNAIL' | 'GAME' | 'VIDEO'; status: string } | null,
		members: [] as { id: number; name: string; studentId: string; sortOrder: number; userId: number | null }[],
		assets: [] as {
			id: number;
			kind: 'POSTER' | 'IMAGE' | 'THUMBNAIL' | 'GAME' | 'VIDEO';
			storageKey: string;
			playbackStorageKey: string | null;
			originalName: string;
			mimeType: string;
			playbackMimeType: string;
			sizeBytes: bigint;
			width?: number | null;
			height?: number | null;
			card480Height?: number | null;
			display960Height?: number | null;
			playbackSizeBytes: bigint;
			playbackStatus: 'PENDING' | 'READY' | 'FAILED';
			playbackError: string;
		}[],
		...overrides,
	};
}

function fakeAsset(overrides: Partial<ReturnType<typeof fakeProject>['assets'][number]> = {}) {
	return {
		id: 1,
		kind: 'IMAGE' as const,
		storageKey: 'img.png',
		playbackStorageKey: null,
		originalName: 'photo.png',
		mimeType: 'image/png',
		playbackMimeType: '',
		sizeBytes: 12345n,
		playbackSizeBytes: 0n,
		playbackStatus: 'PENDING' as const,
		playbackError: '',
		...overrides,
	};
}

// ── protectedAssetUrl ───────────────────────────────────────

describe('protectedAssetUrl', () => {
	it('returns a protected asset URL', () => {
		expect(protectedAssetUrl(42)).toBe('https://api.example.com/api/assets/42/download?variant=original');
	});

	it('keeps VIDEO downloads on the protected route', () => {
		expect(protectedAssetUrl(43, 'playback')).toBe('https://api.example.com/api/assets/43/download?variant=playback');
	});
});

// ── serializeProjectDetail ──────────────────────────────────

describe('serializeProjectDetail', () => {
	it('maps all basic fields correctly', () => {
		const result = serializeProjectDetail(fakeProject());
		expect(result.id).toBe(1);
		expect(result.title).toBe('Test Project');
		expect(result.slug).toBe('test-project');
		expect(result.year).toBe(2025);
		expect(result.isIncomplete).toBe(false);
		expect(result.status).toBe('PUBLISHED');
		expect(result.sortOrder).toBe(0);
	});

	it('returns poster as undefined when poster is null', () => {
		const result = serializeProjectDetail(fakeProject({ poster: null }));
		expect(result.poster).toBeUndefined();
	});

	it('returns poster as undefined when poster kind is GAME', () => {
		const result = serializeProjectDetail(fakeProject({
			poster: { storageKey: 'g.zip', kind: 'GAME', status: 'READY' },
		}));
		expect(result.poster).toBeUndefined();
	});

	it('returns a responsive image when poster is READY IMAGE', () => {
		const result = serializeProjectDetail(fakeProject({
			poster: { storageKey: 'img.png', kind: 'IMAGE', status: 'READY' },
		}));
		expect(result.poster).toEqual({
			original: { url: 'https://assets.example.com/img.png' },
			renditions: [],
		});
	});

	it('converts empty summary and description to undefined', () => {
		const result = serializeProjectDetail(fakeProject({ summary: '', description: '' }));
		expect(result.summary).toBeUndefined();
		expect(result.description).toBeUndefined();
	});

	it('converts posterAssetId null to undefined', () => {
		const result = serializeProjectDetail(fakeProject({ posterAssetId: null }));
		expect(result.posterAssetId).toBeUndefined();
	});

	it('exposes WebGL URL only when an active entry key exists', () => {
		expect(serializeProjectDetail(fakeProject()).webglUrl).toBeUndefined();
		expect(serializeProjectDetail(fakeProject({ webglEntryKey: 'webgl/1/not-a-deployment/site/index.html' })).webglUrl)
			.toBeUndefined();
		const result = serializeProjectDetail(fakeProject({
			webglEntryKey: 'webgl/1/123e4567-e89b-42d3-a456-426614174000/site/index.html',
		}));
		expect(result.webglUrl).toBe(
			'https://assets.example.com/webgl/1/123e4567-e89b-42d3-a456-426614174000/site/index.html',
		);
	});

	it('preserves posterAssetId when set', () => {
		const result = serializeProjectDetail(fakeProject({ posterAssetId: 42 }));
		expect(result.posterAssetId).toBe(42);
	});

	it('converts sizeBytes bigint to number in assets', () => {
		const result = serializeProjectDetail(fakeProject({
			assets: [fakeAsset()],
		}));
		expect(result.assets[0]!.size).toBe(12345);
		expect(typeof result.assets[0]!.size).toBe('number');
	});

	it('serializes admin image assets from deterministic rendition readiness', () => {
		const result = serializeProjectDetail(fakeProject({
			assets: [fakeAsset({
				width: 1200,
				height: 800,
				card480Height: null,
				display960Height: 640,
			})],
		}));
		expect(result.assets[0]).toEqual({
			id: 1,
			kind: 'IMAGE',
			image: {
				original: {
					url: 'https://assets.example.com/img.png',
					width: 1200,
					height: 800,
				},
				renditions: [{
					profile: 'DISPLAY_960',
					url: 'https://assets.example.com/img.png/__pcu_image_rendition__/v1/display-960.webp',
					width: 960,
					height: 640,
				}],
			},
			originalName: 'photo.png',
			size: 12345,
		});
	});

	it('returns video as null when no VIDEO asset exists', () => {
		const result = serializeProjectDetail(fakeProject({ assets: [] }));
		expect(result.video).toBeNull();
		expect(result.videos).toEqual([]);
	});

	it('returns video object when VIDEO asset exists', () => {
		const result = serializeProjectDetail(fakeProject({
			assets: [fakeAsset({
				id: 2,
				kind: 'VIDEO',
				storageKey: 'vid.mp4',
				originalName: 'demo.mp4',
				mimeType: 'video/mp4',
				sizeBytes: 99999n,
				playbackStatus: 'READY',
			})],
		}));
		expect(result.video).toEqual({
			url: 'https://api.example.com/api/assets/2/download?variant=playback',
			mimeType: 'video/mp4',
			originalDownloadUrl: 'https://api.example.com/api/assets/2/download?variant=original',
			playbackStatus: 'READY',
			playbackError: undefined,
		});
		expect(result.videos).toHaveLength(1);
	});

	it('returns videos in asset order and preserves video as the first item', () => {
		const result = serializeProjectDetail(fakeProject({
			assets: [
				fakeAsset({
					id: 2,
					kind: 'VIDEO',
					storageKey: 'first.mp4',
					originalName: 'first.mp4',
					mimeType: 'video/mp4',
					sizeBytes: 2n,
					playbackStatus: 'READY',
				}),
				fakeAsset({
					id: 3,
					kind: 'VIDEO',
					storageKey: 'second.mov',
					playbackStorageKey: 'second-playback.mp4',
					originalName: 'second.mov',
					mimeType: 'video/quicktime',
					playbackMimeType: 'video/mp4',
					sizeBytes: 3n,
					playbackStatus: 'READY',
				}),
			],
		}));

		expect(result.video).toBe(result.videos[0]);
		expect(result.videos.map((v) => v.url)).toEqual([
			'https://api.example.com/api/assets/2/download?variant=playback',
			'https://api.example.com/api/assets/3/download?variant=playback',
		]);
	});

	it('returns playback URL for admin video preview when playback file exists', () => {
		const result = serializeProjectDetail(fakeProject({
			assets: [fakeAsset({
				id: 2,
				kind: 'VIDEO',
				storageKey: 'original.mov',
				playbackStorageKey: 'playback.mp4',
				originalName: 'demo.mov',
				mimeType: 'video/quicktime',
				playbackMimeType: 'video/mp4',
				sizeBytes: 99999n,
				playbackSizeBytes: 12345n,
				playbackStatus: 'READY',
			})],
		}));

		expect(result.video).toMatchObject({
			url: 'https://api.example.com/api/assets/2/download?variant=playback',
			mimeType: 'video/mp4',
			originalDownloadUrl: 'https://api.example.com/api/assets/2/download?variant=original',
			playbackStatus: 'READY',
		});
		expect(result.assets[0]).toMatchObject({
			url: 'https://api.example.com/api/assets/2/download?variant=playback',
			playbackUrl: 'https://api.example.com/api/assets/2/download?variant=playback',
			originalDownloadUrl: 'https://api.example.com/api/assets/2/download?variant=original',
		});
	});

	it('defaults video mimeType to video/mp4 when empty', () => {
		const result = serializeProjectDetail(fakeProject({
			assets: [fakeAsset({
				id: 2,
				kind: 'VIDEO',
				storageKey: 'vid.webm',
				originalName: 'demo.webm',
				mimeType: '',
				sizeBytes: 50000n,
			})],
		}));
		expect(result.video!.mimeType).toBe('video/mp4');
	});

	it('effectively clears isIncomplete when project has GAME + VIDEO + valid poster', () => {
		const result = serializeProjectDetail(fakeProject({
			isIncomplete: true,
			poster: { storageKey: 'p.png', kind: 'POSTER', status: 'READY' },
			assets: [
				fakeAsset({ id: 1, kind: 'GAME', storageKey: 'g.zip', originalName: 'g.zip', mimeType: 'application/zip', sizeBytes: 1n }),
				fakeAsset({ id: 2, kind: 'VIDEO', storageKey: 'v.mp4', originalName: 'v.mp4', mimeType: 'video/mp4', sizeBytes: 2n }),
				fakeAsset({ id: 3, kind: 'POSTER', storageKey: 'p.png', originalName: 'p.png', mimeType: 'image/png', sizeBytes: 3n }),
			],
		}));
		expect(result.isIncomplete).toBe(false);
	});

	it('keeps isIncomplete=true when project is missing the game asset', () => {
		const result = serializeProjectDetail(fakeProject({
			isIncomplete: true,
			poster: { storageKey: 'p.png', kind: 'POSTER', status: 'READY' },
			assets: [
				fakeAsset({ id: 2, kind: 'VIDEO', storageKey: 'v.mp4', originalName: 'v.mp4', mimeType: 'video/mp4', sizeBytes: 2n }),
			],
		}));
		expect(result.isIncomplete).toBe(true);
	});

	it('keeps isIncomplete=true when poster is not url-safe', () => {
		const result = serializeProjectDetail(fakeProject({
			isIncomplete: true,
			poster: { storageKey: 'g.zip', kind: 'GAME', status: 'READY' },
			assets: [
				fakeAsset({ id: 1, kind: 'GAME', storageKey: 'g.zip', originalName: 'g.zip', mimeType: 'application/zip', sizeBytes: 1n }),
				fakeAsset({ id: 2, kind: 'VIDEO', storageKey: 'v.mp4', originalName: 'v.mp4', mimeType: 'video/mp4', sizeBytes: 2n }),
			],
		}));
		expect(result.isIncomplete).toBe(true);
	});

	it('maps members correctly', () => {
		const result = serializeProjectDetail(fakeProject({
			members: [
				{ id: 1, name: '홍길동', studentId: '20251234', sortOrder: 0, userId: null },
				{ id: 2, name: 'John', studentId: '20259999', sortOrder: 1, userId: 5 },
			],
		}));
		expect(result.members).toHaveLength(2);
		expect(result.members[0]).toEqual({
			id: 1, name: '홍길동', studentId: '20251234', sortOrder: 0, userId: null,
		});
		expect(result.members[1]!.userId).toBe(5);
	});
});
