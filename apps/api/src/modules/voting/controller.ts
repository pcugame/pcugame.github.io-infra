import type { FastifyPluginAsync } from 'fastify';
import { createHash } from 'node:crypto';
import { requireRole } from '../../shared/auth-guards.js';
import { sendOk } from '../../shared/http.js';
import { VotePageSchema } from '@pcu/contracts';
import { participantHash } from './service.js';
import type { createVotingService } from './service.js';
export function createVotingController(service: ReturnType<typeof createVotingService>): FastifyPluginAsync {
	return async (app) => {
		app.addHook('onSend', async (_req, reply, payload) => {
			reply.header('Cache-Control', 'private, no-store');
			return payload;
		});
		const admin = { preHandler: requireRole('ADMIN', 'OPERATOR') };
		// Separate participant quota supplements the existing loose IP abuse ceiling.
		const windows = new Map<string, { until: number; count: number }>();
		app.addHook('preHandler', async (req, reply) => {
			if (!req.url.startsWith('/api/votes/')) return;
			const token = req.headers['x-vote-participant'];
			if (typeof token !== 'string') return;
			const key = createHash('sha256').update(token).digest('hex'),
				now = Date.now();
			if (windows.size > 10000) for (const [k, v] of windows) if (v.until <= now) windows.delete(k);
			const w = windows.get(key);
			if (!w || w.until <= now) windows.set(key, { until: now + 60000, count: 1 });
			else if (++w.count > 120)
				return reply
					.code(429)
					.header('Retry-After', '60')
					.send({ ok: false, error: { code: 'RATE_LIMITED', message: '잠시 후 다시 시도해 주세요.' } });
		});
		app.get<{ Params: { id: string } }>('/api/votes/:id', async (req, reply) =>
			sendOk(reply, await service.view(req.params.id, participantHash(req.headers['x-vote-participant']))),
		);
		app.post<{ Params: { id: string } }>('/api/votes/:id/ballots', async (req, reply) =>
			sendOk(
				reply,
				await service.submit(
					req.params.id,
					participantHash(req.headers['x-vote-participant']),
					req.body,
					req.ip,
					req.headers['user-agent'] ?? '',
				),
			),
		);
		app.get<{ Params: { id: string } }>('/api/votes/:id/records', async (req, reply) =>
			sendOk(reply, await service.records(req.params.id, VotePageSchema.parse(req.query).page)),
		);
		for (const action of ['draw', 'receive'] as const)
			app.post<{ Params: { id: string } }>(`/api/votes/:id/${action}`, async (req, reply) =>
				sendOk(
					reply,
					await service[action](req.params.id, participantHash(req.headers['x-vote-participant'])),
				),
			);
		app.get('/api/admin/votes', admin, async (_req, reply) => sendOk(reply, await service.list()));
		app.post('/api/admin/votes', admin, async (req, reply) =>
			sendOk(reply, await service.create(req.body, req.currentUser!.id)),
		);
		app.put<{ Params: { id: string } }>('/api/admin/votes/:id', admin, async (req, reply) =>
			sendOk(reply, await service.update(req.params.id, req.body, req.currentUser!.id)),
		);
		app.get<{ Params: { id: string } }>('/api/admin/votes/:id/posters', admin, async (req, reply) =>
			sendOk(reply, await service.posters(req.params.id)),
		);
		app.get<{ Params: { id: string } }>('/api/admin/votes/:id/sources', admin, async (req, reply) =>
			sendOk(reply, await service.sources(req.params.id)),
		);
		app.get<{ Params: { id: string } }>('/api/admin/votes/:id/records', admin, async (req, reply) =>
			sendOk(reply, await service.records(req.params.id, VotePageSchema.parse(req.query).page, true)),
		);
		app.post<{ Params: { id: string } }>('/api/admin/votes/:id/candidates', admin, async (req, reply) =>
			sendOk(reply, await service.candidate(req.params.id, null, req.body, req.currentUser!.id)),
		);
		app.put<{ Params: { id: string; candidateId: string } }>(
			'/api/admin/votes/:id/candidates/:candidateId',
			admin,
			async (req, reply) =>
				sendOk(
					reply,
					await service.candidate(req.params.id, req.params.candidateId, req.body, req.currentUser!.id),
				),
		);
		app.put<{ Params: { id: string; ballotId: string } }>(
			'/api/admin/votes/:id/records/:ballotId',
			admin,
			async (req, reply) =>
				sendOk(reply, await service.flag(req.params.id, req.params.ballotId, req.body, req.currentUser!.id)),
		);
		app.get('/api/admin/draw-events', admin, async (_req, reply) => sendOk(reply, await service.events()));
		app.post('/api/admin/draw-events', admin, async (req, reply) =>
			sendOk(reply, await service.saveEvent(null, req.body, req.currentUser!.id)),
		);
		app.put<{ Params: { id: string } }>('/api/admin/draw-events/:id', admin, async (req, reply) =>
			sendOk(reply, await service.saveEvent(req.params.id, req.body, req.currentUser!.id)),
		);
	};
}
