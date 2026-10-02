import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';

const enabled = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';

async function assertRetiredRollbackRejected(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), 'visibility-rollback-'));
	try {
		const bin = join(root, 'bin');
		const marker = join(root, 'runtime-access');
		await mkdir(bin);
		// Any configuration or runtime access is a regression, even if the
		// command ultimately fails. Stubs prevent real host operations.
		await writeFile(join(root, '.env'), 'printf "configuration\\n" >> "$RETIRED_RUNTIME_MARKER"\n');
		for (const command of ['podman', 'systemctl']) {
			await writeFile(join(bin, command), '#!/bin/sh\nprintf "runtime\\n" >> "$RETIRED_RUNTIME_MARKER"\nexit 97\n', { mode: 0o700 });
		}
		for (const command of ['rollback', 'authorize-phase1-rollback']) {
			const result = spawnSync('bash', [new URL('../../../../server/deploy.sh', import.meta.url).pathname, command, 'a'.repeat(64)], {
				encoding: 'utf8',
				timeout: 5000,
				env: { ...process.env, DEPLOY_DIR: root, PATH: `${bin}:${process.env['PATH']}`, RETIRED_RUNTIME_MARKER: marker },
			});
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(1);
			expect(result.stdout).toContain('Usage:');
			expect(result.stderr).toBe('');
			await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe('visibility rollback command boundary', () => {
	it('rejects retired rollback entrypoints before configuration or runtime access', assertRetiredRollbackRejected);
});

describe.runIf(enabled)('visibility forward-only release fence', () => {
	let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>;
	let db: PrismaClient;
	beforeAll(async () => {
		database = await createIsolatedMigratedDatabase(process.env['DATABASE_URL']!);
		db = database.createClient();
	});
	afterAll(async () => { await database?.close(); });
	it('rejects legacy rollback and preserves public or restricted exhibition/project data', async () => {
		const user = await db.user.create({ data: { googleSub: randomUUID(), email: `${randomUUID()}@test.invalid` } });
		const exhibition = await db.exhibition.create({ data: { year: 2026, title: randomUUID() } });
		const project = await db.project.create({ data: { exhibitionId: exhibition.id, creatorId: user.id, slug: 'rollback', title: 'rollback' } });
		const assertRejectedWithVisibility = async (exhibitionVisibility: 'PUBLIC' | 'AUTHENTICATED', projectVisibility: 'PUBLIC' | 'STAFF') => {
			const before = {
				exhibition: await db.exhibition.findUniqueOrThrow({ where: { id: exhibition.id } }),
				project: await db.project.findUniqueOrThrow({ where: { id: project.id } }),
			};
			expect(before.exhibition.visibility).toBe(exhibitionVisibility);
			expect(before.project.visibility).toBe(projectVisibility);
			await assertRetiredRollbackRejected();
			expect(await db.exhibition.findUniqueOrThrow({ where: { id: exhibition.id } })).toEqual(before.exhibition);
			expect(await db.project.findUniqueOrThrow({ where: { id: project.id } })).toEqual(before.project);
		};
		await assertRejectedWithVisibility('PUBLIC', 'PUBLIC');
		await db.exhibition.update({ where: { id: exhibition.id }, data: { visibility: 'AUTHENTICATED' } });
		await assertRejectedWithVisibility('AUTHENTICATED', 'PUBLIC');
		await db.exhibition.update({ where: { id: exhibition.id }, data: { visibility: 'PUBLIC' } });
		await db.project.update({ where: { id: project.id }, data: { visibility: 'STAFF' } });
		await assertRejectedWithVisibility('PUBLIC', 'STAFF');
	});
});
