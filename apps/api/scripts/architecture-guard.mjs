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

/**
 * P1 debt only. These two services predate the control-plane boundary and still
 * relay public image/WebGL bodies through Fastify. Keeping the allowlist exact
 * makes the debt visible while preventing a second application-level origin
 * from being added. Delete entries as each route becomes an origin redirect.
 */
const legacyClientDeliveryRelayAllowlist = new Set([
	'src/modules/public/image.service.ts',
	'src/modules/public/webgl.service.ts',
]);

/**
 * Internal object reads are application semantics, not client delivery. Keep
 * this list exact (file + enclosing operation) so a neutral filename or a
 * renamed receiver cannot silently create a new application-level asset
 * origin. Entries are intentionally grouped by why bytes/metadata are read:
 * validation/transform, recovery/cleanup, or fenced multipart completion.
 */
const internalObjectReadAllowlist = new Map([
	[
		'src/modules/admin/export/file.adapter.ts',
		new Set(['saveObject']),
	],
	[
		'src/modules/admin/game-upload/complete-session.service.ts',
		new Set(['completeDirectSession', 'completeSession']),
	],
	[
		'src/modules/admin/game-upload/composition.ts',
		new Set(['createGameUploadProductionGraph']),
	],
	[
		'src/modules/admin/game-upload/session-maintenance.service.ts',
		new Set(['sweepStaleCompletingSessions', 'sweepVerifyingSessions']),
	],
	[
		'src/modules/admin/game-upload/source-identity.ts',
		new Set(['validateCompletedSourceIdentity']),
	],
	[
		'src/modules/admin/import-export.composition.ts',
		new Set(['createImportExportProductionGraph']),
	],
	[
		'src/modules/admin/project/project-asset-upload.adapter.ts',
		new Set(['start']),
	],
	[
		'src/modules/admin/project/project-file-validation.ts',
		new Set(['validateProjectUploadFile']),
	],
	[
		'src/modules/assets/image-rendition-backfill.ts',
		new Set(['processItem']),
	],
	[
		'src/modules/assets/upload/video-processing.adapter.ts',
		new Set(['hasFastStart']),
	],
	[
		'src/modules/assets/upload/zip-validation.ts',
		new Set([
			'validateLocalFileHeaders',
			'validateWebglZipArchiveObject',
			'validateZipArchive',
			'validateZipArchiveObject',
		]),
	],
	[
		'src/modules/upload-intent/service.ts',
		new Set(['sweep']),
	],
	[
		'src/modules/upload-intent/temp-scavenger.ts',
		new Set(['createUploadTempFileSystem']),
	],
	[
		'src/modules/webgl/deployment.ts',
		new Set(['deploySource']),
	],
]);

const applicationPipeAllowlist = new Map([
	[
		'src/modules/admin/game-upload/chunk-stream.ts',
		new Set(['createCountedChunkStream']),
	],
]);

const multipartCompleteCallerAllowlist = new Set([
	'src/modules/admin/game-upload/complete-session.service.ts',
	'src/modules/admin/game-upload/composition.ts',
]);

/**
 * P3 debt only. This is the sole application-level UploadPart byte relay kept
 * for already-created API_CHUNK_PROXY sessions. The composition adapter is not
 * a client action and is checked separately as a composition root. Do not add
 * another service/function here; delete this entry with the legacy route.
 */
const legacyUploadPartRelayAllowlist = new Map([
	['src/modules/admin/game-upload/upload-chunk.service.ts', new Set(['uploadChunk'])],
]);

const applicationProxyImports = new Set([
	'http-proxy',
	'http-proxy-middleware',
	'node:http',
	'node:https',
	'undici',
]);

const directUploadFilePattern = /(?:direct[-.]?(?:multipart|upload)|part[-.]?urls?)/i;
const directUploadFunctionPattern = /direct/i;
const clientDeliveryFilePattern = /(?:asset[-.]?origin|client[-.]?delivery|protected[-.]?download|public[-.]?(?:asset|download|metadata)|(?:^|[/.])download[.-])/i;
const objectReadMethodNames = new Set([
	'getObject',
	'head',
	'readObjectRange',
	'readRange',
	'stream',
]);
const signerForbiddenAuthorityNames = new Set([
	'abortMultipart',
	'completeMultipart',
	'delete',
	'deleteObject',
]);

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

