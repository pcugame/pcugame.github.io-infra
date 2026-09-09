#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { applyPhase1Boundary, isPhase1RuntimeMarker } from './phase1-architecture-boundary.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = process.argv.length > 2 ? process.argv.slice(2) : ['src', 'scripts'];
const ignored = new Set(['node_modules', 'dist', 'generated', '__tests__']);

const posix = (value) => value.split(path.sep).join('/');
const relative = (value) => posix(path.relative(packageRoot, value));
const withoutExtension = (value) => value.replace(/\.(?:[cm]?[jt]s|tsx|jsx)$/, '');

function collect(target, output) {
	if (ignored.has(path.basename(target))) return;
	const metadata = statSync(target);
	if (metadata.isDirectory()) {
		for (const child of readdirSync(target).sort()) collect(path.join(target, child), output);
		return;
	}
	if (/\.(?:[cm]?ts|tsx)$/.test(target) && !target.endsWith('.d.ts')) output.push(target);
}

const files = [];
for (const target of targets) {
	const absolute = path.resolve(packageRoot, target);
	if (!existsSync(absolute)) {
		console.error(`[architecture-guard] target-not-found ${posix(target)}`);
		process.exitCode = 2;
		continue;
	}
	collect(absolute, files);
}
if (process.exitCode === 2) process.exit();

function importNames(node) {
	const clause = node.importClause;
	if (!clause) return [];
	const names = [];
	if (clause.name) names.push({ typeOnly: clause.isTypeOnly });
	if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
		names.push({ typeOnly: clause.isTypeOnly });
	}
	if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
		for (const element of clause.namedBindings.elements) {
			names.push({ typeOnly: clause.isTypeOnly || element.isTypeOnly });
		}
	}
	return names;
}

function resolveSource(fileName, specifier) {
	if (specifier.startsWith('.')) {
		return withoutExtension(relative(path.resolve(path.dirname(fileName), specifier)));
	}
	return specifier.startsWith('/') ? withoutExtension(relative(specifier)) : specifier;
}

function importsOf(sourceFile, fileName) {
	const edges = [];
	function visit(node) {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			const names = importNames(node);
			edges.push({
				node,
				specifier: node.moduleSpecifier.text,
				source: resolveSource(fileName, node.moduleSpecifier.text),
				runtime: !node.importClause || names.some(({ typeOnly }) => !typeOnly),
			});
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			edges.push({
				node,
				specifier: node.moduleSpecifier.text,
				source: resolveSource(fileName, node.moduleSpecifier.text),
				runtime: !node.isTypeOnly,
			});
		} else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
			&& node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
			edges.push({
				node,
				specifier: node.arguments[0].text,
				source: resolveSource(fileName, node.arguments[0].text),
				runtime: true,
			});
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return edges;
}

const modules = new Map();
const byStem = new Map();
for (const fileName of files.sort()) {
	const file = relative(fileName);
	const sourceFile = ts.createSourceFile(file, readFileSync(fileName, 'utf8'), ts.ScriptTarget.Latest, true,
		file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
	const module = { file, sourceFile, imports: importsOf(sourceFile, fileName) };
	modules.set(file, module);
	byStem.set(withoutExtension(file), module);
}

const isController = (file) => /(?:^|\/)(?:[^/]+\.)?controller\.(?:[cm]?ts|tsx)$/.test(file);
const isApiRoot = (file) => ['src/app.ts', 'src/server.ts', 'src/backend-context.ts'].includes(file) || isController(file);
const isWorkerEntry = (file) => /(?:^|\/)[^/]*worker\.(?:[cm]?ts|tsx)$/.test(file);

function reachable(rootPredicate) {
	const output = new Set();
	const pending = [...modules.values()].filter(({ file }) => rootPredicate(file));
	while (pending.length) {
		const current = pending.pop();
		if (!current || output.has(current.file)) continue;
		output.add(current.file);
		for (const edge of current.imports) {
			const target = edge.runtime && byStem.get(edge.source);
			if (target && !output.has(target.file)) pending.push(target);
		}
	}
	return output;
}

const apiGraph = reachable(isApiRoot);
const workerGraph = reachable(isWorkerEntry);
const isInfrastructure = (file) => file.startsWith('src/infrastructure/')
	|| /^src\/lib\/(?:s3|storage)\.(?:[cm]?ts|tsx)$/.test(file);
const isFeature = (file) => file.startsWith('src/modules/') || file.includes('/src/modules/');
const isWorkerComposition = (file) => workerGraph.has(file) && (isWorkerEntry(file)
	|| /(?:^|\/)(?:composition|[^/]+\.composition)\.(?:[cm]?ts|tsx)$/.test(file));
const isStorageSdk = (source) => source === '@aws-sdk/client-s3' || source === '@aws-sdk/s3-request-presigner';
const isApiOnlySource = (source) => source === 'fastify'
	|| /(?:^|\/)src\/(?:app|server|backend-context)$/.test(source)
	|| /(?:^|\/)(?:[^/]+\.)?controller$/.test(source);
const isWorkerSource = (source) => /(?:^|\/)[^/]*worker(?:\.[^/]+)?$/.test(source)
	|| /(?:^|\/)(?:validation-worker|processing)\.composition$/.test(source)
	|| /(?:^|\/)modules\/(?:video|webgl)\/composition$/.test(source);

function isProcessingSource(source, importer) {
	if (['node:child_process', 'sharp', 'pdf-to-img'].includes(source)) return true;
	if (/(?:^|\/)(?:bounded-)?(?:archive|zip)[^/]*validator$/.test(source)) return true;
	if (source.startsWith('src/modules/archive/')) return true;
	if (source === 'src/infrastructure/project-upload-processing') return true;
	if (/^src\/modules\/assets\/upload\/(?:file-validator|image-processing|pdf-processing|video-processing(?:\.adapter)?|zip-file-validation(?:\.adapter)?)$/.test(source)) return true;
	if (/^src\/modules\/video\/(?:command-runner|composition|ffmpeg-operations|loop|materialize|processor|worker)$/.test(source)) return true;
	if (/^src\/modules\/webgl\/(?:deployment|processing|processing\.composition)$/.test(source)) return true;
	if (/^src\/modules\/admin\/export\/(?:file\.adapter|nas-staging\.adapter|worker|worker-loop)$/.test(source)) return true;
	return /^node:fs(?:\/promises)?$/.test(source) && !isInfrastructure(importer) && !importer.startsWith('src/config/');
}

function unwrap(expression) {
	let current = expression;
	while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
		|| ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)
		|| ts.isSatisfiesExpression(current) || ts.isAwaitExpression(current)) current = current.expression;
	return current;
}

