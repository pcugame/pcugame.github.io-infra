import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type {
	AdminProjectDetail,
	AdminProjectListResponse,
	BannedIpListResponse,
	ExportResult,
	ExportStatusResponse,
	GameUploadChunkResponse,
	GameUploadCompleteResponse,
	GameUploadSession,
	GameUploadSessionListResponse,
	GameUploadStatus,
	GoogleAuthResponse,
	ImportExecuteResult,
	ImportPreviewResult,
	LogoutResponse,
	MeResponse,
	PublicExhibitionProjectsResponse,
	PublicProjectDetailResponse,
	PublicYearListResponse,
	PublicYearProjectsResponse,
	SiteSettingsData,
	SubmitProjectResponse,
} from './index.js';
import {
	AdminProjectDetailSchema,
	AdminProjectListResponseSchema,
	ApiErrorResponseSchema,
	BannedIpListResponseSchema,
	ExportResultSchema,
	ExportStatusResponseSchema,
	GameUploadChunkResponseSchema,
	GameUploadCompleteResponseSchema,
	GameUploadCompletionResponseSchema,
	GameUploadPartUrlsResponseSchema,
	GameUploadSessionListResponseSchema,
	GameUploadSessionSchema,
	GameUploadStatusSchema,
	GoogleAuthResponseSchema,
	ImportExecuteResultSchema,
	ImportPreviewResultSchema,
	LogoutResponseSchema,
	MeResponseSchema,
	PublicExhibitionProjectsResponseSchema,
	PublicProjectDetailResponseSchema,
	PublicYearListResponseSchema,
	PublicYearProjectsResponseSchema,
	ProjectAssetUploadResponseSchema,
	ResponsiveImageSchema,
	SiteSettingsDataSchema,
	SubmitProjectResponseSchema,
	apiSuccessSchema,
} from './response-schemas.js';

const responsiveImage = {
	original: {
		url: 'https://api.example.test/api/public/images/original.webp',
		width: 1200,
		height: 1680,
	},
	renditions: [
		{
			profile: 'CARD_480' as const,
			url: 'https://api.example.test/api/public/images/card.webp',
			width: 480,
			height: 672,
		},
		{
			profile: 'DISPLAY_960' as const,
			url: 'https://api.example.test/api/public/images/display.webp',
			width: 960,
			height: 1344,
		},
	],
};

type IsAssignable<A, B> = A extends B ? true : false;

const runtimeSchemasMatchTransportTypes: [
	IsAssignable<z.output<typeof GoogleAuthResponseSchema>, GoogleAuthResponse>,
	IsAssignable<z.output<typeof LogoutResponseSchema>, LogoutResponse>,
	IsAssignable<z.output<typeof MeResponseSchema>, MeResponse>,
	IsAssignable<z.output<typeof PublicYearListResponseSchema>, PublicYearListResponse>,
	IsAssignable<z.output<typeof PublicYearProjectsResponseSchema>, PublicYearProjectsResponse>,
	IsAssignable<
		z.output<typeof PublicExhibitionProjectsResponseSchema>,
		PublicExhibitionProjectsResponse
	>,
	IsAssignable<z.output<typeof PublicProjectDetailResponseSchema>, PublicProjectDetailResponse>,
	IsAssignable<z.output<typeof AdminProjectListResponseSchema>, AdminProjectListResponse>,
	IsAssignable<z.output<typeof AdminProjectDetailSchema>, AdminProjectDetail>,
	IsAssignable<z.output<typeof SubmitProjectResponseSchema>, SubmitProjectResponse>,
	IsAssignable<z.output<typeof SiteSettingsDataSchema>, SiteSettingsData>,
	IsAssignable<z.output<typeof BannedIpListResponseSchema>, BannedIpListResponse>,
	IsAssignable<z.output<typeof ImportPreviewResultSchema>, ImportPreviewResult>,
	IsAssignable<z.output<typeof ImportExecuteResultSchema>, ImportExecuteResult>,
	IsAssignable<z.output<typeof ExportStatusResponseSchema>, ExportStatusResponse>,
	IsAssignable<z.output<typeof ExportResultSchema>, ExportResult>,
	IsAssignable<z.output<typeof GameUploadSessionSchema>, GameUploadSession>,
	IsAssignable<z.output<typeof GameUploadStatusSchema>, GameUploadStatus>,
	IsAssignable<z.output<typeof GameUploadSessionListResponseSchema>, GameUploadSessionListResponse>,
	IsAssignable<z.output<typeof GameUploadChunkResponseSchema>, GameUploadChunkResponse>,
	IsAssignable<z.output<typeof GameUploadCompleteResponseSchema>, GameUploadCompleteResponse>,
] = [
	true, true, true, true, true, true, true, true, true, true, true,
	true, true, true, true, true, true, true, true, true, true,
];

