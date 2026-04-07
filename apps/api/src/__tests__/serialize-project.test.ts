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

import { assetUrl, serializeProjectDetail } from '../modules/admin/project/service.js';

// ── Helpers ─────────────────────────────────────────────────

function fakeProject(overrides: Record<string, unknown> = {}) {
	return {
		id: 1,
		title: 'Test Project',
		slug: 'test-project',
		exhibition: { year: 2025 },
		summary: 'A summary',
		description: 'A description',
		isLegacy: false,
		status: 'DRAFT',
		sortOrder: 0,
		posterAssetId: null as number | null,
		poster: null as { storageKey: string; kind: 'POSTER' | 'IMAGE' | 'THUMBNAIL' | 'GAME' | 'VIDEO'; status: string } | null,
		members: [] as { id: number; name: string; studentId: string; sortOrder: number; userId: number | null }[],
		assets: [] as { id: number; kind: 'POSTER' | 'IMAGE' | 'THUMBNAIL' | 'GAME' | 'VIDEO'; storageKey: string; originalName: string; mimeType: string; sizeBytes: bigint }[],
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

// ── serializeProjectDetail ──────────────────────────────────

describe('serializeProjectDetail', () => {
	it('maps all basic fields correctly', () => {
		const result = serializeProjectDetail(fakeProject());
		expect(result.id).toBe(1);
		expect(result.title).toBe('Test Project');
		expect(result.slug).toBe('test-project');
		expect(result.year).toBe(2025);
		expect(result.isLegacy).toBe(false);
		expect(result.status).toBe('DRAFT');
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
			assets: [{
				id: 1,
				kind: 'IMAGE',
				storageKey: 'img.png',
				originalName: 'photo.png',
				mimeType: 'image/png',
				sizeBytes: 12345n,
			}],
		}));
		expect(result.assets[0]!.size).toBe(12345);
		expect(typeof result.assets[0]!.size).toBe('number');
	});

	it('returns video as null when no VIDEO asset exists', () => {
		const result = serializeProjectDetail(fakeProject({ assets: [] }));
		expect(result.video).toBeNull();
	});

	it('returns video object when VIDEO asset exists', () => {
		const result = serializeProjectDetail(fakeProject({
			assets: [{
				id: 2,
				kind: 'VIDEO',
				storageKey: 'vid.mp4',
				originalName: 'demo.mp4',
				mimeType: 'video/mp4',
				sizeBytes: 99999n,
			}],
		}));
		expect(result.video).toEqual({
			url: 'https://api.example.com/api/assets/protected/vid.mp4',
			mimeType: 'video/mp4',
		});
	});

	it('defaults video mimeType to video/mp4 when empty', () => {
		const result = serializeProjectDetail(fakeProject({
			assets: [{
				id: 2,
				kind: 'VIDEO',
				storageKey: 'vid.webm',
				originalName: 'demo.webm',
				mimeType: '',
				sizeBytes: 50000n,
			}],
		}));
		expect(result.video!.mimeType).toBe('video/mp4');
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
