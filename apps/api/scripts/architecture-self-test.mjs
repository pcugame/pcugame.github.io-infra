#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(packageRoot, '..', '..');
const guard = path.join(packageRoot, 'scripts', 'architecture-guard.mjs');
const boundaryGuard = path.join(packageRoot, 'scripts', 'assets-boundary-guard.mjs');
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
const ownership = [
	['controller-runtime', 'controller.ts', 'no-controller-runtime'],
	['controller-env', 'controller.ts', 'no-controller-env'],
	['controller-stateful', 'controller.ts', 'no-controller-global-resource'],
	['repository-global-prisma', 'project.repository.ts', 'no-repository-global-prisma'],
	['feature-runtime', 'src/modules/alpha/service.ts', 'no-feature-runtime'],
	['renamed-singleton', 'renamed-factory.ts', 'no-stateful-module-singleton'],
	['renamed-singleton', 'default-client.ts', 'no-stateful-module-singleton'],
	['stateful-import', 'service.ts', 'no-noncomposition-stateful-import'],
	['stateful-import', 'wildcard.ts', 'no-noncomposition-stateful-import'],
];
// Support files are explicit: dropping a case/root from the runner must not
// silently turn its fixture into untested input.
const support = [
	'controller-runtime/feature.runtime.ts',
	'repository-global-prisma/src/lib/prisma.ts',
	'feature-runtime/src/modules/beta/runtime.ts',
	'stateful-import/src/infrastructure/production-ports.ts',
];
function sourceFiles(directory) {
	return readdirSync(path.join(packageRoot, directory), { withFileTypes: true }).flatMap(entry => {
		const file = `${directory}/${entry.name}`;
		return entry.isDirectory() ? sourceFiles(file) : file.endsWith('.ts') ? [file] : [];
	}).sort();
}
function assertInventory(directory, expected) {
	const actual = sourceFiles(directory);
	if (JSON.stringify(actual) !== JSON.stringify([...new Set(expected)].sort())) {
		console.error(`[architecture-self-test] fixture-inventory ${directory}: unmapped or missing fixture`);
		process.exit(1);
	}
}
assertInventory('architecture-fixtures/forbidden', [
	...ownership.map(([dir, file]) => `architecture-fixtures/forbidden/${dir}/${file}`),
	...support.map(file => `architecture-fixtures/forbidden/${file}`),
]);
const dataDirectories = readdirSync(path.join(packageRoot, 'architecture-fixtures/data-plane/forbidden')).sort();
if (JSON.stringify(dataDirectories) !== JSON.stringify(forbidden.map(item => item[1]).sort())) {
	console.error('[architecture-self-test] fixture-inventory data-plane: unmapped or missing case');
	process.exit(1);
}
const allowedEdges = [
	['controller.ts', ['../../src/application/ports.js']],
	['factory.ts', ['../../src/lib/s3.js']],
	['index.ts', ['./factory.js']],
	['project.repository.ts', ['../../src/generated/prisma/client.js']],
	['composition.ts', ['../../src/config/env.js', '../../src/shared/upload-limits.js',
		'../../src/infrastructure/production-ports.js', './index.js', './src/modules/beta/runtime.js']],
	['resource-factory/index.ts', ['../../../src/lib/storage.js']],
	['service.ts', ['../../src/application/ports.js', '../../src/modules/assets/delivery-policy.js']],
	['policy.ts', ['../../src/modules/assets/delivery-policy.js']],
	['src/modules/beta/runtime.ts', []],
];
assertInventory('architecture-fixtures/allowed', allowedEdges.map(([file]) => `architecture-fixtures/allowed/${file}`));
for (const [file, expected] of allowedEdges) {
	const target = `architecture-fixtures/allowed/${file}`;
	const ast = ts.createSourceFile(target, readFileSync(path.join(packageRoot, target), 'utf8'), ts.ScriptTarget.Latest, true);
	const actual = ast.statements.filter(node => (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
		.map(node => node.moduleSpecifier.text).sort();
	if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
		console.error(`[architecture-self-test] allowed-edge-mismatch ${target}`);
		process.exit(1);
	}
}

function run(binary, args) {
	return spawnSync(binary, args, { cwd: packageRoot, encoding: 'utf8' });
}

function output(result) {
	return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

let failed = false;
function assertResolved(target) {
	const result = run(process.execPath, [boundaryGuard, target]);
	if (result.status !== 0) {
		failed = true;
		console.error(`[architecture-self-test] FAIL resolved fixture ${target}: exit=${result.status}`);
		console.error(output(result).trim());
	}
	return result.status === 0;
}
for (const [directory, file, rule] of ownership) {
	const target = `architecture-fixtures/forbidden/${directory}/${file}`;
	const resolved = assertResolved(target);
	const result = run(process.execPath, [guard, target]);
	if (!resolved || result.status !== 1 || !output(result).includes(`[architecture-guard] ${rule} ${target}:`)) {
		failed = true;
		console.error(`[architecture-self-test] FAIL ownership ${target}: expected=${rule} exit=${result.status}`);
		console.error(output(result).trim());
	} else console.log(`[architecture-self-test] PASS ownership ${directory}/${file}: ${rule}`);
}
for (const [name, directory, guardRule, dependencyRule] of forbidden) {
	const target = `architecture-fixtures/data-plane/forbidden/${directory}`;
	const resolved = assertResolved(target);
	const result = run(process.execPath, [guard, target]);
	if (!resolved || result.status !== 1 || !output(result).includes(`[architecture-guard] ${guardRule} `)) {
		failed = true;
		console.error(`[architecture-self-test] FAIL guard ${name}: exit=${String(result.status)} expected=${guardRule}`);
		console.error(output(result).trim());
	} else {
		console.log(`[architecture-self-test] PASS guard ${name}: ${guardRule}`);
	}
	if (!dependencyRule) continue;
	const dependency = run(depcruise, ['--config', '.dependency-cruiser.cjs', target]);
	if (dependency.status !== 1 || !output(dependency).includes(dependencyRule)) {
		failed = true;
		console.error(`[architecture-self-test] FAIL dependency ${name}: exit=${String(dependency.status)} expected=${dependencyRule}`);
		console.error(output(dependency).trim());
	} else {
		console.log(`[architecture-self-test] PASS dependency ${name}: ${dependencyRule}`);
	}
}

const allowed = 'architecture-fixtures/data-plane/allowed';
assertResolved(allowed);
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

const ownershipAllowed = 'architecture-fixtures/allowed';
assertResolved(ownershipAllowed);
for (const [binary, args] of [
	[process.execPath, [guard, ownershipAllowed]],
	[depcruise, ['--config', '.dependency-cruiser.cjs', ownershipAllowed]],
]) {
	const result = run(binary, args);
	if (result.status !== 0) {
		failed = true;
		console.error(`[architecture-self-test] FAIL allowed factory/port graph: exit=${result.status}`);
		console.error(output(result).trim());
	}
}
if (failed) process.exitCode = 1;
else console.log(`[architecture-self-test] PASS data-plane-forbidden=${forbidden.length} ownership-forbidden=${ownership.length} allowed-graphs=2`);
