import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import type { S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppLogger, ObjectStorage, Scheduler } from '../application/ports.js';
import type { Env } from '../config/env.js';
import { createProductionBackendContext } from '../backend-context.js';
import { createCachedSettingsStore } from '../shared/site-settings.js';
import { createAdminRoutes } from '../modules/admin/admin.routes.js';
import { createProjectMemberSettingsProductionGraph } from '../modules/admin/project-member-settings.composition.js';
import { createProjectAccessService } from '../modules/admin/project-access.service.js';
import type { ProjectApplicationRepository } from '../modules/admin/project/ports.js';
import type { MemberServiceDependencies } from '../modules/admin/member/service.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import {
	createTestUploadLifecycleRuntime,
	ownedTestUploadLifecycleResource,
} from './helpers/upload-lifecycle.js';
import { createScriptedBackendPersistence } from './helpers/backend-persistence.js';
import { notFound } from '../shared/errors.js';

const emptyRoute: FastifyPluginAsync = async () => {};
const deployment = '123e4567-e89b-42d3-a456-426614174000';
const logger: AppLogger = {
	child: () => logger,
	trace: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	fatal: vi.fn(),
};

function projectRecord() {
	return {
		id: 7,
		title: 'Context Game',
		slug: 'context-game',
		exhibitionId: 1,
		exhibition: { year: 2026 },
		creatorId: 1,
		creator: { name: 'Owner' },
		summary: 'Summary',
		description: 'Description',
		githubUrl: '',
		platforms: [],
		isIncomplete: false,
		status: 'PUBLISHED' as const,
		sortOrder: 0,
		posterAssetId: null as number | null,
		webglEntryKey: `webgl/7/${deployment}/site/index.html`,
		poster: null as null | { storageKey: string; kind: 'POSTER'; status: string },
		members: [{
			id: 11,
			projectId: 7,
			name: 'Member',
			studentId: '20260001',
			sortOrder: 0,
			userId: 2 as number | null,
		}],
		assets: [{
			id: 21,
			projectId: 7,
			kind: 'POSTER' as const,
			status: 'READY',
			storageKey: 'poster.webp',
			playbackStorageKey: null,
			originalName: 'poster.webp',
			mimeType: 'image/webp',
			playbackMimeType: '',
			sizeBytes: 10n,
			playbackSizeBytes: 0n,
			playbackStatus: 'READY' as const,
			playbackError: '',
		}],
		updatedAt: new Date('2026-07-24T00:00:00.000Z'),
	};
}

function storageHarness() {
	const calls = {
		delete: vi.fn(async () => {}),
		listKeys: vi.fn(async () => [] as string[]),
		listKeyPage: vi.fn(async () => ({ keys: [], isTruncated: false })),
		deleteKeys: vi.fn(async (_bucket, keys) => ({ deleted: [...keys], failures: [] })),
		abortMultipart: vi.fn(async () => {}),
	};
	const storage: ObjectStorage = {
		upload: vi.fn(),
		presign: vi.fn(async () => 'https://storage.test/object'),
		delete: calls.delete,
		head: vi.fn(async () => null),
		readRange: vi.fn(async () => Buffer.alloc(0)),
		stream: vi.fn(async () => null),
		listKeys: calls.listKeys,
		listKeyPage: calls.listKeyPage,
		deleteKeys: calls.deleteKeys,
		createMultipart: vi.fn(async () => 'upload'),
		uploadPart: vi.fn(async () => 'etag'),
		completeMultipart: vi.fn(),
		abortMultipart: calls.abortMultipart,
		listParts: vi.fn(async () => []),
		listMultipartUploads: vi.fn(async () => []),
	};
	return { storage, calls };
}

