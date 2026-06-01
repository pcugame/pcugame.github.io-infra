import { describe, it, expect, vi } from 'vitest';

// Mock all transitive dependencies that call env() at module load time
vi.mock('../config/env.js', () => ({
	env: () => ({
		API_PUBLIC_URL: 'https://api.example.com',
		LOG_LEVEL: 'silent',
		NODE_ENV: 'test',
	}),
	loadEnv: () => ({
		API_PUBLIC_URL: 'https://api.example.com',
		LOG_LEVEL: 'silent',
		NODE_ENV: 'test',
	}),
}));

vi.mock('../lib/s3.js', () => ({
	s3: () => ({}),
	bucketForKind: () => 'test-bucket',
}));

vi.mock('../lib/storage.js', () => ({
	deleteObject: vi.fn(),
	uploadObject: vi.fn(),
}));

vi.mock('../../assets/upload/index.js', () => ({
	UploadPipeline: vi.fn(),
}));

vi.mock('./repository.js', () => ({}));

import { assetUrl, isReplaceableAssetKind, serializeProjectDetail } from '../modules/admin/project/service.js';

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

// ── assetUrl ────────────────────────────────────────────────

describe('assetUrl', () => {
	it('returns protected URL for GAME kind', () => {
		expect(assetUrl('abc.zip', 'GAME')).toBe('https://api.example.com/api/assets/protected/abc.zip');
	});

	it('returns protected URL for VIDEO kind', () => {
		expect(assetUrl('vid.mp4', 'VIDEO')).toBe('https://api.example.com/api/assets/protected/vid.mp4');
	});

	it('returns public URL for IMAGE kind', () => {
		expect(assetUrl('img.png', 'IMAGE')).toBe('https://api.example.com/api/assets/public/img.png');
	});

	it('returns public URL for POSTER kind', () => {
		expect(assetUrl('poster.jpg', 'POSTER')).toBe('https://api.example.com/api/assets/public/poster.jpg');
	});

	it('returns public URL for THUMBNAIL kind', () => {
		expect(assetUrl('thumb.webp', 'THUMBNAIL')).toBe('https://api.example.com/api/assets/public/thumb.webp');
	});
});

describe('asset replacement policy', () => {
	it('keeps GAME replaceable and lets VIDEO create additional assets', () => {
		expect(isReplaceableAssetKind('GAME')).toBe(true);
		expect(isReplaceableAssetKind('VIDEO')).toBe(false);
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

	it('returns posterUrl as undefined when poster is null', () => {
		const result = serializeProjectDetail(fakeProject({ poster: null }));
		expect(result.posterUrl).toBeUndefined();
	});

	it('returns posterUrl as undefined when poster kind is GAME', () => {
		const result = serializeProjectDetail(fakeProject({
			poster: { storageKey: 'g.zip', kind: 'GAME', status: 'READY' },
		}));
		expect(result.posterUrl).toBeUndefined();
	});

	it('returns posterUrl when poster is READY IMAGE', () => {
		const result = serializeProjectDetail(fakeProject({
			poster: { storageKey: 'img.png', kind: 'IMAGE', status: 'READY' },
		}));
		expect(result.posterUrl).toBe('https://api.example.com/api/assets/public/img.png');
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
			url: 'https://api.example.com/api/assets/protected/vid.mp4',
			mimeType: 'video/mp4',
			originalDownloadUrl: 'https://api.example.com/api/assets/protected/vid.mp4',
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
			'https://api.example.com/api/assets/protected/first.mp4',
			'https://api.example.com/api/assets/protected/second-playback.mp4',
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
			url: 'https://api.example.com/api/assets/protected/playback.mp4',
			mimeType: 'video/mp4',
			originalDownloadUrl: 'https://api.example.com/api/assets/protected/original.mov',
			playbackStatus: 'READY',
		});
		expect(result.assets[0]).toMatchObject({
			url: 'https://api.example.com/api/assets/protected/original.mov',
			playbackUrl: 'https://api.example.com/api/assets/protected/playback.mp4',
			originalDownloadUrl: 'https://api.example.com/api/assets/protected/original.mov',
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
