/* @vitest-environment jsdom */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import inventory from '../lib/api/mock/inventory.json';
import { createMockContext, createMockState, MockHttpError, UNHANDLED } from '../lib/api/mock/context';
import { dispatchMockRequest } from '../lib/api/mock/handler';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function pattern(path: string): RegExp {
  return new RegExp(`^${path.split('/').map(segment => segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')}$`);
}
function sample(path: string): string {
  return path.replace(/:([A-Za-z]+)/g, (_, name: string) => name === 'year' ? '2025' : name === 'token' ? 'a'.repeat(64) : name === 'sessionId' || name === 'capability' ? 'missing' : '1');
}
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? entry.name === '__tests__' || entry.name === 'mock' ? [] : files(join(directory, entry.name))
    : /\.tsx?$/.test(entry.name) ? [join(directory, entry.name)] : []);
}
function expressionValues(expression: ts.Expression): string[] {
  const text = expression.getText();
  if (/buildQuery|^query$/.test(text)) return [''];
  if (text === 'year') return ['2025'];
  if (text === 'action') return ['approve', 'reject', 'revoke'];
  if (text === 'kind.toLowerCase()') return ['game', 'webgl', 'video', 'image', 'poster', 'document', 'attachment'];
  if (ts.isConditionalExpression(expression)) return [...expressionValues(expression.whenTrue), ...expressionValues(expression.whenFalse)];
  if (ts.isStringLiteral(expression)) return [expression.text];
  return ['1'];
}
function endpointValues(node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression): string[] {
  if (!ts.isTemplateExpression(node)) return [node.text];
  let candidates = [node.head.text];
  for (const span of node.templateSpans) candidates = candidates.flatMap(prefix => expressionValues(span.expression).map(value => `${prefix}${value}${span.literal.text}`));
  // The actual client rejects every exhibition kind except POSTER before calling the control plane.
  return candidates.filter(value => !/\/exhibitions\/[^/]+\/direct-(?!poster-)/.test(value));
}
function sourceMethod(node: ts.Node): string | undefined {
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (!ts.isCallExpression(parent)) continue;
    if (ts.isPropertyAccessExpression(parent.expression) && parent.expression.expression.getText() === 'api') return parent.expression.name.text.toUpperCase();
    if (parent.expression.getText() === 'uploadFormData') return 'POST';
    if (parent.expression.getText() === 'apiRequest') {
      const init = parent.arguments[1];
      const method = init && ts.isObjectLiteralExpression(init) ? init.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText() === 'method') : undefined;
      return method && ts.isPropertyAssignment(method) && ts.isStringLiteral(method.initializer) ? method.initializer.text : 'GET';
    }
  }
  return undefined;
}

describe('development mock API inventory', () => {
  it('keeps unique reviewable rows linked to existing domains and behavioral tests', () => {
    expect(inventory.routes.length).toBeGreaterThan(70);
    const keys = inventory.routes.map(route => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const route of inventory.routes) {
      expect(['P0', 'P1', 'P2']).toContain(route.priority);
      expect(existsSync(join(sourceRoot, 'lib/api/mock', route.domain)), route.domain).toBe(true);
      expect(route.uiSources.length, `${route.method} ${route.path} UI sources`).toBeGreaterThan(0);
      for (const test of route.testFiles) expect(existsSync(join(sourceRoot, '__tests__', test)), test).toBe(true);
    }
  });
  it.each(inventory.routes)('$method $path reaches a registered domain with the declared method', async route => {
    const state = createMockState(); state.authUser = 'ADMIN';
    const path = sample(route.path);
    let result: unknown;
    try {
      result = await dispatchMockRequest(createMockContext(state), path, route.method, { body: '{}' }, path);
    } catch (error) {
      expect(error, `${route.method} ${path} must fail at a modeled HTTP boundary`).toBeInstanceOf(MockHttpError);
      const modeled = error as MockHttpError;
      expect(modeled.status, `${route.method} ${path} method rejected: ${modeled.message}`).not.toBe(405);
      expect(modeled.message).not.toMatch(/unhandled|unsupported|No mock route/i);
      return;
    }
    expect(result, `${route.method} ${path} is unhandled`).not.toBe(UNHANDLED);
  });
  it('covers every Web UI source API literal and each statically inferred request method', () => {
    const discovered: Array<{ file: string; method?: string; path: string }> = [];
    for (const file of files(sourceRoot)) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node: ts.Node): void => {
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) && (ts.isTemplateExpression(node) ? node.head.text : node.text).startsWith('/api/')) {
          for (const endpoint of endpointValues(node)) discovered.push({ file: file.slice(sourceRoot.length + 1), method: sourceMethod(node), path: endpoint.split('?')[0]! });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(discovered.length).toBeGreaterThan(60);
    const uncovered = discovered.filter(endpoint => !inventory.routes.some(route => (!endpoint.method || route.method === endpoint.method) && pattern(route.path).test(endpoint.path)));
    expect(uncovered).toEqual([]);
  });
});