function portHarness() {
	let project = projectRecord();
	let exists = true;
	let nextMemberId = 30;
	const calls = {
		projectFindMany: vi.fn(() => Promise.resolve(exists ? [project] : [])),
		projectFindUnique: vi.fn((_id?: number) => Promise.resolve(exists ? project : null)),
		projectList: vi.fn(async () => ({
			items: exists ? [project] : [],
			totalItems: exists ? 1 : 0,
		})),
		projectUpdate: vi.fn(async (data: Record<string, unknown>) => {
			Object.assign(project, data);
			return project;
		}),
		projectUpdateMany: vi.fn(async (data: Record<string, unknown>) => {
			Object.assign(project, data);
			return { count: exists ? 1 : 0 };
		}),
		projectDelete: vi.fn(async () => {
			exists = false;
			return project;
		}),
		projectDeleteMany: vi.fn(async () => {
			const count = exists ? 1 : 0;
			exists = false;
			return { count };
		}),
		projectMemberFindFirst: vi.fn(async (where: {
			id?: number;
			projectId?: number;
			userId?: number;
		}) => project.members.find((member) => (
			(where.id === undefined || member.id === where.id)
				&& (where.projectId === undefined || member.projectId === where.projectId)
				&& (where.userId === undefined || member.userId === where.userId)
		)) ?? null),
		memberCreate: vi.fn(async (data: {
			projectId: number;
			name: string;
			studentId: string;
			sortOrder?: number;
		}) => {
			const member = { id: nextMemberId++, userId: null, ...data };
			project.members.push(member as typeof project.members[number]);
			return member;
		}),
		memberUpdate: vi.fn(async (id: number, data: Record<string, unknown>) => {
			const member = project.members.find((value) => value.id === id)!;
			Object.assign(member, data);
			return member;
		}),
		memberDelete: vi.fn(async (id: number) => {
			const member = project.members.find((value) => value.id === id)!;
			project.members = project.members.filter((value) => value.id !== id);
			return member;
		}),
		memberSwap: vi.fn(async (
			memberIdA: number,
			memberIdB: number,
			_projectId?: number,
		) => {
			const a = project.members.find((member) => member.id === memberIdA);
			const b = project.members.find((member) => member.id === memberIdB);
			if (!a || !b) return null;
			[a.sortOrder, b.sortOrder] = [b.sortOrder, a.sortOrder];
			return { a: memberIdA, b: memberIdB };
		}),
		orphanUpsert: vi.fn(async (_outbox?: unknown) => ({})),
		findAssetById: vi.fn(async (id: number) => (
			project.assets.find((asset) => asset.id === id) ?? null
		)),
		setProjectPoster: vi.fn(async (projectId: number, assetId: number) => {
			const asset = await calls.findAssetById(assetId);
			if (!asset) throw notFound('Asset not found');
			project.posterAssetId = assetId;
			return { projectId, assetId };
		}),
		assetDeleteMany: vi.fn(async () => {
			const count = project.assets.length;
			project.assets = [];
			return { count };
		}),
	};
	const repository: ProjectApplicationRepository = {
		findProjectsForUser: calls.projectList,
		findProjectById: calls.projectFindUnique,
		isMemberOfProject: async (projectId, userId) => calls.projectMemberFindFirst({ projectId, userId }),
		updateProject: async (_id, data) => calls.projectUpdate(data),
		async deleteProjectReturningAssets(_id, outbox) {
			await calls.orphanUpsert(outbox);
			const assets = [...project.assets];
			await calls.assetDeleteMany();
			await calls.projectDelete();
			return { assets, webglEntryKey: project.webglEntryKey, activeUploads: [] };
		},
		async clearWebglDeployment(_id, outbox) {
			await calls.orphanUpsert(outbox);
			const oldEntryKey = project.webglEntryKey;
			project.webglEntryKey = '';
			return { oldEntryKey, cancelledSession: null };
		},
		findAssetById: calls.findAssetById,
		setProjectPoster: calls.setProjectPoster,
		async bulkDeleteProjectsReturningAssets(_ids, outbox) {
			await calls.orphanUpsert(outbox);
			const assets = [...project.assets];
			await calls.assetDeleteMany();
			const result = await calls.projectDeleteMany();
			return {
				result,
				assets,
				projects: [{ id: project.id, webglEntryKey: project.webglEntryKey }],
				activeUploads: [],
			};
		},
		bulkUpdateStatus: async (_ids, status) => calls.projectUpdateMany({ status }),
		findExhibitionById: vi.fn(async () => null),
		findProjectByExhibitionAndSlug: vi.fn(async () => null),
		createProjectWithAssets: vi.fn(async () => { throw new Error('not scripted'); }),
		createAsset: vi.fn(async () => { throw new Error('not scripted'); }),
		replaceOrCreateReplaceableAsset: vi.fn(async () => { throw new Error('not scripted'); }),
	};
	const accessRepository = {
		findProject: calls.projectFindUnique,
		isLinkedMember: async (projectId: number, userId: number) => (
			await calls.projectMemberFindFirst({ projectId, userId }) !== null
		),
	};
	const memberRepository: MemberServiceDependencies['repository'] = {
		createMember: calls.memberCreate,
		findMemberInProject: async (memberId, projectId) => (
			calls.projectMemberFindFirst({ id: memberId, projectId })
		),
		updateMember: calls.memberUpdate,
		deleteMember: calls.memberDelete,
		swapMemberOrder: (a, b, projectId) => calls.memberSwap(a, b, projectId),
	};
	return {
		calls,
		repository,
		projectAccess: createProjectAccessService(accessRepository),
		projectExists: async (projectId: number) => await calls.projectFindUnique(projectId) !== null,
		memberRepository,
		getProject: () => project,
	};
}

