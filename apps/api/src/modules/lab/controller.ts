import type { FastifyPluginAsync } from 'fastify';
import type { LabCreateRun, LabStatus } from '@pcu/contracts';
import { LAB_JSONL_MAX_BYTES } from '@pcu/contracts';
import { requireRole } from '../../shared/auth-guards.js';
import { AppError, badRequest, notFound } from '../../shared/errors.js';
import { sendOk } from '../../shared/http.js';
import { invalidGenerateSetting } from '../benchmark-worker/config.js';
import type { createLabRepository } from './repository.js';

type Id = { id: string };
type Page = { page: number; q: string };
type Repo = ReturnType<typeof createLabRepository>;

export function createLabController(
	repo: Repo | undefined,
	config: {
		enabled: boolean;
		model: string;
		provider: string;
		searchUrl?: string;
		modelUrl?: string;
	},
	status: () => Promise<LabStatus>,
): FastifyPluginAsync {
	return async (app) => {
		app.addHook('onRequest', requireRole('BETA_TESTER', 'ADMIN'));
		app.addHook('onSend', async (_req, reply, payload) => {
			reply.header('Cache-Control', 'private, no-store');
			return payload;
		});
		app.get('/status', async (_req, reply) => sendOk(reply, await status()));
		await app.register(async (api) => {
			api.addHook('onRequest', async () => {
				if (!config.enabled || !repo) throw notFound('Lab is disabled');
			});
			// The enclosing hook checks persistence and the feature flag before every handler.
			const store = repo!;
			const writeLimit = { rateLimit: { max: 20, timeWindow: 60000 } };
			api.get<{ Querystring: Page }>('/datasets', async (r, reply) =>
				sendOk(reply, await store.datasets(r.currentUser!, r.query.page)),
			);
			api.post<{ Body: { name: string; jsonl: string } }>(
				'/datasets',
				{ bodyLimit: LAB_JSONL_MAX_BYTES * 2 + 2048, config: writeLimit },
				async (r, reply) => sendOk(reply, await store.upload(r.currentUser!, r.body.name, r.body.jsonl), 201),
			);
			api.get<{ Params: Id; Querystring: Page }>('/datasets/:id/cases', async (r, reply) =>
				sendOk(reply, await store.cases(r.currentUser!, r.params.id, r.query)),
			);
			api.get<{ Querystring: Page }>('/runs', async (r, reply) =>
				sendOk(reply, await store.runs(r.currentUser!, r.query.page)),
			);
			api.post<{ Body: LabCreateRun }>('/runs', { config: writeLimit }, async (r, reply) => {
				if (!config.modelUrl || !config.model || r.body.model !== config.model)
					throw badRequest('Select the configured model');
				if (config.provider === 'transformers-generate') {
					const problem = invalidGenerateSetting(r.body);
					if (problem) throw badRequest(problem);
					if ((await status()).systemPromptSupported === false)
						throw badRequest('The 4B model server requires an update to support system_prompt');
				}
				if (r.body.searchMode !== 'no_search' && !config.searchUrl)
					throw badRequest('Search provider is not configured');
				sendOk(reply, await store.createRun(r.currentUser!, r.body, config.provider), 202);
			});
			api.get<{ Params: Id }>('/runs/:id', async (r, reply) =>
				sendOk(reply, await store.run(r.currentUser!, r.params.id)),
			);
			api.get<{ Params: Id; Querystring: Page & { status?: string } }>('/runs/:id/results', async (r, reply) =>
				sendOk(reply, await store.results(r.currentUser!, r.params.id, r.query)),
			);
			for (const action of ['cancel', 'retry'] as const) {
				api.post<{ Params: Id }>(`/runs/:id/${action}`, { config: writeLimit }, async (r, reply) =>
					sendOk(reply, await store.changeRun(r.currentUser!, r.params.id, action)),
				);
			}
			api.get<{ Querystring: Page & { left: string; right: string } }>('/compare', async (r, reply) =>
				sendOk(reply, await store.compare(r.currentUser!, r.query)),
			);
			// One large export at a time per API process, including socket backpressure.
			let exporting = false;
			api.get<{ Params: Id; Querystring: { format: 'json' | 'jsonl' | 'csv' } }>(
				'/runs/:id/export',
				{ config: { rateLimit: { max: 10, timeWindow: 60000 } } },
				async (r, reply) => {
					if (exporting)
						throw new AppError(429, 'An export is already in progress', 'RATE_LIMITED', { retryAfterSec: 2 });
					exporting = true;
					const release = () => {
						reply.raw.off('finish', release);
						reply.raw.off('close', release);
						exporting = false;
					};
					reply.raw.once('finish', release);
					reply.raw.once('close', release);
					sendOk(reply, await store.exportRun(r.currentUser!, r.params.id, r.query.format));
				},
			);
			const admin = { onRequest: requireRole('ADMIN'), config: writeLimit };
			api.get<{ Querystring: Page }>('/beta-users', admin, async (r, reply) =>
				sendOk(reply, await store.users(r.query.q, r.query.page)),
			);
			api.patch<{ Params: Id; Body: { role: 'USER' | 'BETA_TESTER' } }>(
				'/beta-users/:id',
				admin,
				async (r, reply) =>
					sendOk(reply, await store.changeRole(r.currentUser!, Number(r.params.id), r.body.role)),
			);
		});
	};
}
