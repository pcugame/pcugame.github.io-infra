import ts from 'typescript';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Reused from PR #113 (c95de4be). This branch has not integrated its business
// module normalization. Enforce strict layering only on these existing roots;
// explicit CLI targets use exactly the same rules, including fixture roots.
const strictRoots = [
 'src/modules/assets/delivery-policy.ts',
 'src/modules/admin/project/project-status.service.ts',
 'src/modules/admin/project/update.controller.ts',
 'src/modules/admin/project/update.service.ts',
 'src/modules/admin/project/update.policy.ts',
 'src/modules/admin/project/update.repository.ts',
 'src/modules/admin/project-access.policy.ts',
];
const controller = /(?:^|\/|[.\-])controller\.[cm]?ts$/;
const repository = /(?:^|\/|[.\-])repository\.[cm]?ts$/;
const service = /(?:^|\/|[.\-])service\.[cm]?ts$/;
const policy = /(?:(?:^|[/.\-])policy|download-resolver)\.[cm]?ts$/;
const db = /(?:generated\/prisma|@prisma\/|(?:^|\/)lib\/prisma)/;
const http = /(?:^fastify$|@fastify\/|(?:^|\/)plugins\/|response-descriptor)/;
const cache = new Map();
const failures = new Set();
const normalize = value => value.split(path.sep).join('/');
function collect(dir) {
 return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  if (['generated', '__tests__', 'node_modules'].includes(entry.name)) return [];
  const file = path.join(dir, entry.name);
  return entry.isDirectory() ? collect(file) : /\.ts$/.test(file) && !/\.test\.ts$/.test(file) ? [file] : [];
 });
}
function edges(file) {
 if (cache.has(file)) return cache.get(file);
 const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
 for (const diagnostic of source.parseDiagnostics) failures.add(`parse-error ${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
 const result = [];
 const add = spec => {
  if (!spec.startsWith('.')) {
   if (!spec.startsWith('node:') && !ts.resolveModuleName(spec, file, { moduleResolution: ts.ModuleResolutionKind.NodeNext }, ts.sys).resolvedModule) failures.add(`unresolved-import ${file}: ${spec}`);
   result.push(spec); return;
  }
  const base = path.resolve(path.dirname(file), spec).replace(/\.js$/, '');
  const resolved = [base + '.ts', base + '/index.ts', base].find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  if (!resolved) { failures.add(`unresolved-import ${file}: ${spec}`); return; }
  result.push(normalize(resolved));
 };
 function visit(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text);
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) add(node.arguments[0].text);
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) add(node.argument.literal.text);
  ts.forEachChild(node, visit);
 }
 visit(source); cache.set(file, result); return result;
}
const targets = process.argv.slice(2);
const roots = (targets.length ? targets : strictRoots).flatMap(p => {
 const file = path.resolve(root, p);
 return existsSync(file) && statSync(file).isDirectory() ? collect(file) : [file];
});
if (!roots.length) failures.add('empty-scope no TypeScript roots selected');
for (const file of roots) {
 if (!existsSync(file)) { failures.add(`unresolved-root ${file}`); continue; }
 const isController = controller.test(file), isRepository = repository.test(file), isService = service.test(file), isPolicy = policy.test(file);
 const pending = [file], seen = new Set();
 while (pending.length) {
  const current = pending.pop();
  if (seen.has(current)) continue;
  seen.add(current);
  for (const target of edges(current)) {
   let rule;
   if (isController && repository.test(target)) rule = 'controller-repository';
   if (isService && (db.test(target) || repository.test(target) || http.test(target))) rule = 'service-adapter';
   if (isRepository && (service.test(target) || controller.test(target))) rule = 'repository-application';
   if (isPolicy && (db.test(target) || http.test(target) || repository.test(target) || service.test(target) || controller.test(target))) rule = 'policy-adapter';
   if (rule) failures.add(`${rule} ${file} -> ${target}`);
   // Follow local dependencies including barrels and type-only imports. Generated code
   // and dependencies are terminal authorities; never crawl their implementation.
   if (target.startsWith(root + '/') && !target.includes('/generated/')) pending.push(target);
  }
 }
}
for (const message of failures) console.error(`[assets-boundary] ${message}`);
console.log(`[assets-boundary] ${failures.size ? 'FAIL' : 'PASS'} roots=${roots.length} violations=${failures.size}`);
if (failures.size) process.exitCode = 1;