function settingsHarness(
	initial = { maxGameFileMb: 64, maxChunkSizeMb: 6 },
	options: {
		now?: () => number;
		ttlMs?: number;
	} = {},
) {
	let value = { ...initial };
	const repository = {
		loadOrCreate: vi.fn(async () => ({ ...value })),
		update: vi.fn(async (patch: Partial<typeof value>) => {
			value = { ...value, ...patch };
			return { ...value };
		}),
	};
	return {
		store: createCachedSettingsStore(repository, {
			ttlMs: options.ttlMs ?? 1_000,
			now: options.now,
			delay: vi.fn(async () => {}),
		}),
		repository,
		value: () => ({ ...value }),
		setValue: (next: typeof value) => {
			value = { ...next };
		},
	};
}

function graphHarness(
	label = 'a',
	settingsOptions: Parameters<typeof settingsHarness>[1] = {},
) {
	const ports = portHarness();
	const storage = storageHarness();
	const settings = settingsHarness(label === 'a'
		? { maxGameFileMb: 64, maxChunkSizeMb: 6 }
		: { maxGameFileMb: 32, maxChunkSizeMb: 5 }, settingsOptions);
	const uploadLifecycle = createTestUploadLifecycleRuntime();
	const graph = createProjectMemberSettingsProductionGraph({
		config: {
			API_PUBLIC_URL: `https://api-${label}.test`,
			S3_BUCKET_PUBLIC: `${label}-public`,
			S3_BUCKET_PROTECTED: `${label}-protected`,
			UPLOAD_CHUNK_SIZE_MB: 10,
		},
		projectAccess: ports.projectAccess,
		projectExists: ports.projectExists,
		projectRepository: ports.repository,
		memberRepository: ports.memberRepository,
		storage: storage.storage,
		settings: settings.store,
		logger,
		clock: { now: () => new Date('2026-07-24T00:00:00.000Z') },
		uploadLifecycle,
	});
	return { graph, ports, storage, settings, uploadLifecycle };
}

async function routeApp(
	harness: ReturnType<typeof graphHarness>,
	user: { id: number; role: 'ADMIN' | 'OPERATOR' | 'USER' } = { id: 1, role: 'ADMIN' },
): Promise<FastifyInstance> {
	const app = Fastify({ logger: false });
	app.addHook('preHandler', async (request) => {
		request.currentUser = {
			...user,
			googleSub: `user-${user.id}`,
			email: `user-${user.id}@g.pcu.ac.kr`,
			name: `User ${user.id}`,
		};
	});
	app.setErrorHandler((error, _request, reply) => {
		const failure = error as { statusCode?: number; code?: string };
		reply.status(failure.statusCode ?? 500).send({
			ok: false,
			error: {
				code: failure.code ?? 'ERROR',
				message: error instanceof Error ? error.message : String(error),
			},
		});
	});
	await app.register(createAdminRoutes({
		...harness.graph,
		bannedIpController: emptyRoute,
		exhibitionController: emptyRoute,
		importController: emptyRoute,
		exportController: emptyRoute,
		projectMultipartController: emptyRoute,
		gameUploadController: emptyRoute,
	}), { prefix: '/api/admin' });
	await app.ready();
	return app;
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
	await Promise.allSettled(apps.splice(0).map((app) => app.close()));
});

