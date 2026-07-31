#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requestedTargets = process.argv.slice(2);
const targetNames = requestedTargets.length > 0 ? requestedTargets : ['src'];

const ignoredDirectoryNames = new Set(['node_modules', 'dist', 'generated', '__tests__']);
const sourceExtensions = /\.(?:[cm]?ts|tsx)$/;

/**
 * The request context is deliberately process-bound: Fastify seeds a separate
 * store for every request and no external resource is opened by constructing it.
 * Keep this allowlist exact (file + binding + constructor). New entries require a
 * lifecycle/ownership explanation here and a review of the architecture fixture.
 */
const statefulAppBoundaryAllowlist = new Map([
	[
		'src/lib/request-context.ts#requestContext',
		{
			creator: 'AsyncLocalStorage',
			reason: 'request-scoped propagation seeded at the Fastify app boundary',
		},
	],
]);

const legacyStatefulExports = new Set([
	'_resetActiveUploads',
	'abortMultipartUpload',
	'acquireUploadSlot',
	'activeUploadCount',
	'bucketForKind',
	'completeMultipartUpload',
	'createMultipartUpload',
	'decInFlight',
	'deleteObject',
	'exportAssets',
	'exportService',
	'gameDownloadLimiter',
	'getExportProgress',
	'getInFlight',
	'getLifecycleState',
	'getObjectStream',
	'getPresignedUrl',
	'getSiteSettings',
	'headObject',
	'incInFlight',
	'isAcceptingNewWork',
	'legacySiteSettingsStore',
	'listObjectKeys',
	'logger',
	'nodeFileSystem',
	'nodeScheduler',
	'objectStorage',
	'prisma',
	'prismaHealth',
	'processLifecycle',
	'processLimiter',
	'processUploadLimiter',
	'productionService',
	'readObjectRange',
	'releaseUploadSlot',
	'rootLogger',
	's3',
	'setLifecycleState',
	'systemClock',
	'cryptoIdGenerator',
	'uploadFile',
	'uploadPart',
	'waitForDrain',
]);

const statefulCreatorNames = new Set([
	'AbortController',
	'AsyncLocalStorage',
	'EventEmitter',
	'Map',
	'OAuth2Client',
	'PrismaClient',
	'S3Client',
	'WeakMap',
	'WeakSet',
	'createCachedSettingsStore',
	'createCryptoIdGenerator',
	'createDownloadRateLimiter',
	'createExportProgressStore',
	'createLifecycle',
	'createLifecyclePort',
	'createNodeFileSystem',
	'createNodeScheduler',
	'createObjectStorage',
	'createPrismaClientForDatabase',
	'createProtectedDownloadLimiter',
	'createRootLogger',
	'createReadStream',
	'createS3Client',
	'createSystemClock',
	'createUploadLimiter',
	'createUploadLimiterPort',
	'createWriteStream',
	'setInterval',
	'setTimeout',
]);

const statefulCreatorPattern =
	/^create[A-Z].*(?:Client|Clock|Coordinator|FileSystem|Generator|Graph|Lifecycle|Limiter|Logger|Pipeline|Repository|Runtime|Scheduler|Service|Storage|Store|Writer)$/;
const statefulConstructorPattern =
	/(?:Client|Coordinator|FileSystem|Lifecycle|Limiter|Logger|Repository|Runtime|Scheduler|Service|Storage|Store)$/;

function posix(value) {
	return value.split(path.sep).join('/');
}

function relativeFileName(fileName) {
	return posix(path.relative(packageRoot, fileName));
}

function collectFiles(targetPath, files) {
	const name = path.basename(targetPath);
	if (ignoredDirectoryNames.has(name)) return;
	const info = statSync(targetPath);
	if (info.isDirectory()) {
		for (const child of readdirSync(targetPath).sort()) {
			collectFiles(path.join(targetPath, child), files);
		}
		return;
	}
	if (info.isFile() && sourceExtensions.test(targetPath) && !targetPath.endsWith('.d.ts')) {
		files.push(path.resolve(targetPath));
	}
}