function memberName(expression) {
	const current = unwrap(expression);
	if (ts.isPropertyAccessExpression(current)) return current.name.text;
	if (ts.isElementAccessExpression(current) && current.argumentExpression && ts.isStringLiteral(current.argumentExpression)) {
		return current.argumentExpression.text;
	}
	return ts.isIdentifier(current) ? current.text : undefined;
}

function receiver(expression) {
	const current = unwrap(expression);
	return ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)
		? current.expression.getText() : '';
}

const storageReceiver = (text) => /(?:^|\.)(?:inspector|objectStorage|objectStore|storage)$/.test(text);
const fileReceiver = (text) => /(?:^|\.)(?:fileSystem|fs|fsp)$/.test(text);

function isObjectRead(call) {
	const name = memberName(call.expression);
	const owner = receiver(call.expression);
	return (['getObject', 'readObjectRange', 'readRange', 'stream'].includes(name) && storageReceiver(owner))
		|| (['createReadStream', 'createWriteStream'].includes(name) && (!owner || fileReceiver(owner)));
}

function isObjectWrite(call) {
	return ['putObject', 'upload', 'uploadPart'].includes(memberName(call.expression))
		&& storageReceiver(receiver(call.expression));
}

function collectBodies(sourceFile) {
	const bindings = new Set();
	let changed = true;
	while (changed) {
		changed = false;
		function add(name) {
			if (name && !bindings.has(name)) { bindings.add(name); changed = true; }
		}
		function looksLikeBody(expression) {
			const value = unwrap(expression);
			if (ts.isIdentifier(value)) return bindings.has(value.text);
			if (ts.isCallExpression(value)) return isObjectRead(value);
			return (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value))
				&& ['body', 'stream'].includes(memberName(value));
		}
		function visit(node) {
			if (ts.isVariableDeclaration(node) && node.initializer) {
				if (ts.isIdentifier(node.name) && looksLikeBody(node.initializer)) add(node.name.text);
				if (ts.isObjectBindingPattern(node.name) && looksLikeBody(node.initializer)) {
					for (const element of node.name.elements) {
						const name = memberName(element.propertyName ?? element.name);
						if (['body', 'stream'].includes(name) && ts.isIdentifier(element.name)) add(element.name.text);
					}
				}
			}
			ts.forEachChild(node, visit);
		}
		visit(sourceFile);
	}
	return bindings;
}

function expressionIsBody(expression, bodies) {
	const value = unwrap(expression);
	if (ts.isIdentifier(value)) return bodies.has(value.text) || /^(?:body|objectBody|readable|stream)$/.test(value.text);
	if (ts.isCallExpression(value)) return isObjectRead(value);
	return (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value))
		&& ['body', 'stream'].includes(memberName(value));
}

const inventory = {
	'api-graph-files': apiGraph.size,
	'worker-graph-files': workerGraph.size,
	'api-object-body-reads': 0,
	'api-object-body-sends': 0,
	'api-upload-body-relays': 0,
	'api-processing-imports': 0,
	'feature-storage-sdk-imports': 0,
	'worker-api-imports': 0,
};
let violations = [];
const seen = new Set();

function report(rule, module, node, message) {
	const position = module.sourceFile.getLineAndCharacterOfPosition(node.getStart(module.sourceFile));
	const key = `${rule}\0${module.file}\0${position.line}\0${position.character}`;
	if (seen.has(key)) return;
	seen.add(key);
	violations.push({ rule, file: module.file, line: position.line + 1, column: position.character + 1, message, nodeText: node.getText(module.sourceFile) });
}