describe('project/member/settings production wiring', () => {
	it('imports, creates and registers the selected production controllers without I/O or timers', async () => {
		const sources = await Promise.all([
			'modules/admin/project/controller.ts',
			'modules/admin/project/crud.repository.ts',
			'modules/admin/member/controller.ts',
			'modules/admin/member/repository.ts',
			'modules/admin/settings/controller.ts',
		].map((file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8')));
		for (const source of sources) {
			expect(source).not.toMatch(/config\/env|lib\/prisma|serializer\.runtime|\.\/runtime/);
		}

		const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
		try {
			const harness = graphHarness();
			const app = await routeApp(harness);
			apps.push(app);
			expect(harness.ports.calls.projectFindUnique).not.toHaveBeenCalled();
			expect(harness.ports.calls.projectFindMany).not.toHaveBeenCalled();
			expect(harness.settings.repository.loadOrCreate).not.toHaveBeenCalled();
			expect(harness.storage.calls.delete).not.toHaveBeenCalled();
			expect(setIntervalSpy).not.toHaveBeenCalled();
		} finally {
			setIntervalSpy.mockRestore();
		}
	});

	it('runs project list/detail/update/poster/webgl/status/delete and access denial through the graph', async () => {
		const harness = graphHarness();
		const app = await routeApp(harness);
		apps.push(app);

		expect((await app.inject({ method: 'GET', url: '/api/admin/projects' })).statusCode).toBe(200);
		expect((await app.inject({ method: 'GET', url: '/api/admin/projects/7' })).statusCode).toBe(200);
		expect((await app.inject({
			method: 'PATCH',
			url: '/api/admin/projects/7',
			payload: { title: 'Updated' },
		})).statusCode).toBe(200);
		expect((await app.inject({
			method: 'PATCH',
			url: '/api/admin/projects/7/poster',
			payload: { assetId: 21 },
		})).statusCode).toBe(200);
		expect((await app.inject({
			method: 'PATCH',
			url: '/api/admin/projects/bulk/status',
			payload: { ids: [7], status: 'ARCHIVED' },
		})).statusCode).toBe(200);
		expect((await app.inject({
			method: 'DELETE',
			url: '/api/admin/projects/7/webgl',
		})).statusCode).toBe(204);
		expect((await app.inject({
			method: 'DELETE',
			url: '/api/admin/projects/7',
		})).statusCode).toBe(204);
		expect(harness.ports.calls.projectDelete).toHaveBeenCalledOnce();
		expect(harness.storage.calls.delete).not.toHaveBeenCalled();
		expect(harness.ports.calls.orphanUpsert).toHaveBeenCalled();
		expect(harness.uploadLifecycle.wakeDeletionWorker).toHaveBeenCalledTimes(2);

		const deniedHarness = graphHarness();
		const deniedApp = await routeApp(deniedHarness, { id: 99, role: 'USER' });
		apps.push(deniedApp);
		const denied = await deniedApp.inject({
			method: 'PATCH',
			url: '/api/admin/projects/7',
			payload: { title: 'Intrusion' },
		});
		expect(denied.statusCode).toBe(403);
		expect(deniedHarness.ports.calls.projectUpdate).not.toHaveBeenCalled();
	});

	it('preserves project list/detail/update/poster failures without forbidden mutations', async () => {
		const listHarness = graphHarness();
		listHarness.ports.calls.projectList.mockRejectedValueOnce(new Error('list repository failure'));
		const listApp = await routeApp(listHarness);
		apps.push(listApp);
		const listFailure = await listApp.inject({ method: 'GET', url: '/api/admin/projects' });
		expect(listFailure.statusCode).toBe(500);
		expect(listHarness.ports.calls.projectUpdate).not.toHaveBeenCalled();
		expect(listHarness.ports.calls.projectDelete).not.toHaveBeenCalled();
		expect(listHarness.storage.calls.delete).not.toHaveBeenCalled();

		const detailHarness = graphHarness();
		detailHarness.ports.calls.projectFindUnique.mockResolvedValueOnce(null);
		const detailApp = await routeApp(detailHarness);
		apps.push(detailApp);
		const missingDetail = await detailApp.inject({
			method: 'GET',
			url: '/api/admin/projects/7',
		});
		expect(missingDetail.statusCode).toBe(404);
		expect(missingDetail.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
		expect(detailHarness.ports.calls.projectUpdate).not.toHaveBeenCalled();

		const updateHarness = graphHarness();
		const updateApp = await routeApp(updateHarness, { id: 1, role: 'USER' });
		apps.push(updateApp);
		const forbiddenStatus = await updateApp.inject({
			method: 'PATCH',
			url: '/api/admin/projects/7',
			payload: { status: 'ARCHIVED' },
		});
		expect(forbiddenStatus.statusCode).toBe(403);
		expect(forbiddenStatus.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
		expect(updateHarness.ports.calls.projectUpdate).not.toHaveBeenCalled();

		const posterHarness = graphHarness();
		posterHarness.ports.calls.findAssetById.mockResolvedValueOnce(null);
		const posterApp = await routeApp(posterHarness);
		apps.push(posterApp);
		const missingPoster = await posterApp.inject({
			method: 'PATCH',
			url: '/api/admin/projects/7/poster',
			payload: { assetId: 999 },
		});
		expect(missingPoster.statusCode).toBe(404);
		expect(missingPoster.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
		expect(posterHarness.ports.calls.projectUpdate).not.toHaveBeenCalled();
		expect(posterHarness.storage.calls.delete).not.toHaveBeenCalled();
	});

	it('retains outbox/storage guarantees across delete, WebGL and bulk failures', async () => {
		const deleteHarness = graphHarness();
		deleteHarness.ports.calls.orphanUpsert.mockRejectedValueOnce(new Error('outbox unavailable'));
		const deleteApp = await routeApp(deleteHarness);
		apps.push(deleteApp);
		const failedDelete = await deleteApp.inject({
			method: 'DELETE',
			url: '/api/admin/projects/7',
		});
		expect(failedDelete.statusCode).toBe(500);
		expect(deleteHarness.ports.calls.projectUpdate).not.toHaveBeenCalled();
		expect(deleteHarness.ports.calls.assetDeleteMany).not.toHaveBeenCalled();
		expect(deleteHarness.ports.calls.projectDelete).not.toHaveBeenCalled();
		expect(deleteHarness.storage.calls.delete).not.toHaveBeenCalled();

		const webglHarness = graphHarness();
		const webglApp = await routeApp(webglHarness);
		apps.push(webglApp);
		const durableWebglDelete = await webglApp.inject({
			method: 'DELETE',
			url: '/api/admin/projects/7/webgl',
		});
		expect(durableWebglDelete.statusCode).toBe(204);
		expect(webglHarness.ports.calls.orphanUpsert).toHaveBeenCalled();
		expect(webglHarness.ports.getProject().webglEntryKey).toBe('');
		expect(webglHarness.storage.calls.delete).not.toHaveBeenCalled();
		expect(webglHarness.uploadLifecycle.wakeDeletionWorker).toHaveBeenCalledOnce();

		const bulkHarness = graphHarness();
		bulkHarness.ports.calls.orphanUpsert.mockRejectedValueOnce(new Error('bulk outbox unavailable'));
		const bulkApp = await routeApp(bulkHarness);
		apps.push(bulkApp);
		const failedBulk = await bulkApp.inject({
			method: 'POST',
			url: '/api/admin/projects/bulk/delete',
			payload: { ids: [7] },
		});
		expect(failedBulk.statusCode).toBe(500);
		expect(bulkHarness.ports.calls.projectUpdateMany).not.toHaveBeenCalled();
		expect(bulkHarness.ports.calls.assetDeleteMany).not.toHaveBeenCalled();
		expect(bulkHarness.ports.calls.projectDeleteMany).not.toHaveBeenCalled();
		expect(bulkHarness.storage.calls.delete).not.toHaveBeenCalled();
	});

	it('runs bulk delete and member add/update/swap/delete through repository factories', async () => {
		const bulkHarness = graphHarness();
		const bulkApp = await routeApp(bulkHarness);
		apps.push(bulkApp);
		const bulk = await bulkApp.inject({
			method: 'POST',
			url: '/api/admin/projects/bulk/delete',
			payload: { ids: [7] },
		});
		expect(bulk.statusCode).toBe(200);
		expect(bulkHarness.ports.calls.projectDeleteMany).toHaveBeenCalledOnce();
		expect(bulkHarness.storage.calls.delete).not.toHaveBeenCalled();
		expect(bulkHarness.uploadLifecycle.wakeDeletionWorker).toHaveBeenCalledOnce();

		const memberHarness = graphHarness();
		const memberApp = await routeApp(memberHarness);
		apps.push(memberApp);
		const added = await memberApp.inject({
			method: 'POST',
			url: '/api/admin/projects/7/members',
			payload: { name: 'Second', studentId: '20260002', sortOrder: 1 },
		});
		expect(added.statusCode).toBe(201);
		const addedId = added.json().data.id as number;
		expect((await memberApp.inject({
			method: 'PATCH',
			url: `/api/admin/projects/7/members/${addedId}`,
			payload: { name: 'Renamed' },
		})).statusCode).toBe(204);
		expect((await memberApp.inject({
			method: 'PATCH',
			url: '/api/admin/projects/7/members/swap',
			payload: { memberIdA: 11, memberIdB: addedId },
		})).statusCode).toBe(204);
		expect((await memberApp.inject({
			method: 'DELETE',
			url: `/api/admin/projects/7/members/${addedId}`,
		})).statusCode).toBe(204);
		expect(memberHarness.ports.calls.memberCreate).toHaveBeenCalledOnce();
		expect(memberHarness.ports.calls.memberUpdate).toHaveBeenCalled();
		expect(memberHarness.ports.calls.memberDelete).toHaveBeenCalledOnce();
	});

	it('preserves member project/member/swap/access/validation failures without mutation', async () => {
		const projectHarness = graphHarness();
		projectHarness.ports.calls.projectFindUnique.mockResolvedValueOnce(null);
		const projectApp = await routeApp(projectHarness);
		apps.push(projectApp);
		const missingProject = await projectApp.inject({
			method: 'POST',
			url: '/api/admin/projects/7/members',
			payload: { name: 'Member', studentId: '20260002' },
		});
		expect(missingProject.statusCode).toBe(404);
		expect(projectHarness.ports.calls.memberCreate).not.toHaveBeenCalled();

		const memberHarness = graphHarness();
		memberHarness.ports.calls.projectMemberFindFirst.mockResolvedValueOnce(null);
		const memberApp = await routeApp(memberHarness);
		apps.push(memberApp);
		const missingMember = await memberApp.inject({
			method: 'PATCH',
			url: '/api/admin/projects/7/members/999',
			payload: { name: 'Missing' },
		});
		expect(missingMember.statusCode).toBe(404);
		expect(memberHarness.ports.calls.memberUpdate).not.toHaveBeenCalled();

		const swapHarness = graphHarness();
		swapHarness.ports.calls.memberSwap.mockResolvedValueOnce(null);
		const swapApp = await routeApp(swapHarness);
		apps.push(swapApp);
		const missingSwapMember = await swapApp.inject({
			method: 'PATCH',
			url: '/api/admin/projects/7/members/swap',
			payload: { memberIdA: 11, memberIdB: 999 },
		});
		expect(missingSwapMember.statusCode).toBe(404);
		expect(swapHarness.ports.calls.memberUpdate).not.toHaveBeenCalled();

		const deniedHarness = graphHarness();
		const deniedApp = await routeApp(deniedHarness, { id: 99, role: 'USER' });
		apps.push(deniedApp);
		const denied = await deniedApp.inject({
			method: 'DELETE',
			url: '/api/admin/projects/7/members/11',
		});
		expect(denied.statusCode).toBe(403);
		expect(deniedHarness.ports.calls.memberDelete).not.toHaveBeenCalled();

		const invalidHarness = graphHarness();
		const invalidApp = await routeApp(invalidHarness);
		apps.push(invalidApp);
		const invalid = await invalidApp.inject({
			method: 'POST',
			url: '/api/admin/projects/7/members',
			payload: { name: '', studentId: '' },
		});
		expect(invalid.statusCode).toBe(400);
		expect(invalidHarness.ports.calls.memberCreate).not.toHaveBeenCalled();
	});

	it('keeps settings get/update/cache/invalidation independent across A/B graphs', async () => {
		const a = graphHarness('a');
		const b = graphHarness('b');
		const appA = await routeApp(a);
		const appB = await routeApp(b);
		apps.push(appA, appB);

		expect((await appA.inject({ method: 'GET', url: '/api/admin/settings' })).json().data).toEqual({
			maxGameFileMb: 64,
			maxChunkSizeMb: 6,
		});
		expect((await appB.inject({ method: 'GET', url: '/api/admin/settings' })).json().data).toEqual({
			maxGameFileMb: 32,
			maxChunkSizeMb: 5,
		});
		const updated = await appA.inject({
			method: 'PATCH',
			url: '/api/admin/settings',
			payload: { maxGameFileMb: 16, maxChunkSizeMb: 5 },
		});
		expect(updated.statusCode).toBe(200);
		a.settings.store.invalidate();
		expect(await a.settings.store.get()).toEqual({ maxGameFileMb: 16, maxChunkSizeMb: 5 });
		expect(await b.settings.store.get()).toEqual({ maxGameFileMb: 32, maxChunkSizeMb: 5 });
	});

	it('preserves settings update validation failures without repository writes', async () => {
		const harness = graphHarness();
		const app = await routeApp(harness);
		apps.push(app);

		const missing = await app.inject({
			method: 'PATCH',
			url: '/api/admin/settings',
		});
		expect(missing.statusCode).toBe(400);
		const invalid = await app.inject({
			method: 'PATCH',
			url: '/api/admin/settings',
			payload: { maxChunkSizeMb: 11 },
		});
		expect(invalid.statusCode).toBe(400);
		expect(harness.settings.repository.update).not.toHaveBeenCalled();
	});

	it('uses the deterministic TTL before reloading a recovered lower DB value', async () => {
		let nowMs = 0;
		const harness = graphHarness('a', { now: () => nowMs, ttlMs: 100 });
		const app = await routeApp(harness);
		apps.push(app);

		const initial = await app.inject({ method: 'GET', url: '/api/admin/settings' });
		expect(initial.json().data).toEqual({ maxGameFileMb: 64, maxChunkSizeMb: 6 });
		harness.settings.setValue({ maxGameFileMb: 8, maxChunkSizeMb: 5 });

		nowMs = 99;
		const cached = await app.inject({ method: 'GET', url: '/api/admin/settings' });
		expect(cached.json().data).toEqual({ maxGameFileMb: 64, maxChunkSizeMb: 6 });
		expect(harness.settings.repository.loadOrCreate).toHaveBeenCalledOnce();

		nowMs = 100;
		const reloaded = await app.inject({ method: 'GET', url: '/api/admin/settings' });
		expect(reloaded.json().data).toEqual({ maxGameFileMb: 8, maxChunkSizeMb: 5 });
		expect(harness.settings.repository.loadOrCreate).toHaveBeenCalledTimes(2);
	});

	it('keeps B settings routes alive after the A context-owned store closes', async () => {
		const a = graphHarness('a');
		const b = graphHarness('b');
		const appA = await routeApp(a);
		const appB = await routeApp(b);
		apps.push(appA, appB);

		expect((await appA.inject({ method: 'GET', url: '/api/admin/settings' })).statusCode).toBe(200);
		expect((await appB.inject({ method: 'GET', url: '/api/admin/settings' })).statusCode).toBe(200);
		a.settings.store.close();
		await expect(a.settings.store.get()).rejects.toThrow('Settings store is closed');
		expect((await appA.inject({ method: 'GET', url: '/api/admin/settings' })).statusCode).toBe(500);

		const updatedB = await appB.inject({
			method: 'PATCH',
			url: '/api/admin/settings',
			payload: { maxGameFileMb: 12, maxChunkSizeMb: 5 },
		});
		expect(updatedB.statusCode).toBe(200);
		expect(updatedB.json().data).toEqual({ maxGameFileMb: 12, maxChunkSizeMb: 5 });
		expect(await b.settings.store.get()).toEqual({ maxGameFileMb: 12, maxChunkSizeMb: 5 });
	});

	it('retries an initial settings failure and exposes recovered lower DB limits without reset', async () => {
		const delay = vi.fn(async () => {});
		const repository = {
			loadOrCreate: vi.fn()
				.mockRejectedValueOnce(new Error('database unavailable'))
				.mockResolvedValue({ maxGameFileMb: 8, maxChunkSizeMb: 2 }),
			update: vi.fn(),
		};
		const store = createCachedSettingsStore(repository, {
			delay,
			warmupMaxAttempts: 3,
			warmupRetryDelayMs: 1,
		});

		await expect(store.warmup()).resolves.toEqual({ maxGameFileMb: 8, maxChunkSizeMb: 2 });
		await expect(store.get()).resolves.toEqual({ maxGameFileMb: 8, maxChunkSizeMb: 2 });
		expect(repository.loadOrCreate).toHaveBeenCalledTimes(2);
		expect(delay).toHaveBeenCalledOnce();
	});

	it('owns settings warmup in BackendContext startup and closes the recovered store', async () => {
		const repository = {
			loadOrCreate: vi.fn()
				.mockRejectedValueOnce(new Error('database unavailable'))
				.mockResolvedValue({ maxGameFileMb: 8, maxChunkSizeMb: 2 }),
			update: vi.fn(),
		};
		const store = createCachedSettingsStore(repository, {
			delay: vi.fn(async () => {}),
			warmupMaxAttempts: 2,
			warmupRetryDelayMs: 1,
		});
		const closeSpy = vi.spyOn(store, 'close');
		const storage = storageHarness();
		const scheduler: Scheduler = {
			every: vi.fn(() => ({ cancel: vi.fn() })),
			delay: vi.fn(async () => {}),
		};
		const config: Env = {
			...defaultTestEnv,
			LOG_LEVEL: 'info',
			GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS],
			CORS_ALLOWED_ORIGINS: [...defaultTestEnv.CORS_ALLOWED_ORIGINS],
		};
		const context = await createProductionBackendContext(config, {
			persistence: createScriptedBackendPersistence(),
			routes: {
				auth: emptyRoute,
				devAuth: emptyRoute,
				public: emptyRoute,
				admin: emptyRoute,
				me: emptyRoute,
				assets: emptyRoute,
			},
			resources: {
				uploadLifecycle: ownedTestUploadLifecycleResource(),
				logger: { value: logger, ownership: 'borrowed' },
				settings: {
					value: store,
					ownership: 'owned',
					start: async () => { await store.warmup(); },
					close: () => store.close(),
				},
				s3: {
					value: { destroy: vi.fn() } as unknown as S3Client,
					ownership: 'borrowed',
				},
				storage: { value: storage.storage, ownership: 'borrowed' },
				scheduler: { value: scheduler, ownership: 'borrowed' },
			},
		});

		await context.start();
		expect(await context.settings.get()).toEqual({ maxGameFileMb: 8, maxChunkSizeMb: 2 });
		expect(repository.loadOrCreate).toHaveBeenCalledTimes(2);
		await context.close();
		expect(closeSpy).toHaveBeenCalledOnce();
	});
});
