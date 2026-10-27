import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectController, type ProjectControllerDependencies } from '../modules/admin/project/controller.js';
import { forbidden } from '../shared/errors.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

async function fixture() {
	// Production disables Fastify logging too; the explicitly injected logger must work.
	const app = Fastify({ logger: false, genReqId: () => 'audit-request' });
	apps.push(app);
	const actor = { id: 17, email: 'operator@example.test', name: 'Operator', role: 'ADMIN' as const, googleSub: 'private-google-sub' };
	app.addHook('onRequest', async request => { request.currentUser = actor; });
	const logger = { info: vi.fn(), warn: vi.fn() };
	const remove = vi.fn().mockResolvedValue(undefined);
	const bulk = vi.fn().mockResolvedValue({ deleted: 2 });
	const access = vi.fn().mockResolvedValue({ status: 'DRAFT' });
	await app.register(createProjectController({
		service: { deleteProject: remove, bulkDeleteProjects: bulk } as unknown as ProjectControllerDependencies['service'],
		logger,
		access: { loadProjectWithAccess: access },
		status: { assertTransition() {}, bulkUpdate: async () => ({ updated: 0 }) },
	}), { prefix: '/api/admin' });
	return { app, actor, logger, remove, bulk, access };
}

describe('project deletion audit', () => {
	it('records the authenticated actor and request identity despite disabled request logging', async () => {
		const { app, logger, remove } = await fixture();
		const response = await app.inject({ method: 'DELETE', url: '/api/admin/projects/215', remoteAddress: '192.0.2.5',
			headers: { cookie: 'session=private-cookie', authorization: 'Bearer private-token' } });
		expect(response.statusCode).toBe(204);
		expect(remove).toHaveBeenCalledOnce();
		expect(logger.info.mock.calls.map(([record]) => record.outcome)).toEqual(['requested', 'completed']);
		expect(logger.info.mock.calls[1]![0]).toMatchObject({ event: 'project.deletion', actorId: 17,
			actorEmail: 'operator@example.test', actorName: 'Operator', actorRole: 'ADMIN',
			projectIds: [215], ip: '192.0.2.5', requestId: 'audit-request', occurredAt: expect.any(String) });
		expect(JSON.stringify(logger.info.mock.calls)).not.toMatch(/private-cookie|private-token|private-google-sub/);
	});

	it('records failed authorization without recording deletion success', async () => {
		const { app, logger, remove, access } = await fixture();
		access.mockRejectedValue(forbidden('Not project owner or member'));
		expect((await app.inject({ method: 'DELETE', url: '/api/admin/projects/215' })).statusCode).toBe(403);
		expect(remove).not.toHaveBeenCalled();
		expect(logger.info).toHaveBeenCalledOnce();
		expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', actorId: 17, projectIds: [215] }), expect.any(String));
	});

	it('does not misreport service failures or log raw error contents', async () => {
		const { app, logger, remove } = await fixture();
		remove.mockRejectedValue(new Error('secret database details'));
		expect((await app.inject({ method: 'DELETE', url: '/api/admin/projects/215' })).statusCode).toBe(500);
		expect(logger.info).toHaveBeenCalledOnce();
		expect(logger.warn.mock.calls[0]![0].outcome).toBe('failed');
		expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret database details');
	});

	it('also audits bulk deletion with the full requested project list', async () => {
		const { app, logger, bulk } = await fixture();
		const response = await app.inject({ method: 'POST', url: '/api/admin/projects/bulk/delete', payload: { ids: [215, 216] } });
		expect(response.statusCode).toBe(200);
		expect(bulk).toHaveBeenCalledWith([215, 216]);
		expect(logger.info.mock.calls[1]![0]).toMatchObject({ outcome: 'completed', projectIds: [215, 216], actorId: 17 });
	});
});
