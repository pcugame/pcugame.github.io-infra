import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	assertPagesRepositoryBoundary,
	inspectPagesDeploymentAccess,
	verifyPagesRepositoryBoundary,
} from './verify-github-release-boundaries.mjs';

const target = {
	full_name: 'pcugame/pcugame.github.io',
	default_branch: 'master',
	archived: false,
	permissions: { push: true, admin: false },
};
const protection = {
	enforce_admins: { enabled: true },
	allow_deletions: { enabled: false },
	allow_force_pushes: { enabled: true },
	restrictions: { users: [{ login: 'release-bot' }], teams: [], apps: [] },
};

async function withFetch(routes, work, onRequest = () => {}) {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url, init = {}) => {
		const path = new URL(url).pathname;
		calls.push({ path, method: init.method ?? 'GET' });
		onRequest({ path, calls });
		assert.equal(init.method ?? 'GET', 'GET', 'Pages inspection must use GET requests only');
		const route = routes[path];
		assert.ok(route, `unexpected GitHub endpoint: ${path}`);
		return {
			ok: route.status === undefined || route.status < 400,
			status: route.status ?? 200,
			json: async () => route.body,
		};
	};
	try {
		return await work(calls);
	} finally {
		globalThis.fetch = original;
	}
}

function validRoutes(overrides = {}) {
	return {
		'/repos/pcugame/pcugame.github.io': { body: target },
		'/user': { body: { login: 'release-bot' } },
		'/repos/pcugame/pcugame.github.io/branches/master/protection': { body: protection },
		...overrides,
	};
}

test('pages-inspect reports the actual actor and token permissions before reading protection', async () => {
	const output = [];
	await withFetch(validRoutes(), async (calls) => {
		await inspectPagesDeploymentAccess({
			token: 'private-test-token',
			expectedActor: 'release-bot',
			output: (line) => output.push(line),
		});
		assert.deepEqual(output, [
			'pages_deploy_actor=release-bot',
			'pages_repository_push=true',
			'pages_repository_admin=false',
			'pages_branch_protection=readable',
			'pages_inspection=valid',
		]);
		assert.deepEqual(calls.map((call) => call.path).sort(), [
			'/repos/pcugame/pcugame.github.io',
			'/repos/pcugame/pcugame.github.io/branches/master/protection',
			'/user',
		]);
		assert.doesNotMatch(output.join('\n'), /private-test-token|"permissions"|"restrictions"/);
	}, ({ path }) => {
		if (path.endsWith('/protection')) {
			assert.deepEqual(output, [
				'pages_deploy_actor=release-bot',
				'pages_repository_push=true',
				'pages_repository_admin=false',
			]);
		}
	});
});

test('pages-inspect retains actor and permission diagnostics when PAGES_DEPLOY_ACTOR is absent', async () => {
	await withFetch(validRoutes(), async (calls) => {
		const output = [];
		await assert.rejects(
			inspectPagesDeploymentAccess({ token: 'private-test-token', expectedActor: '', output: (line) => output.push(line) }),
			/PAGES_DEPLOY_ACTOR is required/,
		);
		assert.deepEqual(output.slice(0, 4), [
			'pages_deploy_actor=release-bot',
			'pages_repository_push=true',
			'pages_repository_admin=false',
			'pages_branch_protection=readable',
		]);
		assert.ok(calls.some((call) => call.path.endsWith('/protection')));
	});
});

test('pages-inspect reports the actual actor then fails accurately on configured actor mismatch', async () => {
	await withFetch(validRoutes(), async () => {
		const output = [];
		await assert.rejects(
			inspectPagesDeploymentAccess({ token: 'private-test-token', expectedActor: 'configured-wrong', output: (line) => output.push(line) }),
			/PAGES_DEPLOY_ACTOR/,
		);
		assert.equal(output[0], 'pages_deploy_actor=release-bot');
		assert.doesNotMatch(output.join('\n'), /private-test-token/);
	});
});

test('pages-inspect retains safe diagnostics when protection is unreadable', async () => {
	await withFetch(validRoutes({
		'/repos/pcugame/pcugame.github.io/branches/master/protection': { status: 404, body: { message: 'private branch setting detail' } },
	}), async () => {
		const output = [];
		await assert.rejects(
			inspectPagesDeploymentAccess({ token: 'private-test-token', expectedActor: 'release-bot', output: (line) => output.push(line) }),
			/failed with HTTP 404/,
		);
		assert.deepEqual(output, [
			'pages_deploy_actor=release-bot',
			'pages_repository_push=true',
			'pages_repository_admin=false',
			'pages_branch_protection=unreadable',
		]);
		assert.doesNotMatch(output.join('\n'), /private branch setting detail|private-test-token/);
	});
});

test('the existing Pages verification API retains its strict single-writer behavior', async () => {
	assert.doesNotThrow(() => assertPagesRepositoryBoundary({
		repository: target,
		authenticatedUser: { login: 'release-bot' },
		protection,
		expectedActor: 'release-bot',
	}));
	await withFetch(validRoutes(), async () => {
		await assert.doesNotReject(verifyPagesRepositoryBoundary({ token: 'private-test-token', expectedActor: 'release-bot' }));
	});
});
