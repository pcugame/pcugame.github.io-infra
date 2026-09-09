#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

export const CONTROL_REPOSITORY = 'pcugame/pcugame.github.io-infra';
export const CONTROL_DEFAULT_BRANCH = 'master';
export const PAGES_REPOSITORY = 'pcugame/pcugame.github.io';
export const PAGES_BRANCH = 'master';

export function assertControlWorkflowIdentity({ repository, ref, defaultBranch }) {
	if (repository !== CONTROL_REPOSITORY) {
		throw new Error(`production release is restricted to ${CONTROL_REPOSITORY}`);
	}
	if (defaultBranch !== CONTROL_DEFAULT_BRANCH || ref !== `refs/heads/${CONTROL_DEFAULT_BRANCH}`) {
		throw new Error(`production release must run from the exact ${CONTROL_DEFAULT_BRANCH} default branch`);
	}
}

export function assertPagesWriteAccess(repository) {
	if (repository?.full_name !== PAGES_REPOSITORY || repository?.default_branch !== PAGES_BRANCH || repository?.archived !== false) {
		throw new Error(`Pages target must be the active ${PAGES_REPOSITORY} repository with default branch ${PAGES_BRANCH}`);
	}
	if (repository?.permissions?.push !== true) {
		throw new Error('Pages deployment token requires write access to the target repository');
	}
}

export function assertPagesRepositoryBoundary({ repository, authenticatedUser, protection, expectedActor }) {
	if (repository?.full_name !== PAGES_REPOSITORY || repository?.default_branch !== PAGES_BRANCH || repository?.archived !== false) {
		throw new Error(`Pages target must be the active ${PAGES_REPOSITORY} repository with default branch ${PAGES_BRANCH}`);
	}
	if (!expectedActor || authenticatedUser?.login !== expectedActor) {
		throw new Error('Pages deployment token owner does not match PAGES_DEPLOY_ACTOR');
	}
	if (protection?.enforce_admins?.enabled !== true) {
		throw new Error('Pages master must enforce branch protection for administrators');
	}
	if (protection?.allow_deletions?.enabled !== false) {
		throw new Error('Pages master must forbid deletion');
	}
	// actions-gh-pages publishes an orphaned branch with a force update. Access
	// restrictions below make that capability exclusive to the attested actor.
	if (protection?.allow_force_pushes?.enabled !== true) {
		throw new Error('Pages master must allow its sole deployment actor to force-publish');
	}
	const restrictions = protection?.restrictions;
	const users = restrictions?.users;
	const teams = restrictions?.teams;
	const apps = restrictions?.apps;
	if (!Array.isArray(users) || !Array.isArray(teams) || !Array.isArray(apps)) {
		throw new Error('Pages master push restrictions are absent or unreadable');
	}
	if (users.length !== 1 || users[0]?.login !== expectedActor || teams.length !== 0 || apps.length !== 0) {
		throw new Error('Pages master push restrictions must name exactly the authenticated deployment actor');
	}
}

async function githubJson(path, token, fetchImpl = fetch) {
	const response = await fetchImpl(`https://api.github.com${path}`, {
		headers: {
			Accept: 'application/vnd.github+json',
			Authorization: `Bearer ${token}`,
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': 'pcugame-production-release-boundary',
		},
	});
	if (!response.ok) {
		throw new Error(`GitHub boundary query ${path} failed with HTTP ${response.status}`);
	}
	return response.json();
}

export async function verifyPagesRepositoryBoundary({ token, expectedActor }) {
	if (!token) throw new Error('PAGES_DEPLOY_TOKEN is required for fail-closed Pages verification');
	if (!expectedActor) throw new Error('PAGES_DEPLOY_ACTOR is required for fail-closed Pages verification');
	const [repository, authenticatedUser, protection] = await Promise.all([
		githubJson(`/repos/${PAGES_REPOSITORY}`, token),
		githubJson('/user', token),
		githubJson(`/repos/${PAGES_REPOSITORY}/branches/${PAGES_BRANCH}/protection`, token),
	]);
	assertPagesRepositoryBoundary({ repository, authenticatedUser, protection, expectedActor });
}

function sanitizedActorLogin(value) {
	return typeof value === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(value) ? value : 'unavailable';
}

/**
 * Read-only diagnostic for the token injected into a production workflow.
 * Emit the safe token identity before querying protection so an unavailable
 * protection endpoint still leaves enough evidence to repair configuration.
 */
export async function inspectPagesDeploymentAccess({ token, expectedActor, output = console.log, fetchImpl = fetch }) {
	if (!token) throw new Error('PAGES_DEPLOY_TOKEN is required for Pages inspection');
	const [repository, authenticatedUser] = await Promise.all([
		githubJson(`/repos/${PAGES_REPOSITORY}`, token, fetchImpl),
		githubJson('/user', token, fetchImpl),
	]);
	output(`pages_deploy_actor=${sanitizedActorLogin(authenticatedUser?.login)}`);
	output(`pages_repository_push=${repository?.permissions?.push === true}`);
	output(`pages_repository_admin=${repository?.permissions?.admin === true}`);

	let protection;
	try {
		protection = await githubJson(`/repos/${PAGES_REPOSITORY}/branches/${PAGES_BRANCH}/protection`, token, fetchImpl);
		output('pages_branch_protection=readable');
	} catch (error) {
		output('pages_branch_protection=unreadable');
		throw error;
	}

	assertPagesWriteAccess(repository);
	if (!expectedActor) throw new Error('PAGES_DEPLOY_ACTOR is required for Pages inspection; the actual token actor was printed above');
	assertPagesRepositoryBoundary({ repository, authenticatedUser, protection, expectedActor });
	output('pages_inspection=valid');
}

async function main() {
	const mode = process.argv[2];
	if (mode === 'control') {
		assertControlWorkflowIdentity({
			repository: process.env.GITHUB_REPOSITORY,
			ref: process.env.GITHUB_REF,
			defaultBranch: process.env.GITHUB_DEFAULT_BRANCH,
		});
		console.log('Production control repository and default branch verified.');
		return;
	}
	if (mode === 'pages-write') {
		const token = process.env.PAGES_DEPLOY_TOKEN;
		if (!token) throw new Error('PAGES_DEPLOY_TOKEN is required');
		assertPagesWriteAccess(await githubJson(`/repos/${PAGES_REPOSITORY}`, token));
		console.log('External Pages target and deployment write access verified.');
		return;
	}
	if (mode === 'pages') {
		await verifyPagesRepositoryBoundary({
			token: process.env.PAGES_DEPLOY_TOKEN,
			expectedActor: process.env.PAGES_DEPLOY_ACTOR,
		});
		console.log('External Pages repository single-writer boundary verified.');
		return;
	}
	if (mode === 'pages-inspect') {
		await inspectPagesDeploymentAccess({
			token: process.env.PAGES_DEPLOY_TOKEN,
			expectedActor: process.env.PAGES_DEPLOY_ACTOR,
		});
		return;
	}
	throw new Error('Usage: verify-github-release-boundaries.mjs [control|pages|pages-write|pages-inspect]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(`ERROR: ${error.message}`);
		process.exitCode = 1;
	});
}
