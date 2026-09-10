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

/** Pages is a publication target, not a single-account release gate. */
export function assertPagesRepositoryBoundary({ repository }) {
	assertPagesWriteAccess(repository);
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

export async function verifyPagesRepositoryBoundary({ token, fetchImpl = fetch }) {
	if (!token) throw new Error('PAGES_DEPLOY_TOKEN is required');
	const repository = await githubJson(`/repos/${PAGES_REPOSITORY}`, token, fetchImpl);
	assertPagesRepositoryBoundary({ repository });
	return repository;
}

/** Inspect only capabilities needed to publish; no administration scope needed. */
export async function inspectPagesDeploymentAccess({ token, output = console.log, fetchImpl = fetch }) {
	const repository = await verifyPagesRepositoryBoundary({ token, fetchImpl });
	output(`pages_repository=${repository.full_name}`);
	output('pages_repository_push=true');
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
		});
		console.log('External Pages target and deployment write access verified.');
		return;
	}
	if (mode === 'pages-inspect') {
		await inspectPagesDeploymentAccess({
			token: process.env.PAGES_DEPLOY_TOKEN,
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
