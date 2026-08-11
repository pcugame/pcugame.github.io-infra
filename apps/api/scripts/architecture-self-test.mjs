#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guard = path.join(packageRoot, 'scripts', 'architecture-guard.mjs');
const workspaceRoot = path.resolve(packageRoot, '..', '..');
const dependencyCruiser = path.join(
	workspaceRoot,
	'node_modules',
	'.bin',
	process.platform === 'win32' ? 'depcruise.cmd' : 'depcruise',
);

const forbiddenCases = [
	{
		name: 'controller runtime import',
		target: 'architecture-fixtures/forbidden/controller-runtime',
		guardRule: 'no-controller-runtime',
		dependencyRule: 'controllers-and-indexes-do-not-use-runtime-or-env',
	},
	{
		name: 'controller env import',
		target: 'architecture-fixtures/forbidden/controller-env',
		guardRule: 'no-controller-env',
		dependencyRule: 'controllers-and-indexes-do-not-use-runtime-or-env',
	},
	{
		name: 'controller stateful resource import',
		target: 'architecture-fixtures/forbidden/controller-stateful',
		guardRule: 'no-controller-global-resource',
		dependencyRule: 'controllers-and-indexes-do-not-use-global-resources',
	},
	{
		name: 'index resource re-export',
		target: 'architecture-fixtures/forbidden/index-reexport',
		guardRule: 'no-index-resource-reexport',
		dependencyRule: 'controllers-and-indexes-do-not-use-global-resources',
	},
	{
		name: 'repository global Prisma import',
		target: 'architecture-fixtures/forbidden/repository-global-prisma',
		guardRule: 'no-repository-global-prisma',
		dependencyRule: 'repositories-do-not-use-global-prisma',
	},
	{
		name: 'feature runtime import',
		target: 'architecture-fixtures/forbidden/feature-runtime',
		guardRule: 'no-feature-runtime',
		dependencyRule: 'features-do-not-use-runtime',
	},
	{
		name: 'renamed singleton factory',
		target: 'architecture-fixtures/forbidden/renamed-singleton/renamed-factory.ts',
		guardRule: 'no-stateful-module-singleton',
	},
	{
		name: 'renamed default client',
		target: 'architecture-fixtures/forbidden/renamed-singleton/default-client.ts',
		guardRule: 'no-stateful-module-singleton',
	},
	{
		name: 'non-composition stateful alias',
		target: 'architecture-fixtures/forbidden/stateful-import/service.ts',
		guardRule: 'no-noncomposition-stateful-import',
	},
	{
		name: 'wildcard stateful re-export',
		target: 'architecture-fixtures/forbidden/stateful-import/wildcard.ts',
		guardRule: 'no-noncomposition-stateful-import',
	},
];

function runGuard(target) {
	return spawnSync(process.execPath, [guard, target], {
		cwd: packageRoot,
		encoding: 'utf8',
	});
}

function runDependencyCruiser(target) {
	return spawnSync(
		dependencyCruiser,
		['--config', '.dependency-cruiser.cjs', target],
		{
			cwd: packageRoot,
			encoding: 'utf8',
		},
	);
}

function outputOf(result) {
	return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

let failed = false;
for (const fixture of forbiddenCases) {
	const result = runGuard(fixture.target);
	const output = outputOf(result);
	if (
		result.status === 0
		|| !output.includes(`[architecture-guard] ${fixture.guardRule} `)
	) {
		failed = true;
		console.error(
			`[architecture-self-test] FAIL guard ${fixture.name}: expected non-zero and ${fixture.guardRule}, got exit=${String(result.status)}`,
		);
		console.error(output.trim());
		continue;
	}
	console.log(
		`[architecture-self-test] PASS guard ${fixture.name}: exit=${result.status} rule=${fixture.guardRule}`,
	);
}

const dependencyCases = forbiddenCases.filter((fixture) => fixture.dependencyRule);
for (const fixture of dependencyCases) {
	const result = runDependencyCruiser(fixture.target);
	const output = outputOf(result);
	if (
		result.status === 0
		|| !output.includes(fixture.dependencyRule)
	) {
		failed = true;
		console.error(
			`[architecture-self-test] FAIL dependency-cruiser ${fixture.name}: expected non-zero and ${fixture.dependencyRule}, got exit=${String(result.status)}`,
		);
		console.error(output.trim());
		continue;
	}
	console.log(
		`[architecture-self-test] PASS dependency-cruiser ${fixture.name}: exit=${result.status} rule=${fixture.dependencyRule}`,
	);
}

const allowedGuard = runGuard('architecture-fixtures/allowed');
if (allowedGuard.status !== 0) {
	failed = true;
	console.error(
		`[architecture-self-test] FAIL guard allowed factory/port graph: expected exit=0, got exit=${String(allowedGuard.status)}`,
	);
	console.error(outputOf(allowedGuard).trim());
} else {
	console.log('[architecture-self-test] PASS guard allowed factory/port graph: exit=0');
}

const allowedDependency = runDependencyCruiser('architecture-fixtures/allowed');
if (allowedDependency.status !== 0) {
	failed = true;
	console.error(
		`[architecture-self-test] FAIL dependency-cruiser allowed factory/port graph: expected exit=0, got exit=${String(allowedDependency.status)}`,
	);
	console.error(outputOf(allowedDependency).trim());
} else {
	console.log(
		'[architecture-self-test] PASS dependency-cruiser allowed factory/port graph: exit=0',
	);
}

if (failed) {
	process.exitCode = 1;
} else {
	console.log(
		`[architecture-self-test] PASS guard-forbidden=${forbiddenCases.length} dependency-forbidden=${dependencyCases.length} allowed-runners=2`,
	);
}