const files = [];
for (const targetName of targetNames) {
	const targetPath = path.resolve(packageRoot, targetName);
	if (!existsSync(targetPath)) {
		console.error(`[architecture-guard] target-not-found ${posix(targetName)}`);
		process.exitCode = 2;
		continue;
	}
	collectFiles(targetPath, files);
}

if (process.exitCode === 2) process.exit();

files.sort();

function stripSourceExtension(value) {
	return value.replace(/\.(?:[cm]?[jt]s|tsx|jsx)$/, '');
}

function resolveModuleSource(fileName, moduleSpecifier) {
	if (moduleSpecifier.startsWith('.')) {
		return stripSourceExtension(
			posix(path.relative(packageRoot, path.resolve(path.dirname(fileName), moduleSpecifier))),
		);
	}
	if (moduleSpecifier.startsWith('/')) {
		return stripSourceExtension(posix(path.relative(packageRoot, moduleSpecifier)));
	}
	return stripSourceExtension(moduleSpecifier);
}

function isRuntimeSource(source) {
	return /(?:^|\/)(?:runtime|[^/]+\.runtime)$/.test(source);
}

function isEnvSource(source) {
	return source === 'src/config/env' || source.endsWith('/src/config/env');
}

function isGlobalPrismaSource(source) {
	return source === 'src/lib/prisma' || source.endsWith('/src/lib/prisma');
}

function isStatefulBoundarySource(source) {
	return (
		/(?:^|\/)src\/infrastructure\/production-ports$/.test(source)
		|| /(?:^|\/)src\/shared\/(?:download-rate-limit|protected-download-limiter|site-settings|upload-limits)$/.test(source)
	);
}

function isGlobalResourceSource(source) {
	return (
		isGlobalPrismaSource(source)
		|| /(?:^|\/)src\/lib\/(?:lifecycle|logger|s3|storage)$/.test(source)
		|| source === 'src/object-deletion'
		|| source.endsWith('/src/object-deletion')
		|| isStatefulBoundarySource(source)
		|| isRuntimeSource(source)
	);
}

function isLegacyStatefulSource(source) {
	return (
		isGlobalResourceSource(source)
		|| /(?:^|\/)src\/modules\/admin\/export\/service$/.test(source)
	);
}

function isStatefulAdapterSource(source) {
	return (
		isLegacyStatefulSource(source)
		|| source === '@aws-sdk/client-s3'
		|| source === '@prisma/client'
		|| source === 'google-auth-library'
		|| /(?:^|\/)src\/generated\/prisma\/client$/.test(source)
		|| /(?:^|\/)src\/lib\/prisma-client$/.test(source)
	);
}

function isControllerFile(file) {
	return /(?:^|\/)(?:[^/]+\.)?controller\.(?:[cm]?ts|tsx)$/.test(file);
}

function isIndexFile(file) {
	return /(?:^|\/)index\.(?:[cm]?ts|tsx)$/.test(file);
}

function isRepositoryFile(file) {
	return /(?:^|\/)(?:[^/]+\.)?repository\.(?:[cm]?ts|tsx)$/.test(file);
}

function isFeatureFile(file) {
	return file.startsWith('src/modules/') || file.includes('/src/modules/');
}

function isCompositionRoot(file) {
	return (
		file === 'src/app.ts'
		|| file === 'src/backend-context.ts'
		|| file === 'src/server.ts'
		|| file.startsWith('src/infrastructure/')
		|| /(?:^|\/)(?:composition|[^/]+\.composition)\.(?:[cm]?ts|tsx)$/.test(file)
	);
}

function importedNames(importDeclaration) {
	const clause = importDeclaration.importClause;
	if (!clause) return [];
	const names = [];
	if (clause.name) {
		names.push({
			imported: 'default',
			local: clause.name.text,
			typeOnly: clause.isTypeOnly,
		});
	}
	const bindings = clause.namedBindings;
	if (bindings && ts.isNamespaceImport(bindings)) {
		names.push({
			imported: '*',
			local: bindings.name.text,
			typeOnly: clause.isTypeOnly,
		});
	}
	if (bindings && ts.isNamedImports(bindings)) {
		for (const element of bindings.elements) {
			names.push({
				imported: element.propertyName?.text ?? element.name.text,
				local: element.name.text,
				typeOnly: clause.isTypeOnly || element.isTypeOnly,
			});
		}
	}
	return names;
}

