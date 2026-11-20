import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createProviderFixture } from './helpers/term-origin-providers.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LabResultSchema, LabRunSchema, parseLabJsonl, type LabCase, type UserRole } from '@pcu/contracts';
import { buildApp } from '../app.js';
import { createProductionBackendContext } from '../backend-context.js';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';
import { defaultTestEnv } from './helpers/app-mocks.js';

describe.runIf(process.env.RUN_POSTGRES_INTEGRATION === 'true')(
	'term origin lab, real API sessions and independent worker',
	() => {
		let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>;
		let app: FastifyInstance;
		let worker: ChildProcess;
		let workerClosed: Promise<unknown>;
		const fake = createProviderFixture();
		const origin = 'http://localhost:5173';
		const cookies: Partial<Record<UserRole | 'second', string>> = {};
		const ids: Partial<Record<UserRole | 'second', number>> = {};
		const datasetPath = new URL('../../../../benchmarks/term-origins/benchmark-500.jsonl', import.meta.url);
		let dataset: string;
		let rows: LabCase[];
		let id: string;
		let smoke: string;
		let full: string;
		const prompt = '  Analyze the phrase in context.\nKeep uncertainty explicit.  ';

		async function call(
			method: 'GET' | 'POST' | 'PATCH',
			url: string,
			role?: keyof typeof cookies,
			payload?: object,
		) {
			return app.inject({
				method,
				url,
				headers: { origin, ...(role ? { cookie: cookies[role] } : {}) },
				payload,
			});
		}
		async function api(
			method: 'GET' | 'POST' | 'PATCH',
			path: string,
			status = 200,
			payload?: object,
			role: keyof typeof cookies = 'BETA_TESTER',
		) {
			const r = await call(method, '/api/lab' + path, role, payload);
			expect(r.statusCode, r.statusCode === status ? path : r.body.slice(0, 400)).toBe(status);
			return r.json().data;
		}
		async function startRun(size: 1 | 10 | 500, searchMode: string, systemPrompt = prompt) {
			return (
				await api('POST', '/runs', 202, {
					datasetId: id,
					size,
					systemPrompt,
					model: 'fixture-8b',
					searchMode,
					temperature: 0,
					maxTokens: 256,
				})
			).runId as string;
		}
		async function done(runId: string, size: number, success = size) {
			const started = Date.now();
			do {
				const run = LabRunSchema.parse(await api('GET', '/runs/' + runId));
				if (run.status === 'COMPLETED') {
					expect(run.success).toBe(success);
					expect(run.failed).toBe(size - success);
					return run;
				}
				await delay(350);
			} while (Date.now() - started < 90_000 && worker.exitCode === null);
			throw new Error('Worker did not complete the evaluation');
		}

		beforeAll(async () => {
			database = await createIsolatedMigratedDatabase(process.env.DATABASE_URL!);
			fake.server.listen(0, '127.0.0.1');
			await once(fake.server, 'listening');
			const base = 'http://127.0.0.1:' + (fake.server.address() as AddressInfo).port;
			const labEnv = {
				LAB_ENABLED: 'true',
				LAB_MODEL_PROVIDER: 'openai-compatible',
				LAB_CONCURRENCY: '1',
				LAB_MODEL: 'fixture-8b',
				LAB_MODEL_URL: base + '/v1',
				LAB_SEARXNG_URL: base,
			};
			for (const [key, value] of Object.entries(labEnv)) vi.stubEnv(key, value);
			const context = await createProductionBackendContext(
				{
					...defaultTestEnv,
					...labEnv,
					LOG_LEVEL: 'fatal',
					CORS_ALLOWED_ORIGINS: [origin],
					GOOGLE_CLIENT_IDS: ['test-client-id'],
					DEV_AUTH_ENABLED: true,
					DATABASE_URL: database.url,
				},
				{
					factories: {
						googleTokens: () => ({
							verify: async () => ({
								sub: 'lab-google-user',
								email: 'lab@example.test',
								name: 'Lab researcher',
							}),
						}),
					},
				},
			);
			app = await buildApp({ context });
			for (const role of ['ADMIN', 'OPERATOR', 'BETA_TESTER', 'USER'] as const) {
				const login = await call('POST', '/api/dev/auth/login', undefined, { role });
				expect(login.statusCode, login.body).toBe(200);
				cookies[role] = login.cookies[0]!.name + '=' + login.cookies[0]!.value;
				ids[role] = login.json().data.user.id;
			}
			const google = await call('POST', '/api/auth/google', undefined, { credential: 'synthetic-token' });
			expect(google.statusCode, google.body).toBe(200);
			ids.second = google.json().data.user.id;
			cookies.second = google.cookies[0]!.name + '=' + google.cookies[0]!.value;
		}, 60_000);
		afterAll(async () => {
			if (worker && worker.exitCode === null) {
				worker.kill('SIGTERM');
				await workerClosed;
			}
			await app?.close();
			fake.server.closeAllConnections();
			if (fake.server.listening) await new Promise<void>((resolve) => fake.server.close(() => resolve()));
			await database?.close();
			vi.unstubAllEnvs();
		});

		it('enforces lab, staff, owner, origin and role-management boundaries on existing sessions', async () => {
			expect((await call('GET', '/api/lab/status')).statusCode).toBe(401);
			for (const role of ['USER', 'OPERATOR'] as const) await api('GET', '/status', 403, undefined, role);
			await api('GET', '/beta-users', 403);
			await api('PATCH', '/beta-users/' + ids.second, 403, { role: 'BETA_TESTER' });
			const noOrigin = await app.inject({
				method: 'PATCH',
				url: '/api/lab/beta-users/' + ids.second,
				headers: { cookie: cookies.ADMIN },
				payload: { role: 'BETA_TESTER' },
			});
			expect(noOrigin.statusCode).toBe(403);
			for (const role of ['OPERATOR', 'ADMIN'] as const) {
				await api('PATCH', '/beta-users/' + ids[role], 404, { role: 'USER' }, 'ADMIN');
			}
			await api('PATCH', '/beta-users/' + ids.second, 400, { role: 'ADMIN' }, 'ADMIN');
			await api('PATCH', '/beta-users/' + ids.second, 200, { role: 'BETA_TESTER' }, 'ADMIN');
			await api('GET', '/status', 200, undefined, 'second');
			await api('PATCH', '/beta-users/' + ids.second, 200, { role: 'USER' }, 'ADMIN');
			await api('GET', '/status', 403, undefined, 'second');
			await api('PATCH', '/beta-users/' + ids.second, 200, { role: 'BETA_TESTER' }, 'ADMIN');
			const db = database.createClient();
			expect(await db.labRoleAudit.count({ where: { actorId: ids.ADMIN, targetId: ids.second } })).toBe(3);
			expect((await call('GET', '/api/admin/settings', 'BETA_TESTER')).statusCode).toBe(403);
			const me = await call('GET', '/api/me', 'BETA_TESTER');
			expect(me.json().data.user.role).toBe('BETA_TESTER');
			const status = await api('GET', '/status');
			expect(status).toMatchObject({
				model: 'fixture-8b',
				modelStatus: 'available',
				searchStatus: 'available',
				toolSupport: 'unknown',
			});
			expect(status).not.toHaveProperty('modelUrl');
			const exhibition = await db.exhibition.create({ data: { year: 2099, title: 'Submission fixture' } });
			const boundary = randomUUID();
			const project = {
				exhibitionId: exhibition.id,
				title: 'Beta submission',
				members: [{ name: 'Student', studentId: '20260002' }],
				manifest: [],
			};
			const submitted = await app.inject({
				method: 'POST',
				url: '/api/me/projects/submit',
				headers: {
					origin,
					cookie: cookies.BETA_TESTER,
					'idempotency-key': randomUUID(),
					'content-type': 'multipart/form-data; boundary=' + boundary,
				},
				payload:
					'--' +
					boundary +
					'\r\nContent-Disposition: form-data; name="payload"\r\n\r\n' +
					JSON.stringify(project) +
					'\r\n--' +
					boundary +
					'--\r\n',
			});
			expect(submitted.statusCode, submitted.body).toBe(201);
			const own = '/api/me/projects/' + submitted.json().data.id + '/submission';
			expect((await call('GET', own, 'BETA_TESTER')).statusCode).toBe(200);
			expect([403, 404]).toContain((await call('GET', own, 'second')).statusCode);
		});

		it('validates and persists all rows, reuses the snapshot and isolates datasets', async () => {
			dataset = await readFile(datasetPath, 'utf8');
			rows = parseLabJsonl(dataset);
			await api('POST', '/datasets', 400, {
				name: 'invalid',
				jsonl: dataset.trim().split('\n').slice(1).join('\n'),
			});
			const uploaded = await api('POST', '/datasets', 201, { name: 'benchmark-500', jsonl: dataset });
			expect(uploaded.count).toBe(500);
			id = uploaded.id;
			expect((await api('POST', '/datasets', 201, { name: 'same snapshot', jsonl: dataset })).id).toBe(id);
			expect(await api('GET', '/datasets', 200, undefined, 'second')).toEqual([]);
			await api('GET', '/datasets/' + id + '/cases', 404, undefined, 'second');
			expect((await api('GET', '/datasets/' + id + '/cases?page=20')).items).toEqual(rows.slice(475));
		});

		it('runs 1, 10 and 500 cases in a separate process, persists progress and exports by case identity', async () => {
			smoke = await startRun(1, 'model_tool_call');
			expect((await api('GET', '/runs/' + smoke)).status).toBe('QUEUED');
			const last = rows[499]!;
			const ten = await startRun(10, 'backend_retrieval', 'Second prompt');
			full = await startRun(500, 'no_search', 'Third prompt');
			await api('POST', '/runs', 409, {
				datasetId: id,
				size: 1,
				systemPrompt: prompt,
				model: 'fixture-8b',
				searchMode: 'no_search',
				temperature: 0,
				maxTokens: 256,
			});
			worker = spawn(process.execPath, ['--import', 'tsx', 'src/benchmark-worker.ts'], {
				cwd: fileURLToPath(new URL('../../', import.meta.url)),
				stdio: 'inherit',
				env: { ...process.env, DATABASE_URL: database.url },
			});
			workerClosed = once(worker, 'close');
			expect((await done(smoke, 1)).systemPrompt).toBe(prompt);
			const [result] = (await api('GET', `/runs/${smoke}/results`)).items.map((v: unknown) =>
				LabResultSchema.parse(v),
			);
			expect(result).toMatchObject({
				caseId: rows[0]!.id,
				jsonValid: true,
				toolSupport: 'unknown',
				toolSucceeded: true,
				searchCount: 1,
				output: { sourceIds: ['S1'], controversyScore: null },
			});
			expect((await done(ten, 10)).stats.abstained).toBe(10);
			expect((await done(full, 500)).stats).toEqual({ scored: 0, abstained: 500, meanScore: null });
			const filtered = await api('GET', `/runs/${full}/results?status=SUCCEEDED&q=${last.id}`);
			expect(filtered.total).toBe(1);
			expect(filtered.items[0].caseId).toBe(last.id);
			const comparison = await api('GET', `/compare?left=${ten}&right=${full}`);
			expect(comparison.total).toBe(500);
			for (const pair of comparison.items) {
				expect(pair.right.caseId).toBe(pair.caseId);
				if (pair.left) expect(pair.left.caseId).toBe(pair.caseId);
			}
			for (const path of [
				`/runs/${full}`,
				`/runs/${full}/results`,
				`/compare?left=${smoke}&right=${full}`,
				`/runs/${full}/export?format=json`,
			])
				await api('GET', path, 404, undefined, 'second');
			const exported = await api('GET', `/runs/${full}/export?format=json`, 200, undefined, 'ADMIN');
			expect(JSON.parse(exported.content).results).toHaveLength(500);
			const jsonl = await api('GET', `/runs/${full}/export?format=jsonl`);
			expect(jsonl.content.trim().split('\n')).toHaveLength(500);
			const csv = await api('GET', `/runs/${smoke}/export?format=csv`);
			expect(csv.content).toContain('runId,caseId');
		}, 120_000);

		it('persists invalid outputs as failures, retries explicitly and cancels a queued run', async () => {
			fake.setInvalid(true);
			const failed = await startRun(1, 'no_search');
			await done(failed, 1, 0);
			fake.setInvalid(false);
			await api('POST', `/runs/${failed}/retry`, 404, undefined, 'second');
			await api('POST', `/runs/${failed}/retry`);
			await done(failed, 1);
			const after = (await api('GET', `/runs/${failed}/results`)).items[0];
			expect(after.attempts).toBe(2);
			expect(after.history.length).toBeGreaterThanOrEqual(4);
			const cancelled = await startRun(500, 'no_search');
			await api('POST', `/runs/${cancelled}/cancel`, 404, undefined, 'second');
			await api('POST', `/runs/${cancelled}/cancel`);
			expect((await api('GET', '/runs/' + cancelled)).status).toBe('CANCELLED');
		});
	},
);
