/** Count authored CSS declarations/UTF-8 bytes and JSX style attributes without minification.
 * From the repository root: node apps/web/scripts/measure-styles.mjs [git-ref]
 * Imports and third-party stylesheets are not expanded. Includes guide CSS.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import ts from 'typescript';

const cwd = fileURLToPath(new URL('../../../', import.meta.url));
const ref = process.argv[2];
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const files = ref
  ? git('ls-tree', '-r', '--name-only', ref, '--', 'apps/web/src').trim().split('\n')
  : readdirSync(`${cwd}/apps/web/src`, { recursive: true }).map(path => `apps/web/src/${path}`);
const read = path => ref ? git('show', `${ref}:${path}`) : readFileSync(`${cwd}/${path}`, 'utf8');
const styles = files.filter(path => path.startsWith('apps/web/src/styles/') && path.endsWith('.css')).sort().map(path => {
  const css = read(path);
  let declarations = 0;
  postcss.parse(css, { from: path }).walkDecls(() => declarations++);
  return { path, declarations, bytes: Buffer.byteLength(css) };
});
let inlineStyles = 0;
let inlineObjectProperties = 0;
for (const path of files.filter(path => path.endsWith('.tsx'))) {
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function visit(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === 'style') {
      inlineStyles++;
      function count(child) {
        if (ts.isObjectLiteralExpression(child)) inlineObjectProperties += child.properties.length;
        ts.forEachChild(child, count);
      }
      count(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
console.log(JSON.stringify({
  revision: ref ?? 'working tree',
  files: styles.length,
  declarations: styles.reduce((sum, item) => sum + item.declarations, 0),
  bytes: styles.reduce((sum, item) => sum + item.bytes, 0),
  inlineStyles,
  inlineObjectProperties,
  styles,
}, null, 2));
