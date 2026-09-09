#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(packageRoot, '..', '..');
const guard = path.join(packageRoot, 'scripts', 'architecture-guard.mjs');
const depcruise = path.join(workspaceRoot, 'node_modules', '.bin',
	process.platform === 'win32' ? 'depcruise.cmd' : 'depcruise');

const forbidden = [
	['API object read', 'api-object-read', 'no-api-object-body-read'],
	['API object response', 'api-object-send', 'no-api-object-body-send'],
	['API UploadPart relay', 'api-uploadpart-relay', 'no-api-uploadpart-relay'],
	['API processing import', 'api-processing-import', 'no-api-processing-import', 'no-api-processing-import'],
	['API worker import', 'api-worker-import', 'no-api-worker-import', 'no-api-worker-import'],
	['feature storage SDK import', 'feature-storage-sdk', 'no-feature-storage-sdk-import', 'no-feature-storage-sdk-import'],
	['worker API import', 'worker-api-import', 'no-worker-api-import', 'no-worker-api-import'],
];

function run(binary, args) {
	return spawnSync(binary, args, { cwd: packageRoot, encoding: 'utf8' });
}

function output(result) {
	return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

const compatibilityTests = run(process.execPath, ['--test', 'scripts/phase1-architecture-boundary.test.mjs']);
let failed = compatibilityTests.status !== 0;
if (failed) console.error(output(compatibilityTests));
else console.log('[architecture-self-test] PASS exact Phase 1 compatibility boundary regressions');
for (const [name, directory, guardRule, dependencyRule] of forbidden) {
	const target = `architecture-fixtures/data-plane/forbidden/${directory}`;
	const result = run(process.execPath, [guard, target]);
	if (result.status === 0 || !output(result).includes(`[architecture-guard] ${guardRule} `)) {
		failed = true;
		console.error(`[architecture-self-test] FAIL guard ${name}: exit=${String(result.status)} expected=${guardRule}`);
		console.error(output(result).trim());
	} else {
		console.log(`[architecture-self-test] PASS guard ${name}: ${guardRule}`);
	}
	if (!dependencyRule) continue;
	const dependency = run(depcruise, ['--config', '.dependency-cruiser.cjs', target]);
	if (dependency.status === 0 || !output(dependency).includes(dependencyRule)) {
		failed = true;
		console.error(`[architecture-self-test] FAIL dependency ${name}: exit=${String(dependency.status)} expected=${dependencyRule}`);
		console.error(output(dependency).trim());
	} else {
		console.log(`[architecture-self-test] PASS dependency ${name}: ${dependencyRule}`);
	}
}

const allowed = 'architecture-fixtures/data-plane/allowed';
const allowedGuard = run(process.execPath, [guard, allowed]);
if (allowedGuard.status !== 0) {
	failed = true;
	console.error(`[architecture-self-test] FAIL allowed guard: exit=${String(allowedGuard.status)}`);
	console.error(output(allowedGuard).trim());
} else {
	console.log('[architecture-self-test] PASS allowed guard: compatibility redirect, migration HEAD, control operations, worker bounded read');
}

const allowedDependency = run(depcruise, ['--config', '.dependency-cruiser.cjs', allowed]);
if (allowedDependency.status !== 0) {
	failed = true;
	console.error(`[architecture-self-test] FAIL allowed dependency graph: exit=${String(allowedDependency.status)}`);
	console.error(output(allowedDependency).trim());
} else {
	console.log('[architecture-self-test] PASS allowed dependency graph');
}

if (failed) process.exitCode = 1;
else console.log(`[architecture-self-test] PASS forbidden=${forbidden.length} positive=4`);
