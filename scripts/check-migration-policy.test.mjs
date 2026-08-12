import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./check-migration-policy.mjs', import.meta.url));
const migrationRoot = 'apps/api/prisma/migrations';

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
	if (result.error) throw result.error;
	return result;
}

function git(cwd, ...args) {
	const result = run('git', args, cwd);
	assert.equal(result.status, 0, `git ${args.join(' ')} failed:\n${result.stderr}`);
	return result.stdout.trim();
}

async function writeRepositoryFile(repository, relativePath, contents) {
	const target = path.join(repository, relativePath);
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(target, contents);
}

async function fixture() {
	const repository = await mkdtemp(path.join(tmpdir(), 'migration-policy-'));
	git(repository, 'init', '--initial-branch=master');
	git(repository, 'config', 'user.name', 'Migration Policy Test');
	git(repository, 'config', 'user.email', 'migration-policy@example.invalid');
	await writeRepositoryFile(
		repository,
		`${migrationRoot}/20260101000000_initial/migration.sql`,
		'CREATE TABLE "example" ("id" INTEGER PRIMARY KEY);\n',
	);
	git(repository, 'add', '.');
	git(repository, 'commit', '-m', 'initial migration');
	const base = git(repository, 'rev-parse', 'HEAD');
	git(repository, 'switch', '-c', 'feature');
	return { repository, base };
}

async function withFixture(action) {
	const state = await fixture();
	try {
		return await action(state);
	} finally {
		await rm(state.repository, { recursive: true, force: true });
	}
}

function commitAll(repository, message) {
	git(repository, 'add', '-A');
	git(repository, 'commit', '-m', message);
}

function check(repository, base) {
	return run(process.execPath, [script, base], repository);
}

test('allows a new additive migration without a high-risk signal', async () => {
	await withFixture(async ({ repository, base }) => {
		await writeRepositoryFile(
			repository,
			`${migrationRoot}/20260102000000_add_note/migration.sql`,
			'ALTER TABLE "example" ADD COLUMN "note" TEXT;\n',
		);
		commitAll(repository, 'add migration');
		const result = check(repository, base);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /PASS protected-history=unchanged new-migrations=1 review-signals=0/);
		assert.doesNotMatch(result.stderr, /WARNING/);
	});
});

test('warns but passes for a new destructive migration', async () => {
	await withFixture(async ({ repository, base }) => {
		await writeRepositoryFile(
			repository,
			`${migrationRoot}/20260102000000_drop_note/migration.sql`,
			'ALTER TABLE "example" DROP COLUMN "note";\n',
		);
		commitAll(repository, 'add destructive migration');
		const result = check(repository, base);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stderr, /WARNING .*destructive schema operation/);
		assert.match(result.stdout, /Heuristic warnings are reviewer prompts only/);
	});
});

test('fails when an existing migration is modified', async () => {
	await withFixture(async ({ repository, base }) => {
		await writeRepositoryFile(
			repository,
			`${migrationRoot}/20260101000000_initial/migration.sql`,
			'CREATE TABLE "changed" ("id" INTEGER PRIMARY KEY);\n',
		);
		commitAll(repository, 'rewrite migration');
		const result = check(repository, base);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /ERROR .*status M changes migration history/);
	});
});

test('fails when an existing migration is deleted', async () => {
	await withFixture(async ({ repository, base }) => {
		git(repository, 'rm', `${migrationRoot}/20260101000000_initial/migration.sql`);
		git(repository, 'commit', '-m', 'delete migration');
		const result = check(repository, base);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /ERROR .*status D changes migration history/);
	});
});

test('fails when an existing migration is renamed', async () => {
	await withFixture(async ({ repository, base }) => {
		const oldPath = `${migrationRoot}/20260101000000_initial/migration.sql`;
		const newPath = `${migrationRoot}/20260101000000_renamed/migration.sql`;
		await mkdir(path.dirname(path.join(repository, newPath)), { recursive: true });
		git(repository, 'mv', oldPath, newPath);
		git(repository, 'commit', '-m', 'rename migration');
		const result = check(repository, base);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /ERROR .*status R100 changes migration history/);
	});
});

test('allows unrelated repository changes', async () => {
	await withFixture(async ({ repository, base }) => {
		await writeRepositoryFile(repository, 'README.md', 'unrelated\n');
		commitAll(repository, 'edit readme');
		const result = check(repository, base);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /new-migrations=0 review-signals=0/);
	});
});