function exportedNames(exportDeclaration) {
	const clause = exportDeclaration.exportClause;
	if (!clause || !ts.isNamedExports(clause)) {
		return [{ imported: '*', local: '*', typeOnly: exportDeclaration.isTypeOnly }];
	}
	return clause.elements.map((element) => ({
		imported: element.propertyName?.text ?? element.name.text,
		local: element.name.text,
		typeOnly: exportDeclaration.isTypeOnly || element.isTypeOnly,
	}));
}

function collectDependencies(sourceFile, fileName) {
	const edges = [];
	const bindings = new Map();

	function addEdge(node, moduleSpecifier, kind, names) {
		const source = resolveModuleSource(fileName, moduleSpecifier);
		edges.push({ node, moduleSpecifier, source, kind, names });
		if (kind !== 'import') return;
		for (const name of names) {
			bindings.set(name.local, {
				imported: name.imported,
				source,
				typeOnly: name.typeOnly,
			});
		}
	}

	function visit(node) {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			addEdge(
				node,
				node.moduleSpecifier.text,
				'import',
				importedNames(node),
			);
		} else if (
			ts.isExportDeclaration(node)
			&& node.moduleSpecifier
			&& ts.isStringLiteral(node.moduleSpecifier)
		) {
			addEdge(
				node,
				node.moduleSpecifier.text,
				'export',
				exportedNames(node),
			);
		} else if (
			ts.isCallExpression(node)
			&& node.expression.kind === ts.SyntaxKind.ImportKeyword
			&& node.arguments.length === 1
			&& ts.isStringLiteral(node.arguments[0])
		) {
			addEdge(
				node,
				node.arguments[0].text,
				'dynamic-import',
				[{ imported: '*', local: '*', typeOnly: false }],
			);
		}
		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return { edges, bindings };
}

