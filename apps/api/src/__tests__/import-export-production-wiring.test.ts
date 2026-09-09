import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdminRoutes } from '../modules/admin/admin.routes.js';
import {
	createImportExportProductionGraph,
	type ExportRepository,
} from '../modules/admin/import-export.composition.js';
import type {
	ImportRepository,
	ImportTransactionRepository,
} from '../modules/admin/import/service.js';

const emptyRoute: FastifyPluginAsync = async () => {};
const apps: FastifyInstance[] = [];

function repositories() {
	const calls = {
		createJob: vi.fn(async ({ id }: { id: string }) => ({ id })),
		latestJob: vi.fn(),
		findExhibitionForPreview: vi.fn(async () => null),
		findExhibitionByComposite: vi.fn(async () => null),
		upsertExhibition: vi.fn(async () => ({ id: 1 })),
		findProjectBySlug: vi.fn(async () => null),
		createProjectWithMembers: vi.fn(async () => ({ id: 1 })),
		runTransaction: vi.fn(),
	};
	const transaction: ImportTransactionRepository = {
		findExhibitionByComposite: calls.findExhibitionByComposite,
		upsertExhibition: calls.upsertExhibition,
		findProjectBySlug: calls.findProjectBySlug,
		createProjectWithMembers: calls.createProjectWithMembers,
	};
	const importRepository: ImportRepository = {
		findExhibitionForPreview: calls.findExhibitionForPreview,
		runTransaction: calls.runTransaction.mockImplementation(async (work: (repo: ImportTransactionRepository) => Promise<unknown>) => work(transaction)),
	};
	const exportRepository: ExportRepository = {
		createJob: calls.createJob,
		latestJob: calls.latestJob,
	};
	return { calls, importRepository, exportRepository };
}

function graphHarness() {
	const state = repositories();
	let id = 0;
	return {
		...state,
		graph: createImportExportProductionGraph({
			importRepository: state.importRepository,
			exportRepository: state.exportRepository,
			ids: { next: () => `export-job-${++id}` },
		}),
	};
}

async function appFor(graph: ReturnType<typeof createImportExportProductionGraph>) {
	const app = Fastify({ logger: false });
	await app.register(fastifyMultipart, { limits: { fileSize: 11 * 1024 * 1024, files: 1 } });
	app.addHook('preHandler', async (request) => {
		request.currentUser = {
			id: 9, googleSub: 'admin', email: 'admin@example.test', name: 'Admin', role: 'ADMIN',
		};
	});
	app.setErrorHandler((error, _request, reply) => {
		const failure = error as { statusCode?: number; code?: string };
		reply.status(failure.statusCode ?? 500).send({ ok: false, error: {
			code: failure.code ?? 'ERROR', message: error instanceof Error ? error.message : String(error),
		} });
	});
	await app.register(createAdminRoutes({
		projectController: emptyRoute,
		memberController: emptyRoute,
		settingsController: emptyRoute,
		bannedIpController: emptyRoute,
		exhibitionController: emptyRoute,
		importController: graph.importController,
		exportController: graph.exportController,
		projectMultipartController: emptyRoute,
		gameUploadController: emptyRoute,
	}), { prefix: '/api/admin' });
	await app.ready();
	apps.push(app);
	return app;
}

function multipartJson(raw: string) {
	const boundary = 'canonical-import';
	return {
		headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
		payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="import.json"\r\nContent-Type: application/json\r\n\r\n${raw}\r\n--${boundary}--\r\n`),
	};
}

afterEach(async () => {
	await Promise.allSettled(apps.splice(0).map((app) => app.close()));
	vi.restoreAllMocks();
});

describe('import/export production wiring', () => {
	it('keeps the Fastify export graph control-plane-only', async () => {
		const [composition, controller, service] = await Promise.all([
			readFile(new URL('../modules/admin/import-export.composition.ts', import.meta.url), 'utf8'),
			readFile(new URL('../modules/admin/export/controller.ts', import.meta.url), 'utf8'),
			readFile(new URL('../modules/admin/export/service.ts', import.meta.url), 'utf8'),
		]);
		for (const source of [composition, controller, service]) {
			expect(source).not.toMatch(/storage\.stream|createReadStream|createWriteStream|node:fs|file\.adapter|processing\.composition|worker\.js/);
		}
	});

	it('creates an ExportJob and maps durable job status without waiting for object bytes', async () => {
		const state = graphHarness();
		state.calls.latestJob.mockResolvedValueOnce({
			id: 'export-job-1', state: 'RUNNING', progress: {
				year: 2026, startedAt: 1, phase: 'downloading', totalProjects: 1,
				currentProjectIndex: 0, currentProjectTitle: 'Game', currentProjectFiles: [],
				totalFiles: 2, downloaded: 1, skipped: 0, failed: 0,
			}, result: null, error: null,
		});
		const app = await appFor(state.graph);

		const created = await app.inject({ method: 'POST', url: '/api/admin/export', payload: { year: 2026 } });
		expect(created.statusCode).toBe(202);
		expect(created.json().data).toEqual({ jobId: 'export-job-1', state: 'QUEUED' });
		expect(state.calls.createJob).toHaveBeenCalledWith({
			id: 'export-job-1', requestedById: 9, year: 2026, dryRun: false,
		});

		const status = await app.inject({ method: 'GET', url: '/api/admin/export/status' });
		expect(status.statusCode).toBe(200);
		expect(status.json().data).toMatchObject({
			running: true, jobId: 'export-job-1', state: 'RUNNING', progress: { downloaded: 1 },
		});
	});

	it('keeps the existing multipart import controller composed beside the job control plane', async () => {
		const state = graphHarness();
		const app = await appFor(state.graph);
		const preview = await app.inject({
			method: 'POST', url: '/api/admin/import/preview',
			...multipartJson(JSON.stringify({
				years: [{ year: 2026, title: 'Show' }],
				projects: [{ year: 2026, title: 'Game' }],
			})),
		});
		expect(preview.statusCode).toBe(200);
		expect(preview.json().data).toMatchObject({ valid: true, projectCount: 1 });
	});

	it('rejects malformed job controls before creating an export job', async () => {
		const state = graphHarness();
		const app = await appFor(state.graph);
		const response = await app.inject({ method: 'POST', url: '/api/admin/export', payload: { year: 1999 } });
		expect(response.statusCode).toBe(400);
		expect(state.calls.createJob).not.toHaveBeenCalled();
	});
});