function isGuardedFeatureCode(file) {
	return isFeatureFile(file) || file.startsWith('architecture-fixtures/forbidden/');
}

function isDirectUploadFile(file) {
	return directUploadFilePattern.test(file);
}

function functionLikeName(node) {
	if (
		ts.isFunctionDeclaration(node)
		|| ts.isFunctionExpression(node)
		|| ts.isMethodDeclaration(node)
		|| ts.isGetAccessorDeclaration(node)
		|| ts.isSetAccessorDeclaration(node)
	) {
		if (node.name) return propertyNameText(node.name);
	}
	if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
		const parent = node.parent;
		if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
			return parent.name.text;
		}
		if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
			return propertyNameText(parent.name);
		}
	}
	return undefined;
}

/**
 * Direct transport operations do not all live in files named `direct-*`.
 * In particular, the fenced completion service keeps its direct branch in
 * `completeDirectSession`. Inspect the enclosing function as well as the file
 * so renaming or colocating that branch cannot turn it into an UploadPart relay.
 */
function isDirectUploadOperation(node, file) {
	if (isDirectUploadFile(file)) return true;
	let current = node.parent;
	while (current) {
		if (ts.isFunctionLike(current)) {
			const name = functionLikeName(current);
			if (name && directUploadFunctionPattern.test(name)) return true;
		}
		current = current.parent;
	}
	return false;
}

function enclosingFunctionName(node) {
	let current = node.parent;
	while (current) {
		if (ts.isFunctionLike(current)) return functionLikeName(current);
		current = current.parent;
	}
	return undefined;
}

function enclosingFunctionNames(node) {
	const names = [];
	let current = node.parent;
	while (current) {
		if (ts.isFunctionLike(current)) {
			const name = functionLikeName(current);
			if (name) names.push(name);
		}
		current = current.parent;
	}
	return names;
}

function isAllowedInEnclosingOperation(node, file, allowlist) {
	const allowedFunctions = allowlist.get(file);
	if (!allowedFunctions) return false;
	return enclosingFunctionNames(node).some((name) => allowedFunctions.has(name));
}

function isLegacyUploadPartRelay(node, file) {
	const allowedFunctions = legacyUploadPartRelayAllowlist.get(file);
	if (!allowedFunctions) return false;
	const functionName = enclosingFunctionName(node);
	return functionName !== undefined && allowedFunctions.has(functionName);
}

function isGameUploadServiceFile(file) {
	return file.startsWith('src/modules/admin/game-upload/') && !isCompositionRoot(file);
}

function isClientFacingDeliveryFile(file) {
	return (
		/(?:^|\/)src\/modules\/public\/(?:.+\.)?(?:controller|serializer|service)\.(?:[cm]?ts|tsx)$/.test(file)
		|| /(?:^|\/)src\/modules\/assets\/(?:controller|service)\.(?:[cm]?ts|tsx)$/.test(file)
		|| clientDeliveryFilePattern.test(file)
	);
}

function propertyNameText(name) {
	if (!name) return undefined;
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
		return name.text;
	}
	return undefined;
}

function memberName(expression) {
	const current = unwrapExpression(expression);
	if (ts.isPropertyAccessExpression(current)) return current.name.text;
	if (
		ts.isElementAccessExpression(current)
		&& current.argumentExpression
		&& ts.isStringLiteral(current.argumentExpression)
	) {
		return current.argumentExpression.text;
	}
	if (ts.isIdentifier(current)) return current.text;
	return undefined;
}

function literalRoute(call) {
	const first = call.arguments[0];
	return first && ts.isStringLiteralLike(first) ? first.text : undefined;
}

function isRouteRegistration(call) {
	const method = memberName(call.expression);
	return method !== undefined
		&& ['delete', 'get', 'head', 'options', 'patch', 'post', 'put'].includes(method)
		&& literalRoute(call) !== undefined;
}

function containsReadableStreamType(node) {
	let found = false;
	function visit(current) {
		if (found) return;
		if (
			ts.isTypeReferenceNode(current)
			&& /(?:^|\.)Readable(?:Stream)?$/.test(current.typeName.getText())
		) {
			found = true;
			return;
		}
		if (
			ts.isExpressionWithTypeArguments(current)
			&& /(?:^|\.)Readable(?:Stream)?$/.test(current.expression.getText())
		) {
			found = true;
			return;
		}
		if (ts.isTypeQueryNode(current) && /Readable(?:Stream)?/.test(current.exprName.getText())) {
			found = true;
			return;
		}
		ts.forEachChild(current, visit);
	}
	visit(node);
	return found;
}