for (const module of modules.values()) {
	for (const diagnostic of module.sourceFile.parseDiagnostics) {
		report('architecture-guard-parse-error', module, module.sourceFile,
			ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
	}
	for (const edge of module.imports) {
		if (!edge.runtime) continue;
		if (apiGraph.has(module.file) && isWorkerSource(edge.source)) {
			report('no-api-worker-import', module, edge.node,
				`Fastify graph imports worker composition ${JSON.stringify(edge.specifier)}`);
		}
		if (apiGraph.has(module.file) && isProcessingSource(edge.source, module.file)) {
			inventory['api-processing-imports']++;
			report('no-api-processing-import', module, edge.node,
				`Fastify graph imports byte processing or filesystem authority ${JSON.stringify(edge.specifier)}`);
		}
		if (isFeature(module.file) && isStorageSdk(edge.source) && !isInfrastructure(module.file)
			&& !isWorkerComposition(module.file)) {
			inventory['feature-storage-sdk-imports']++;
			report('no-feature-storage-sdk-import', module, edge.node,
				`feature code imports storage SDK directly from ${JSON.stringify(edge.specifier)}`);
		}
		if (workerGraph.has(module.file) && isApiOnlySource(edge.source)) {
			inventory['worker-api-imports']++;
			report('no-worker-api-import', module, edge.node,
				`worker graph imports Fastify/API-only module ${JSON.stringify(edge.specifier)}`);
		}
	}

	if (!apiGraph.has(module.file) || isInfrastructure(module.file)) continue;
	const bodies = collectBodies(module.sourceFile);
	function inspect(node) {
		if (ts.isCallExpression(node)) {
			const name = memberName(node.expression);
			const owner = receiver(node.expression);
			if (isObjectRead(node)) {
				inventory['api-object-body-reads']++;
				report('no-api-object-body-read', module, node,
					`Fastify graph reads object/file bytes through ${node.expression.getText()}`);
			}
			if (isObjectWrite(node)) {
				inventory['api-upload-body-relays']++;
				report(name === 'uploadPart' ? 'no-api-uploadpart-relay' : 'no-api-object-body-write', module, node,
					`Fastify graph writes client/object bytes through ${node.expression.getText()}`);
			}
			if (['send', 'write', 'end'].includes(name) && /(?:^|\.)(?:raw|reply|res|response)$/.test(owner)
				&& node.arguments.some((argument) => expressionIsBody(argument, bodies))) {
				inventory['api-object-body-sends']++;
				report('no-api-object-body-send', module, node,
					'Fastify response graph sends an object body/stream instead of a capability or redirect');
			}
			if (name === 'pipe' && /(?:^|\.)(?:raw|reply|res|response)$/.test(node.arguments[0]?.getText() ?? '')) {
				inventory['api-object-body-sends']++;
				report('no-api-object-body-send', module, node, 'Fastify response graph pipes bytes to the client');
			}
			if (name === 'pipeline' && node.arguments.some((argument) =>
				/(?:^|\.)(?:raw|reply|res|response)$/.test(argument.getText()))) {
				inventory['api-object-body-sends']++;
				report('no-api-object-body-send', module, node, 'Fastify response graph pipelines bytes to the client');
			}
		}
		if (ts.isNewExpression(node) && ts.isIdentifier(unwrap(node.expression))) {
			if (unwrap(node.expression).text === 'GetObjectCommand') {
				report('no-api-object-body-read', module, node, 'Fastify feature graph constructs GetObjectCommand directly');
			}
			if (unwrap(node.expression).text === 'UploadPartCommand') {
				report('no-api-uploadpart-relay', module, node, 'Fastify feature graph constructs UploadPartCommand directly');
			}
		}
		ts.forEachChild(node, inspect);
	}
	inspect(module.sourceFile);
}

const phase1Marker = modules.get('src/phase1-release-manifest.ts')?.sourceFile.text;
const phase1Boundary = JSON.parse(readFileSync(new URL('./phase1-architecture-boundary.json', import.meta.url), 'utf8'));
const boundary = applyPhase1Boundary(violations, {
	phase1: isPhase1RuntimeMarker(phase1Marker),
	edges: phase1Boundary.edges,
});
violations = boundary.violations;
if (boundary.compatibility.length > 0) {
	console.log(`[architecture-guard] reviewed-phase1-edges=${boundary.compatibility.length} source=${phase1Boundary.sourceCommit}`);
}
violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule));
for (const [name, count] of Object.entries(inventory)) console.log(`[architecture-guard] inventory ${name}=${count}`);
for (const violation of violations) {
	console.error(`[architecture-guard] ${violation.rule} ${violation.file}:${violation.line}:${violation.column} ${violation.message}`);
}
if (violations.length) {
	console.error(`[architecture-guard] FAIL violations=${violations.length} files=${modules.size}`);
	process.exitCode = 1;
} else {
	console.log(`[architecture-guard] PASS violations=0 files=${modules.size}`);
}
