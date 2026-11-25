import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createProviderFixture } from './helpers/nickname-providers.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	LAB_NICKNAME_SYSTEM_PROMPT,
	LabResultSchema,
	LabRunSchema,
	parseLabDataset,
	type LabCase,
	type UserRole,
} from '@pcu/contracts';
import { buildApp } from '../app.js';
import { createProductionBackendContext } from '../backend-context.js';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';
import { defaultTestEnv } from './helpers/app-mocks.js';

describe.runIf(process.env.RUN_POSTGRES_INTEGRATION === 'true')(
	'nickname evaluation lab, real API sessions and independent worker',
	() => {
		let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>;
		let app: FastifyInstance;
		let worker: ChildProcess;
		let workerClosed: Promise<unknown>;
		const fake = createProviderFixture();
		const origin = 'http://localhost:5173';
		const cookies: Partial<Record<UserRole | 'second', string>> = {};
		const ids: Partial<Record<UserRole | 'second', number>> = {};
		let dataset: string;
		let rows: LabCase[];
		let id: string;
		let smoke: string;
		let full: string;
		const prompt = LAB_NICKNAME_SYSTEM_PROMPT;

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
		async function startRun(size: number, searchMode: string) {
			return (
				await api('POST', '/runs', 202, {
					datasetId: id,
					size,
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
			expect(await api('GET', '/datasets')).toEqual([]);
			expect(await api('GET', '/runs')).toEqual([]);
			dataset = Array.from({ length: 57 }, (_, i) =>
				JSON.stringify({
					id: 'case-' + i,
					nickname: '가상모호닉네임' + i,
					reference: { expectedReason: 'SECRET_REASON_' + i, expectedScore: 50 },
				}),
			).join('\n');
			rows = parseLabDataset(dataset, 'jsonl');
			await api('POST', '/datasets', 400, { name: 'retired format', jsonl: dataset });
			await api('POST', '/datasets', 400, {
				name: 'missing reference',
				format: 'jsonl',
				content: '{"nickname":"가상"}',
			});
			const uploaded = await api('POST', '/datasets', 201, {
				name: 'human dataset',
				format: 'jsonl',
				content: dataset,
			});
			expect(uploaded.version).toBe('3');
			expect(uploaded.count).toBe(57);
			expect(uploaded).not.toHaveProperty('datasetType');
			id = uploaded.id;
			expect(
				(await api('POST', '/datasets', 201, { name: 'same snapshot', format: 'jsonl', content: dataset }))
					.id,
			).toBe(id);
			expect(await api('GET', '/datasets', 200, undefined, 'second')).toEqual([]);
			await api('GET', '/datasets/' + id + '/cases', 404, undefined, 'second');
			expect((await api('GET', '/datasets/' + id + '/cases?page=3')).items).toEqual(rows.slice(50));
			expect((await api('GET', '/datasets/' + id + '/cases?q=no-such-nickname-in-fixture')).items).toEqual(
				[],
			);
		});

		it('runs 1, 10 and 57 cases in a separate process, persists progress and exports by case identity', async () => {
			smoke = await startRun(1, 'model_tool_call');
			expect((await api('GET', '/runs/' + smoke)).status).toBe('QUEUED');
			const last = rows[56]!;
			const ten = await startRun(10, 'backend_retrieval');
			full = await startRun(57, 'no_search');
			await api('POST', '/runs', 409, {
				datasetId: id,
				size: 1,
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
				output: { sourceIds: ['S1'], score: null },
			});
			expect((await done(ten, 10)).stats.abstained).toBe(10);
			expect((await done(full, 57)).stats).toEqual({ scored: 0, abstained: 57, meanScore: null });
			const filtered = await api('GET', `/runs/${full}/results?status=SUCCEEDED&q=${last.id}`);
			expect(filtered.total).toBe(1);
			expect(filtered.items[0].caseId).toBe(last.id);
			const comparison = await api('GET', `/compare?left=${ten}&right=${full}`);
			expect(comparison.total).toBe(57);
			expect(await api('GET', `/compare?left=${ten}&right=${full}&q=absent-nickname`)).toEqual({
				items: [],
				total: 0,
			});
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
			const exportedRows = LabResultSchema.array().parse(JSON.parse(exported.content).results);
			expect(exportedRows.map((row) => row.testCase)).toEqual(rows);
			expect(exportedRows.map((row) => row.output?.nickname)).toEqual(rows.map((row) => row.nickname));
			const jsonl = await api('GET', `/runs/${full}/export?format=jsonl`);
			expect(jsonl.content.trim().split('\n')).toHaveLength(57);
			const csv = await api('GET', `/runs/${smoke}/export?format=csv`);
			expect(csv.content).toContain('runId,caseId');
		}, 120_000);

		it('imports human research CSV/JSONL, protects references, selects splits and exports resolved evidence', async () => {
			const data = [
				{
					id: 'SECRET_ID_1',
					nickname: '가상연구하나',
					reference: {
						expectedReason: 'SECRET_REASON',
						expectedScore: 79,
						scoreRange: [65, 85],
						sources: ['https://example.org/SECRET_REFERENCE'],
					},
					familyId: 'SECRET_FAMILY',
					tags: ['SECRET_TAG'],
					split: 'train',
				},
				{
					id: 'SECRET_ID_2',
					nickname: '가상모호닉네임',
					reference: { expectedReason: 'SECRET_UNCERTAIN', expectedScore: 50 },
					split: 'train',
				},
				{
					id: 'SECRET_ID_3',
					nickname: '가상일반닉네임',
					reference: { expectedReason: 'SECRET_NEUTRAL', expectedScore: 0 },
					split: 'test',
				},
			];
			const input = {
				name: 'Human research',
				format: 'jsonl',
				content: data.map((r) => JSON.stringify(r)).join('\n'),
			};
			const uploaded = await api('POST', '/datasets', 201, input);
			expect(uploaded).toMatchObject({
				count: 3,
				schemaVersion: '3',
				version: '3',
			});
			expect((await api('POST', '/datasets', 201, input)).id).toBe(uploaded.id);
			const preview = await api('GET', `/datasets/${uploaded.id}/cases?split=train`);
			expect(preview.items.map((r: { id: string }) => r.id)).toEqual(['SECRET_ID_1', 'SECRET_ID_2']);
			expect(preview.items[0].reference).toEqual(data[0]!.reference);
			expect((await api('GET', `/datasets/${uploaded.id}/cases?q=가상일반`)).total).toBe(1);
			expect((await api('GET', `/datasets/${uploaded.id}/cases?split=validation`)).items).toEqual([]);
			await api('GET', `/datasets/${uploaded.id}/cases`, 404, undefined, 'second');
			const csv = await api('POST', '/datasets', 201, {
				name: 'CSV',
				format: 'csv',
				content: 'nickname,expectedReason,expectedScore\r\n가상CSV,"가설, 인용",0\r\n',
				defaultSplit: 'test',
			});
			expect((await api('GET', `/datasets/${csv.id}/cases`)).items[0]).toMatchObject({
				id: 'nick-0001',
				split: 'test',
				reference: { expectedScore: 0, expectedReason: '가설, 인용' },
			});
			const settings = {
				datasetId: uploaded.id,
				size: 1,
				model: 'fixture-8b',
				temperature: 0,
				maxTokens: 256,
				searchMode: 'no_search',
			};
			await api('POST', '/runs', 400, { ...settings, systemPrompt: 'SECRET_PROMPT_ANSWER' });
			await api('POST', '/runs', 400, { ...settings, split: 'validation' });
			await api('POST', '/runs', 400, { ...settings, split: 'test', caseIds: ['SECRET_ID_1'] });
			await api('POST', '/runs', 400, { ...settings, size: 4 });
			const start = fake.requests.length;
			let previous = '';
			for (const searchMode of ['no_search', 'backend_retrieval', 'model_tool_call']) {
				const { runId } = await api('POST', '/runs', 202, {
					...settings,
					searchMode,
					size: 2,
					split: 'train',
				});
				const run = await done(runId, 2);
				expect(run).toMatchObject({
					schemaVersion: '3',
					evaluationProtocol: 'nickname-risk-v1',
					split: 'train',
					stats: { scored: 1, meanScore: 62, abstained: 1 },
				});
				const results = (await api('GET', `/runs/${runId}/results`)).items;
				expect(results[0].output).toMatchObject({
					schemaVersion: '2',
					nickname: data[0]!.nickname,
					score: 62,
					confidence: 0.4,
				});
				expect(results[0].testCase.reference.expectedReason).toBe('SECRET_REASON');
				expect((await api('GET', `/runs/${runId}/results?q=absent-nickname`)).items).toEqual([]);
				for (const format of searchMode === 'model_tool_call' ? ['json', 'jsonl', 'csv'] : ['json']) {
					const file = await api('GET', `/runs/${runId}/export?format=${format}`);
					expect(file.content).toContain('SECRET_REASON');
					if (searchMode !== 'no_search') {
						expect(file.content).toContain('https://example.org/test-source');
						expect(file.content).toContain('Synthetic test excerpt');
						expect(results[0].output.sourceIds).toEqual(['S1']);
					}
				}
				if (previous) expect((await api('GET', `/compare?left=${previous}&right=${runId}`)).total).toBe(2);
				await api('GET', `/compare?left=${smoke}&right=${runId}`, 400);
				previous = runId;
			}
			const { runId } = await api('POST', '/runs', 202, { ...settings, size: 3, finalTest: true });
			await done(runId, 3);
			const outbound = fake.requests.slice(start).join('\n');
			expect(outbound).toContain(data[0]!.nickname);
			expect(outbound).not.toMatch(/SECRET_|expectedReason|expectedScore|familyId|finalTest|"split"|"tags"/);
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
			const cancelled = await startRun(57, 'no_search');
			await api('POST', `/runs/${cancelled}/cancel`, 404, undefined, 'second');
			await api('POST', `/runs/${cancelled}/cancel`);
			expect((await api('GET', '/runs/' + cancelled)).status).toBe('CANCELLED');
		});
	},
);
