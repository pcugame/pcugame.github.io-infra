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
	SiteSettingsDataSchema,
	SubmitProjectResponseSchema,
	apiSuccessSchema,
} from './response-schemas.js';

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
				posterUrl: 'https://api.example.test/poster',
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
