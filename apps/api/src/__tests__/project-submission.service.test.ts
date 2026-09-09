import { describe, expect, it, vi } from 'vitest';
import type { ProjectSubmissionRecord, SubmitProjectRepository } from '../modules/admin/project/ports.js';
import { createSubmitProjectService } from '../modules/admin/project/project-submit.service.js';

function submission(overrides: Partial<ProjectSubmissionRecord> = {}): ProjectSubmissionRecord {
	return {
		id: '11111111-1111-4111-8111-111111111111',
		projectId: 41,
		actorId: 7,
		state: 'PENDING',
		project: { id: 41, status: 'DRAFT' },
		items: [{
			id: '22222222-2222-4222-8222-222222222222',
			kind: 'GAME',
			slot: 'game',
			clientToken: 'a'.repeat(32),
			required: true,
			state: 'EXPECTED',
			boundGeneration: null,
			failureReason: null,
			playbackState: 'NONE',
			playbackError: null,
			uploadSession: null,
		}],
		publicationJob: null,
		...overrides,
	};
}

function repository(record = submission()) {
	const repo: SubmitProjectRepository = {
		findExhibitionById: vi.fn(async () => ({ id: 3, year: 2026, title: '2026', isModificationEnabled: true })),
		findProjectByExhibitionAndSlug: vi.fn(async () => null),
		createProjectWithAssets: vi.fn(async () => ({ id: 41, slug: 'project', submission: record })),
		findSubmissionForActor: vi.fn(async () => record),
		finalizeSubmission: vi.fn(async (): Promise<ProjectSubmissionRecord> => ({
			...record,
			state: 'PUBLISHED',
			project: { id: record.projectId, status: 'PUBLISHED' },
		})),
		cancelSubmission: vi.fn(async (): Promise<ProjectSubmissionRecord> => ({
			...record,
			state: 'CANCELLED',
		})),
		auditActiveSubmissions: vi.fn(async () => ({ draftProjects: 1, pendingSubmissions: 1, finalizingSubmissions: 0, activePublicationJobs: 0 })),
	};
	return repo;
}

const actor = { id: 7, role: 'ADMIN' };
const payload = {
	exhibitionId: 3,
	title: 'Project',
	summary: '',
	description: '',
	members: [{ name: 'Student', studentId: '20260001' }],
	manifest: [{ kind: 'GAME' as const, slot: 'game', clientToken: 'a'.repeat(32), required: true }],
};

describe('durable project submission service', () => {
	it.each([
		['video:1'], ['video:0', 'video:2'], ['video:00'],
		['video:0', 'video:1', 'video:2', 'video:3', 'video:4', 'video:5'],
	])('rejects nonconsecutive or excessive video slots %j', async (...slots) => {
		const repo = repository();
		const service = createSubmitProjectService({ webPublicUrl: 'https://example.test', repository: repo });
		await expect(service.submitProject({ actor, payload: {
			...payload,
			manifest: slots.map((slot, index) => ({ kind: 'VIDEO', slot, clientToken: String(index).repeat(32), required: true })),
		} }, { audience: 'admin' })).rejects.toMatchObject({ statusCode: 400 });
		expect(repo.createProjectWithAssets).not.toHaveBeenCalled();
	});

	it('accepts five consecutive video slots independent of manifest array order', async () => {
		const repo = repository();
		const service = createSubmitProjectService({ webPublicUrl: 'https://example.test', repository: repo });
		await service.submitProject({ actor, payload: { ...payload,
			manifest: [4, 2, 0, 3, 1].map((index) => ({ kind: 'VIDEO', slot: `video:${index}`, clientToken: String(index).repeat(32), required: true })),
		} }, { audience: 'admin' });
		expect(repo.createProjectWithAssets).toHaveBeenCalledOnce();
	});

	it.each([{ kind: 'VIDEO', slot: 'image:0' }, { kind: 'IMAGE', slot: 'video:0' }])('rejects a mismatched video kind/slot $kind $slot', async (item) => {
		const repo = repository();
		const service = createSubmitProjectService({ webPublicUrl: 'https://example.test', repository: repo });
		await expect(service.submitProject({ actor, payload: { ...payload,
			manifest: [{ ...item, clientToken: 'x'.repeat(32), required: true }],
		} }, { audience: 'admin' })).rejects.toMatchObject({ statusCode: 400 });
		expect(repo.createProjectWithAssets).not.toHaveBeenCalled();
	});

	it('creates DRAFT metadata and its expected upload manifest atomically', async () => {
		const repo = repository();
		const service = createSubmitProjectService({ webPublicUrl: 'https://example.test', repository: repo });

		await expect(service.submitProject({ actor, payload }, { audience: 'admin' })).resolves.toEqual({
			id: 41,
			slug: 'project',
			year: 2026,
			status: 'DRAFT',
			submissionId: '11111111-1111-4111-8111-111111111111',
			items: [expect.objectContaining({ kind: 'GAME', slot: 'game', state: 'EXPECTED' })],
			adminEditUrl: 'https://example.test/admin/projects/41/edit',
		});
		expect(repo.createProjectWithAssets).toHaveBeenCalledWith(expect.objectContaining({
			status: 'DRAFT',
			manifest: payload.manifest,
		}));
		expect(repo.finalizeSubmission).not.toHaveBeenCalled();
	});

	it('rejects duplicate manifest slots or client tokens before creating a project', async () => {
		const repo = repository();
		const service = createSubmitProjectService({ webPublicUrl: 'https://example.test', repository: repo });
		await expect(service.submitProject({
			actor,
			payload: {
				...payload,
				manifest: [
					payload.manifest[0],
					{ kind: 'GAME', slot: 'game', clientToken: 'b'.repeat(32), required: true },
				],
			},
		}, { audience: 'admin' })).rejects.toMatchObject({ statusCode: 400 });
		expect(repo.createProjectWithAssets).not.toHaveBeenCalled();
	});

	it('rejects optional manifest items before any project row is created', async () => {
		const repo = repository();
		const service = createSubmitProjectService({ webPublicUrl: 'https://example.test', repository: repo });
		await expect(service.submitProject({
			actor,
			payload: {
				...payload,
				manifest: [{ ...payload.manifest[0], required: false }],
			},
		}, { audience: 'admin' })).rejects.toMatchObject({ statusCode: 400 });
		expect(repo.createProjectWithAssets).not.toHaveBeenCalled();
	});

	it('returns durable status and delegates finalize/cancel without accepting bytes', async () => {
		const resumable = submission({
			items: [{
				...submission().items[0]!,
				state: 'UPLOADING',
				boundGeneration: 3,
				uploadSession: { id: '33333333-3333-4333-8333-333333333333', generation: 3 },
			}],
		});
		const repo = repository(resumable);
		const service = createSubmitProjectService({ webPublicUrl: 'https://example.test', repository: repo });
		await expect(service.status(actor, 41)).resolves.toMatchObject({
			projectStatus: 'DRAFT',
			state: 'PENDING',
			items: [{
				state: 'UPLOADING',
				sessionId: '33333333-3333-4333-8333-333333333333',
				generation: 3,
			}],
		});
		await expect(service.finalize(actor, 41)).resolves.toMatchObject({ projectStatus: 'PUBLISHED', state: 'PUBLISHED' });
		await expect(service.cancel(actor, 41)).resolves.toMatchObject({ state: 'CANCELLED' });
	});
});