describe('response runtime schemas', () => {
	it('stays assignable to every shared transport response type', () => {
		expect(runtimeSchemasMatchTransportTypes.every(Boolean)).toBe(true);
	});

	it('keeps old upload responses valid while accepting direct transport fields', () => {
		const legacyShape = {
			sessionId: 'session-1',
			chunkSizeBytes: 5 * 1024 * 1024,
			totalChunks: 1,
			expiresAt: '2026-08-20T01:00:00.000Z',
			uploadKind: 'GAME' as const,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1' as const,
			sourceIdentity: 'a'.repeat(64),
			sourceIdentityBlockSizeBytes: 1048576 as const,
		};
		expect(GameUploadSessionSchema.parse(legacyShape)).not.toHaveProperty('transport');
		expect(GameUploadSessionSchema.parse({
			...legacyShape,
			transport: 'DIRECT_MULTIPART',
			generation: 1,
		})).toMatchObject({ transport: 'DIRECT_MULTIPART', generation: 1 });
	});

	it('accepts representative auth, public, admin, and upload responses', () => {
		expect(GoogleAuthResponseSchema.parse({
			user: {
				id: 1,
				email: 'student@g.pcu.ac.kr',
				name: 'Student',
				role: 'USER',
				studentId: '20260001',
			},
		})).toMatchObject({ user: { id: 1, role: 'USER' } });

		expect(PublicYearListResponseSchema.parse({
			items: [{
				id: 1,
				year: 2026,
				title: '2026 전시',
				projectCount: 0,
				poster: responsiveImage,
			}],
		}).items).toHaveLength(1);

		expect(AdminProjectListResponseSchema.parse({
			items: [{
				id: 1,
				title: 'Game',
				slug: 'game',
				year: 2026,
				isIncomplete: false,
				status: 'PUBLISHED',
				memberNames: ['Student'],
				memberStudentIds: ['20260001'],
				updatedAt: '2026-07-31T00:00:00.000Z',
			}],
			pagination: {
				page: 1,
				limit: 20,
				totalItems: 1,
				totalPages: 1,
				hasNextPage: false,
				hasPreviousPage: false,
			},
		}).items[0]?.status).toBe('PUBLISHED');

		expect(GameUploadCompleteResponseSchema.parse({
			status: 'COMPLETED',
			storageKey: 'games/1/game.zip',
			sizeBytes: 1,
		})).toMatchObject({ status: 'COMPLETED' });

		expect(GameUploadPartUrlsResponseSchema.parse({
			generation: 1,
			expiresAt: '2026-08-20T00:05:00.000Z',
			parts: [{
				partNumber: 1,
				url: 'https://garage.example.test/object?signature=secret',
				requiredHeaders: { 'content-type': 'application/octet-stream' },
			}],
		})).toMatchObject({ generation: 1, parts: [{ partNumber: 1 }] });

		expect(GameUploadCompletionResponseSchema.parse({
			status: 'VERIFYING',
			sessionId: 'session-1',
			generation: 1,
			sizeBytes: 1,
		})).toMatchObject({ status: 'VERIFYING' });

		expect(PublicProjectDetailResponseSchema.parse({
			id: 1,
			year: 2026,
			slug: 'legacy-link',
			title: 'Legacy Link',
			githubUrl: 'github.com/legacy/project',
			platforms: [],
			isIncomplete: false,
			video: null,
			videos: [],
			members: [],
			images: [],
			status: 'PUBLISHED',
		}).githubUrl).toBe('github.com/legacy/project');

		expect(ResponsiveImageSchema.parse({
			original: { url: 'https://api.example.test/api/public/images/legacy.webp' },
			renditions: [],
		})).toEqual({
			original: { url: 'https://api.example.test/api/public/images/legacy.webp' },
			renditions: [],
		});

		expect(ProjectAssetUploadResponseSchema.parse({ assetId: 7 })).toEqual({ assetId: 7 });
		expect(ProjectAssetUploadResponseSchema.safeParse({
			assetId: 7,
			url: 'https://api.example.test/api/public/images/uploaded.webp',
		}).success).toBe(false);

		expect(ExportStatusResponseSchema.parse({
			running: true,
			progress: {
				year: 2026,
				startedAt: 1,
				phase: 'downloading',
				totalProjects: 1,
				currentProjectIndex: 0,
				currentProjectTitle: 'WebGL',
				currentProjectFiles: [{
					assetId: -7,
					kind: 'WEBGL',
					originalName: 'webgl.zip',
					fileName: 'webgl/webgl.zip',
					status: 'saving',
				}],
				totalFiles: 1,
				downloaded: 0,
				skipped: 0,
				failed: 0,
			},
		}).progress?.currentProjectFiles[0]?.assetId).toBe(-7);
	});

	it('validates the success/error envelopes and rejects non-JSON error details', () => {
		const success = apiSuccessSchema(SiteSettingsDataSchema);
		expect(success.parse({
			ok: true,
			data: { maxGameFileMb: 5120, maxChunkSizeMb: 10 },
		})).toEqual({
			ok: true,
			data: { maxGameFileMb: 5120, maxChunkSizeMb: 10 },
		});
		expect(success.safeParse({
			ok: true,
			data: { maxGameFileMb: 5120, maxChunkSizeMb: 4 },
		}).success).toBe(false);

		expect(ApiErrorResponseSchema.parse({
			ok: false,
			error: {
				code: 'VALIDATION_ERROR',
				message: 'Validation failed',
				details: { field: ['invalid'] },
			},
		})).toMatchObject({ ok: false });

		expect(ApiErrorResponseSchema.safeParse({
			ok: false,
			error: {
				code: 'INTERNAL_ERROR',
				message: 'failed',
				details: 1n,
			},
		}).success).toBe(false);
		expect(ApiErrorResponseSchema.safeParse({
			ok: false,
			error: {
				code: 'projects.0.year: invalid',
				message: 'Validation failed',
			},
		}).success).toBe(false);
	});

	it('uses one responsive image schema across public and admin image responses', () => {
		const adminDetail = AdminProjectDetailSchema.parse({
			id: 1,
			title: 'Responsive project',
			slug: 'responsive-project',
			year: 2026,
			platforms: ['WEB'],
			isIncomplete: false,
			video: null,
			videos: [],
			status: 'PUBLISHED',
			sortOrder: 0,
			poster: responsiveImage,
			members: [],
			assets: [
				{
					id: 10,
					kind: 'IMAGE',
					image: responsiveImage,
					originalName: 'image.webp',
					size: 123,
				},
				{
					id: 11,
					kind: 'VIDEO',
					url: 'https://api.example.test/api/assets/11/download?variant=playback',
					originalName: 'video.mp4',
					size: 456,
				},
			],
		});

		expect(adminDetail.assets[0]).toMatchObject({ kind: 'IMAGE', image: responsiveImage });
		expect(adminDetail.assets[1]).toMatchObject({ kind: 'VIDEO' });
		expect(AdminProjectDetailSchema.safeParse({
			...adminDetail,
			assets: [{
				id: 10,
				kind: 'IMAGE',
				url: responsiveImage.original.url,
				originalName: 'legacy.webp',
				size: 1,
			}],
		}).success).toBe(false);
		expect(ResponsiveImageSchema.safeParse({
			original: { url: responsiveImage.original.url },
			renditions: [{
				profile: 'UNKNOWN',
				url: responsiveImage.renditions[0]?.url,
				width: 480,
				height: 672,
			}],
		}).success).toBe(false);
	});

	it('rejects shape drift, unsafe integers, invalid years, and extra response fields', () => {
		expect(PublicYearListResponseSchema.safeParse({
			items: [{ id: 1, year: 2026, projectCount: 0, unexpected: true }],
		}).success).toBe(false);
		expect(PublicYearListResponseSchema.safeParse({
			items: [{ id: Number.MAX_SAFE_INTEGER + 1, year: 2026, projectCount: 0 }],
		}).success).toBe(false);
		expect(PublicYearListResponseSchema.safeParse({
			items: [{ id: 1, year: 2026.5, projectCount: 0 }],
		}).success).toBe(false);
		expect(GameUploadChunkResponseSchema.safeParse({
			index: -1,
			bytesWritten: 1,
			uploadedCount: 1,
			totalChunks: 1,
		}).success).toBe(false);
		expect(ExportStatusResponseSchema.safeParse({
			running: true,
			progress: {
				year: 2026,
				startedAt: 1,
				phase: 'downloading',
				totalProjects: 1,
				currentProjectIndex: 0,
				currentProjectTitle: 'WebGL',
				currentProjectFiles: [{
					assetId: 0,
					kind: 'WEBGL',
					originalName: 'webgl.zip',
					fileName: 'webgl/webgl.zip',
					status: 'saving',
				}],
				totalFiles: 1,
				downloaded: 0,
				skipped: 0,
				failed: 0,
			},
		}).success).toBe(false);
	});
});