function containsCallNamed(node, names) {
	let found;
	function visit(current) {
		if (found) return;
		if (ts.isCallExpression(current)) {
			const name = memberName(current.expression);
			if (name && names.has(name)) {
				found = current;
				return;
			}
		}
		ts.forEachChild(current, visit);
	}
	visit(node);
	return found;
}

function isStorageMethodCall(call, methodNames) {
	const name = memberName(call.expression);
	if (!name || !methodNames.has(name)) return false;
	const expression = unwrapExpression(call.expression);
	if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) {
		return false;
	}
	const receiver = expression.expression.getText();
	return /(?:^|\.)(?:inspector|objectStorage|objectStore|storage)$/.test(receiver);
}

function collectObjectReadAliases(sourceFile) {
	const aliases = new Set();
	let changed = true;
	while (changed) {
		changed = false;
		function add(name) {
			if (!name || aliases.has(name)) return;
			aliases.add(name);
			changed = true;
		}
		function initializerIsObjectRead(expression) {
			const current = unwrapExpression(expression);
			if (ts.isIdentifier(current)) return aliases.has(current.text);
			return (
				(ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))
				&& objectReadMethodNames.has(memberName(current) ?? '')
			);
		}
		function visit(node) {
			if (
				ts.isVariableDeclaration(node)
				&& ts.isIdentifier(node.name)
				&& node.initializer
				&& initializerIsObjectRead(node.initializer)
			) {
				add(node.name.text);
			}
			if (
				(ts.isVariableDeclaration(node) || ts.isParameter(node))
				&& ts.isObjectBindingPattern(node.name)
			) {
				for (const element of node.name.elements) {
					const property = propertyNameText(element.propertyName ?? element.name);
					if (
						property
						&& objectReadMethodNames.has(property)
						&& ts.isIdentifier(element.name)
					) {
						add(element.name.text);
					}
				}
			}
			ts.forEachChild(node, visit);
		}
		visit(sourceFile);
	}
	return aliases;
}

function isFeatureLocalS3Source(source) {
	return source === '@aws-sdk/client-s3'
		|| source === '@aws-sdk/s3-request-presigner'
		|| /(?:^|\/)src\/lib\/(?:s3|storage)$/.test(source);
}

function identifierOrPropertyLooksSensitive(node, signedBindings) {
	if (expressionCreatesSignedCapability(node)) return true;
	let found = false;
	function visit(current) {
		if (found) return;
		if (ts.isIdentifier(current) && signedBindings.has(current.text)) {
			found = true;
			return;
		}
		if (ts.isPropertyAssignment(current) || ts.isShorthandPropertyAssignment(current)) {
			const name = propertyNameText(current.name);
			if (name && /(?:accessKey|credential|presigned|signature|signed(?:Url)?)$/i.test(name)) {
				found = true;
				return;
			}
		}
		ts.forEachChild(current, visit);
	}
	visit(node);
	return found;
}