function unwrapExpression(expression) {
	let current = expression;
	while (
		ts.isParenthesizedExpression(current)
		|| ts.isAsExpression(current)
		|| ts.isTypeAssertionExpression(current)
		|| ts.isNonNullExpression(current)
		|| ts.isSatisfiesExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function describeCallee(expression, bindings) {
	const callee = unwrapExpression(expression);
	if (ts.isIdentifier(callee)) {
		const binding = bindings.get(callee.text);
		return {
			name: binding?.imported ?? callee.text,
			local: callee.text,
			source: binding?.source,
		};
	}
	if (ts.isPropertyAccessExpression(callee)) {
		if (ts.isIdentifier(callee.expression)) {
			const binding = bindings.get(callee.expression.text);
			if (binding?.imported === '*') {
				return {
					name: callee.name.text,
					local: `${callee.expression.text}.${callee.name.text}`,
					source: binding.source,
				};
			}
		}
		return { name: callee.name.text, local: callee.getText(), source: undefined };
	}
	if (
		ts.isElementAccessExpression(callee)
		&& ts.isIdentifier(callee.expression)
		&& callee.argumentExpression
		&& ts.isStringLiteral(callee.argumentExpression)
	) {
		const binding = bindings.get(callee.expression.text);
		return {
			name: callee.argumentExpression.text,
			local: `${callee.expression.text}[${JSON.stringify(callee.argumentExpression.text)}]`,
			source: binding?.source,
		};
	}
	return { name: callee.getText(), local: callee.getText(), source: undefined };
}

function isStatefulCreator(descriptor) {
	if (statefulCreatorNames.has(descriptor.name)) return true;
	if (statefulCreatorPattern.test(descriptor.name)) return true;
	if (statefulConstructorPattern.test(descriptor.name)) return true;
	return (
		(descriptor.name === 'default' || descriptor.name === '*')
		&& descriptor.source !== undefined
		&& isStatefulAdapterSource(descriptor.source)
	);
}

function findImmediateStatefulCreation(expression, bindings) {
	let found;

	function visit(node, immediatelyExecuted = false) {
		if (found) return;
		const current = ts.isExpression(node) ? unwrapExpression(node) : node;

		if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
			const descriptor = describeCallee(current.expression, bindings);
			if (isStatefulCreator(descriptor)) {
				found = {
					creator: descriptor.name,
					text: descriptor.local,
				};
				return;
			}
			if (
				ts.isCallExpression(current)
				&& (
					ts.isArrowFunction(unwrapExpression(current.expression))
					|| ts.isFunctionExpression(unwrapExpression(current.expression))
				)
			) {
				visit(unwrapExpression(current.expression), true);
			}
			for (const argument of current.arguments ?? []) visit(argument);
			return;
		}

		if (ts.isFunctionLike(current) && !immediatelyExecuted) return;
		if (ts.isFunctionLike(current) && immediatelyExecuted) {
			if (current.body) visit(current.body);
			return;
		}

		ts.forEachChild(current, (child) => visit(child));
	}

	visit(expression);
	return found;
}

function referencesGlobalPrisma(expression, bindings) {
	let found = false;
	function visit(node) {
		if (found) return;
		if (ts.isIdentifier(node)) {
			const binding = bindings.get(node.text);
			if (binding && isGlobalPrismaSource(binding.source)) {
				found = true;
				return;
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(expression);
	return found;
}

const inventory = {
	'runtime-files': 0,
	'controller-runtime-imports': 0,
	'controller-env-imports': 0,
	'repository-global-prisma-imports': 0,
	'non-composition-stateful-imports': 0,
	'feature-runtime-imports': 0,
};
const violations = [];
const violationKeys = new Set();

function addViolation(rule, file, node, message) {
	const sourceFile = node.getSourceFile();
	const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
	const key = `${rule}\0${file}\0${location.line}\0${message}`;
	if (violationKeys.has(key)) return;
	violationKeys.add(key);
	violations.push({
		rule,
		file,
		line: location.line + 1,
		column: location.character + 1,
		message,
	});
}

function dependencyDescription(edge) {
	return `${edge.kind} ${JSON.stringify(edge.moduleSpecifier)}`;
}

for (const fileName of files) {
	const file = relativeFileName(fileName);
	const sourceFile = ts.createSourceFile(
		file,
		readFileSync(fileName, 'utf8'),
		ts.ScriptTarget.Latest,
		true,
		file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const { edges, bindings } = collectDependencies(sourceFile, fileName);

	for (const diagnostic of sourceFile.parseDiagnostics) {
		const node = diagnostic.start === undefined
			? sourceFile
			: findNodeAtPosition(sourceFile, diagnostic.start);
		addViolation(
			'architecture-guard-parse-error',
			file,
			node,
			ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
		);
	}

	if (/\.runtime\.(?:[cm]?ts|tsx)$/.test(file)) {
		inventory['runtime-files']++;
		addViolation(
			'no-runtime-file',
			file,
			sourceFile,
			'feature runtime modules must be replaced with factories and explicit composition',
		);
	}

	for (const edge of edges) {
		const runtime = isRuntimeSource(edge.source);
		const env = isEnvSource(edge.source);
		const globalPrisma = isGlobalPrismaSource(edge.source);
		const globalResource = isGlobalResourceSource(edge.source);

		if (isControllerFile(file) && runtime) {
			inventory['controller-runtime-imports']++;
			addViolation(
				'no-controller-runtime',
				file,
				edge.node,
				`controllers receive runtime dependencies through ports (${dependencyDescription(edge)})`,
			);
		}
		if (isControllerFile(file) && env) {
			inventory['controller-env-imports']++;
			addViolation(
				'no-controller-env',
				file,
				edge.node,
				`controllers receive validated configuration through their factory (${dependencyDescription(edge)})`,
			);
		}
		if (isControllerFile(file) && globalResource && !runtime) {
			addViolation(
				'no-controller-global-resource',
				file,
				edge.node,
				`controllers cannot own global resource adapters (${dependencyDescription(edge)})`,
			);
		}
		if (isIndexFile(file) && (runtime || env || globalResource)) {
			addViolation(
				'no-index-resource-reexport',
				file,
				edge.node,
				`index barrels cannot hide runtime/env/global resource dependencies (${dependencyDescription(edge)})`,
			);
		}
		if (isRepositoryFile(file) && globalPrisma) {
			inventory['repository-global-prisma-imports']++;
			addViolation(
				'no-repository-global-prisma',
				file,
				edge.node,
				`repository factories must receive Prisma explicitly (${dependencyDescription(edge)})`,
			);
		}
		if (isFeatureFile(file) && runtime) {
			inventory['feature-runtime-imports']++;
			addViolation(
				'no-feature-runtime',
				file,
				edge.node,
				`features connect through ports/composition, never runtime modules (${dependencyDescription(edge)})`,
			);
		}

		if (!isCompositionRoot(file) && isLegacyStatefulSource(edge.source)) {
			const valueNames = edge.names
				.filter((name) => !name.typeOnly)
				.map((name) => name.imported);
				const legacyNames = valueNames.filter((name) => (
					name === '*'
					? true
					: legacyStatefulExports.has(name)
				));
			if (legacyNames.length > 0) {
				inventory['non-composition-stateful-imports']++;
				addViolation(
					'no-noncomposition-stateful-import',
					file,
					edge.node,
					`stateful process exports belong to composition roots (${legacyNames.join(', ')} from ${JSON.stringify(edge.moduleSpecifier)})`,
				);
			}
		}
	}

	for (const statement of sourceFile.statements) {
		if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
			const creation = findImmediateStatefulCreation(statement.expression, bindings);
			if (creation) {
				addViolation(
					'no-stateful-module-singleton',
					file,
					statement,
					`default export immediately creates ${creation.text}; export a factory instead`,
				);
			}
			continue;
		}
		if (!ts.isVariableStatement(statement)) continue;
		const declarationKind = statement.declarationList.flags & ts.NodeFlags.Const ? 'const' : 'mutable';
		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name)) continue;
			const bindingKey = `${file}#${declaration.name.text}`;
			if (declarationKind === 'mutable' && !statefulAppBoundaryAllowlist.has(bindingKey)) {
				addViolation(
					'no-module-mutable-state',
					file,
					declaration,
					`module-level ${declaration.name.text} must move inside an owned factory`,
				);
			}
			if (!declaration.initializer) continue;
			const creation = findImmediateStatefulCreation(declaration.initializer, bindings);
			if (!creation) continue;
			const allowed = statefulAppBoundaryAllowlist.get(bindingKey);
			if (allowed?.creator === creation.creator) continue;
			addViolation(
				'no-stateful-module-singleton',
				file,
				declaration,
				`module-level ${declaration.name.text} immediately creates ${creation.text}; create it inside the composition-owned factory`,
			);
		}
	}

	if (isRepositoryFile(file)) {
		function inspectRepositoryDefaults(node) {
			if (ts.isFunctionLike(node)) {
				for (const parameter of node.parameters) {
					if (!parameter.initializer) continue;
					const creation = findImmediateStatefulCreation(parameter.initializer, bindings);
					if (creation || referencesGlobalPrisma(parameter.initializer, bindings)) {
						addViolation(
							'no-repository-default-resource',
							file,
							parameter,
							'repository resources must be required parameters, never hidden defaults',
						);
					}
				}
			}
			ts.forEachChild(node, inspectRepositoryDefaults);
		}
		inspectRepositoryDefaults(sourceFile);
	}
}

function findNodeAtPosition(sourceFile, position) {
	let result = sourceFile;
	function visit(node) {
		if (position < node.getFullStart() || position > node.getEnd()) return;
		result = node;
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return result;
}

violations.sort((a, b) => (
	a.file.localeCompare(b.file)
	|| a.line - b.line
	|| a.column - b.column
	|| a.rule.localeCompare(b.rule)
));

for (const [name, count] of Object.entries(inventory)) {
	console.log(`[architecture-guard] inventory ${name}=${count}`);
}

for (const violation of violations) {
	console.error(
		`[architecture-guard] ${violation.rule} ${violation.file}:${violation.line}:${violation.column} ${violation.message}`,
	);
}

if (violations.length > 0) {
	console.error(`[architecture-guard] FAIL violations=${violations.length} files=${files.length}`);
	process.exitCode = 1;
} else {
	console.log(
		`[architecture-guard] PASS violations=0 files=${files.length} state-allowlist=${statefulAppBoundaryAllowlist.size}`,
	);
}
