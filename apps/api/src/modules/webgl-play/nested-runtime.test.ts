import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env.js';
import { createFileAccessController } from '../file-access/controller.js';
import type { FileAccessRepository } from '../file-access/repository.js';
import type { WebglPlayRepository } from './repository.js';
import { createWebglPlayService, runtimeCsp } from './service.js';

const token = 'a'.repeat(64), otherToken = 'b'.repeat(64);
const origin = 'https://assets.test', api = 'https://api.test';
const prefix = 'public/webgl/7/deployment/';
const gatewaySecret = 'fixture-gateway-secret';
const config = {
	WEBGL_PLAY_ENABLED: true, PUBLIC_ASSET_ORIGIN: origin,
	API_PUBLIC_URL: api, S3_BUCKET_PUBLIC: 'pcu-public',
	FILE_GATEWAY_SECRET: gatewaySecret, SESSION_IDLE_MS: 60_000,
} as Env;

function fixture() {
	const now = new Date('2026-10-03T00:00:00Z');
	const play = {
		projectId: 7, deploymentId: 'deployment', sessionId: 'owner-session',
		revokedAt: null as Date | null, expiresAt: new Date(now.getTime() + 30_000),
		absoluteExpiresAt: new Date(now.getTime() + 60_000), approvedOrigins: [],
	};
	const session = { user: { id: 1, role: 'USER' }, expiresAt: play.absoluteExpiresAt, lastSeenAt: now };
	const repository = {
		findAsset: vi.fn(async (digest: string) => digest === createHash('sha256').update(token).digest('hex') ? play : null),
		session: vi.fn(async () => session),
		policyValid: vi.fn(async () => undefined),
		deployment: vi.fn(async () => ({
			id: 'deployment', publicPrefix: prefix, publicBucket: 'pcu-public',
			entryObjectKey: prefix + 'index.html',
			objectManifest: { objects: ['index.html', 'player/index.html', 'player/Build/game.worker.js'].map(path => ({ objectKey: prefix + path })) },
			project: { status: 'PUBLISHED', visibility: 'AUTHENTICATED', creatorId: 1, members: [], exhibition: { visibility: 'AUTHENTICATED' } },
		})),
	} as unknown as WebglPlayRepository;
	const service = createWebglPlayService(repository, config, () => now);
	const app = Fastify();
	app.register(createFileAccessController({} as FileAccessRepository, config, () => now,
		undefined, undefined, service.resolveRuntime), { prefix: '/api' });
	const request = (path: string, headers: Record<string, string> = {}) => app.inject({
		method: 'GET', url: '/api/internal/file-access', headers: {
			'x-pcu-gateway-secret': gatewaySecret, 'x-pcu-file-kind': 'public',
			'x-pcu-file-method': 'GET', 'x-pcu-file-uri': `/runtime/${token}/${path}`, ...headers,
		},
	});
	return { app, request, play, repository };
}

describe('nested runtime capability and gateway response', () => {
	it('allows child frames only at this runtime path and preserves trusted-shell separation', () => {
		const policy = runtimeCsp(origin, token, api);
		expect(policy).toContain(`frame-src ${origin}/runtime/${token}/;`);
		expect(policy).toContain(`frame-ancestors ${api} ${origin};`);
		expect(policy).toContain(`connect-src ${origin}/runtime/${token}/ blob:;`);
		expect(policy).not.toContain(otherToken);
		expect(policy).not.toContain("frame-src 'self'");
		expect(policy).toContain("form-action 'none'; object-src 'none'");
	});

	it('returns actual authorization headers for owner-session root, nested HTML and dedicated workers', async () => {
		const { app, request, repository } = fixture();
		try {
			for (const path of ['index.html', 'player/index.html', 'player/Build/game.worker.js']) {
				const response = await request(path);
				expect(response.statusCode).toBe(204);
				expect(response.headers['x-pcu-runtime-csp']).toBe(runtimeCsp(origin, token, api));
				expect(response.headers['x-pcu-object-path']).toBe('/' + prefix + path);
				expect(response.headers['cache-control']).toBe('private, no-store');
			}
			expect(repository.session).toHaveBeenCalledWith('owner-session');
		} finally { await app.close(); }
	});

	it('retains secret, URI traversal, token/manifest and service-worker denial at the response boundary', async () => {
		const { app, request } = fixture();
		try {
			for (const path of ['../index.html', 'player/%2e%2e/index.html', 'player/%252e%252e/index.html', 'player//index.html', 'player/%5cindex.html', 'player/%00index.html', 'missing/index.html']) {
				expect((await request(path)).statusCode).toBe(403);
			}
			for (const headers of [
				{ 'x-pcu-gateway-secret': 'wrong' }, { 'x-pcu-file-kind': 'protected' },
				{ 'x-pcu-file-uri': `/runtime/${otherToken}/player/index.html` },
				{ 'x-pcu-service-worker': 'script' }, { 'x-pcu-fetch-dest': 'serviceworker' },
			] as Record<string, string>[]) expect((await request('player/index.html', headers)).statusCode).toBe(403);
		} finally { await app.close(); }
	});

	it.each(['revoked', 'expired'] as const)('denies a %s runtime capability including its nested pages', async reason => {
		const { app, request, play } = fixture();
		if (reason === 'revoked') play.revokedAt = new Date();
		else play.expiresAt = new Date(0);
		try { expect((await request('player/index.html')).statusCode).toBe(403); }
		finally { await app.close(); }
	});
});