function expressionCreatesSignedCapability(expression) {
	let found = false;
	function visit(current) {
		if (found) return;
		if (ts.isCallExpression(current)) {
			const name = memberName(current.expression);
			if (name && /^(?:getSignedUrl|presign|presignUploadPart|signUploadPart)$/i.test(name)) {
				found = true;
				return;
			}
		}
		ts.forEachChild(current, visit);
	}
	visit(expression);
	return found;
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
	'legacy-client-delivery-relays': 0,
	'client-delivery-object-reads': 0,
	'feature-local-s3-imports': 0,
	'direct-upload-byte-relays': 0,
	'multipart-complete-callers': 0,
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
		if (isFeatureFile(file) && isFeatureLocalS3Source(edge.source)) {
			inventory['feature-local-s3-imports']++;
			addViolation(
				'no-feature-local-s3-data-plane',
				file,
				edge.node,
				`feature code must use a least-authority port, never an SDK/client storage adapter (${dependencyDescription(edge)})`,
			);
		}
		if (isGuardedFeatureCode(file) && applicationProxyImports.has(edge.source)) {
			addViolation(
				'no-application-asset-proxy',
				file,
				edge.node,
				`feature code cannot implement an object transport proxy; use Garage/public origin or an external reverse proxy (${dependencyDescription(edge)})`,
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

	const signedCapabilityBindings = new Set();
	const objectReadAliases = collectObjectReadAliases(sourceFile);
	function collectSignedCapabilityBindings(node) {
		if (
			ts.isVariableDeclaration(node)
			&& ts.isIdentifier(node.name)
			&& node.initializer
			&& expressionCreatesSignedCapability(node.initializer)
		) {
			signedCapabilityBindings.add(node.name.text);
		}
		ts.forEachChild(node, collectSignedCapabilityBindings);
	}
	collectSignedCapabilityBindings(sourceFile);

	function inspectControlPlaneBoundary(node) {
		if (
			(ts.isPropertySignature(node) || ts.isPropertyDeclaration(node))
			&& propertyNameText(node.name) === 'storage'
			&& node.type
			&& isClientFacingDeliveryFile(file)
			&& !legacyClientDeliveryRelayAllowlist.has(file)
			&& /(?:getObject|head|readObjectRange|readRange|stream)/.test(node.type.getText())
		) {
			addViolation(
				'no-client-delivery-object-read',
				file,
				node,
				'client-facing delivery dependencies cannot expose object read/HEAD/Range authority',
			);
		}

		if (
			ts.isInterfaceDeclaration(node)
			&& /(?:Signer$|Capability|PartUrls?|UploadPart)/.test(node.name.text)
		) {
			for (const member of node.members) {
				const name = propertyNameText(member.name);
				if (name && signerForbiddenAuthorityNames.has(name)) {
					addViolation(
						'no-signer-admin-authority',
						file,
						member,
						`signer port ${node.name.text} must not expose ${name}`,
					);
				}
			}
		}

		if (ts.isCallExpression(node)) {
			const callName = memberName(node.expression);
			const objectReadCall = (
				(callName !== undefined && objectReadMethodNames.has(callName))
				|| (
					ts.isIdentifier(unwrapExpression(node.expression))
					&& objectReadAliases.has(unwrapExpression(node.expression).text)
				)
			);
			if (
				isGuardedFeatureCode(file)
				&& objectReadCall
				&& !isRouteRegistration(node)
				&& !legacyClientDeliveryRelayAllowlist.has(file)
				&& !isAllowedInEnclosingOperation(node, file, internalObjectReadAllowlist)
			) {
				inventory['client-delivery-object-reads']++;
				addViolation(
					'no-client-delivery-object-read',
					file,
					node,
					`object read/HEAD/Range through ${callName ?? 'an aliased reader'} is not an exact validation, transform, recovery, or completion operation`,
				);
			}
			if (callName === 'completeMultipart') {
				inventory['multipart-complete-callers']++;
				if (!multipartCompleteCallerAllowlist.has(file)) {
					addViolation(
						'no-unowned-multipart-complete',
						file,
						node,
						'CompleteMultipartUpload authority belongs only to the fenced completion service and its composition adapter',
					);
				}
			}
			if (
				callName === 'uploadPart'
				&& (
					isDirectUploadOperation(node, file)
					|| (isGameUploadServiceFile(file) && !isLegacyUploadPartRelay(node, file))
				)
			) {
				inventory['direct-upload-byte-relays']++;
				addViolation(
					'no-direct-upload-byte-relay',
					file,
					node,
					'direct upload services issue capabilities; they never accept or forward part bodies',
				);
			}
			if (
				isDirectUploadFile(file)
				&& signerForbiddenAuthorityNames.has(callName ?? '')
			) {
				addViolation(
					'no-signer-admin-authority',
					file,
					node,
					`part-signing code must not invoke ${callName}`,
				);
			}
			if (
				isClientFacingDeliveryFile(file)
				&& !legacyClientDeliveryRelayAllowlist.has(file)
				&& isStorageMethodCall(node, objectReadMethodNames)
			) {
				inventory['client-delivery-object-reads']++;
				addViolation(
					'no-client-delivery-object-read',
					file,
					node,
					`client-facing delivery cannot implement object GET/HEAD/Range through ${callName}; issue a capability or public-origin URL`,
				);
			}
			if (
				isGuardedFeatureCode(file)
				&& (callName === 'fetch' || callName === 'pipe')
				&& !(
					callName === 'pipe'
					&& isAllowedInEnclosingOperation(node, file, applicationPipeAllowlist)
				)
			) {
				addViolation(
					'no-application-asset-proxy',
					file,
					node,
					`${callName} is not permitted as an object transport boundary in feature code; use Garage/public origin or an external reverse proxy`,
				);
			}
			if (
				isClientFacingDeliveryFile(file)
				&& !legacyClientDeliveryRelayAllowlist.has(file)
				&& callName === 'send'
				&& node.arguments.some((argument) => /(?:^|\.)(?:body|object|payload|stream)$/.test(argument.getText()))
			) {
				addViolation(
					'no-protected-download-body',
					file,
					node,
					'client-facing asset routes cannot send an object body/stream through Fastify',
				);
			}
			if (
				isClientFacingDeliveryFile(file)
				&& /public/.test(file)
				&& /^(?:presign|getSignedUrl)$/.test(callName ?? '')
			) {
				addViolation(
					'no-public-metadata-presign-authority',
					file,
					node,
					'public metadata/delivery services return immutable public-origin URLs and must not mint protected capabilities',
				);
			}

			if (callName && ['debug', 'error', 'fatal', 'info', 'trace', 'warn'].includes(callName)) {
				const context = node.arguments[0];
				if (context && identifierOrPropertyLooksSensitive(context, signedCapabilityBindings)) {
					addViolation(
						'no-presigned-url-logging',
						file,
						node,
						'logger context must contain stable IDs/action/result only, never a signed URL, signature, access key, or credential',
					);
				}
			}

			if (isRouteRegistration(node)) {
				const route = literalRoute(node);
				if (
					route?.includes(':storageKey')
					&& (route.includes('/assets') || route.includes('protected'))
				) {
					const allowedLegacyRoute = file === 'src/modules/assets/controller.ts'
						&& route === '/assets/protected/:storageKey';
					if (!allowedLegacyRoute) {
						addViolation(
							'no-canonical-storage-key-route',
							file,
							node,
							'new external asset routes use assetId; raw storageKey routes are compatibility-only',
						);
					}
				}
				if (route && /(?:direct|part-urls)/.test(route)) {
					for (const argument of node.arguments.slice(1)) {
						if (containsReadableStreamType(argument)) {
							addViolation(
								'no-direct-controller-body-stream',
								file,
								argument,
								'direct UploadPart routes accept JSON control messages, never a readable request body stream',
							);
						}
						const uploadPartCall = containsCallNamed(argument, new Set(['uploadPart']));
						if (uploadPartCall) {
							addViolation(
								'no-direct-controller-body-stream',
								file,
								uploadPartCall,
								'direct routes may issue UploadPart URLs but cannot call UploadPart with client bytes',
							);
						}
					}
				}
			}
		}

		if (isControllerFile(file) && ts.isPropertyAccessExpression(node)) {
			if (
				node.name.text === 'env'
				&& (
					(ts.isIdentifier(node.expression) && node.expression.text === 'process')
					|| node.expression.getText() === 'globalThis.process'
				)
			) {
				addViolation(
					'no-controller-process-env',
					file,
					node,
					'controllers receive validated configuration through their factory; they cannot read process.env',
				);
			}
		}

		if (
			(ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node))
			&& propertyNameText(node.name) === 'body'
			&& isClientFacingDeliveryFile(file)
			&& !legacyClientDeliveryRelayAllowlist.has(file)
		) {
			let current = node.parent;
			let deliveryFunction = false;
			while (current) {
				if (
					(ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current))
					&& current.name
					&& /(?:download|grantProtected)/i.test(current.name.getText())
				) {
					deliveryFunction = true;
					break;
				}
				current = current.parent;
			}
			if (deliveryFunction) {
				addViolation(
					'no-protected-download-body',
					file,
					node,
					'protected canonical download returns a presigned redirect descriptor, never an object body',
				);
			}
		}

		ts.forEachChild(node, inspectControlPlaneBoundary);
	}
	inspectControlPlaneBoundary(sourceFile);

	if (legacyClientDeliveryRelayAllowlist.has(file)) {
		inventory['legacy-client-delivery-relays']++;
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
