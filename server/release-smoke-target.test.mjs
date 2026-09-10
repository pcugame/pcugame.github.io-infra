import assert from 'node:assert/strict';
import test from 'node:test';
import { selectSmokeUrl, validateSmokeUrl, validateStoredTarget } from './release-smoke-target.mjs';
const origin = 'https://assets.example.test';
const url = `${origin}/public/images/a/original.webp`;
const response = (...urls) => ({ origin, years: { ok: true, data: { items: urls.map(url => ({ poster: { original: { url } } })) } } });
test('selects original canonical poster without calling the image API', () => {
  assert.equal(selectSmokeUrl(response('https://api.example.test/api/public/images/old', url)), url);
});
test('explicit public object override works without year posters', () => {
  assert.equal(selectSmokeUrl({ origin }, url), url);
});
test('foreign, signed, credentialed, fragment, root and insecure targets fail closed', () => {
  for (const invalid of ['http://assets.example.test/a', 'https://foreign.test/a', `${origin}/a?signature=x`, `${origin}/a#x`, 'https://user:password@assets.example.test/a', `${origin}/`]) {
    assert.throws(() => validateSmokeUrl(invalid, origin));
    assert.throws(() => selectSmokeUrl({ origin }, invalid));
  }
  assert.throws(() => validateSmokeUrl(url, `${origin}/`));
});
test('missing canonical posters and malformed response stop before maintenance', () => {
  for (const data of [{ origin }, response(), { origin, years: { ok: false } }, response('https://api.example.test/image')]) assert.throws(() => selectSmokeUrl(data));
});
test('stored selection binds exact source and public origin', () => {
  const source = 'a'.repeat(40), record = { source_sha: source, origin, url };
  assert.equal(validateStoredTarget(record, source, origin), url);
  assert.throws(() => validateStoredTarget(record, 'b'.repeat(40), origin));
  assert.throws(() => validateStoredTarget(record, source, 'https://other.example.test'));
});

test('workflow prepares and probes a persisted selection before drain, then reuses it after start', async () => {
  const { readFileSync } = await import('node:fs');
  const workflow = readFileSync(new URL('../.github/workflows/release-api-cutover.yml', import.meta.url), 'utf8');
  const prepare = workflow.slice(workflow.indexOf('      - name: Prepare atomic Phase 2 maintenance window'), workflow.indexOf('      - name: Verify external Pages repository'));
  assert.ok(prepare.indexOf('release-smoke-target.mjs" prepare') < prepare.indexOf('deploy.sh" drain'));
  assert.match(prepare, /SMOKE_PUBLIC_OBJECT_URL: \$\{\{ secrets.SMOKE_PUBLIC_OBJECT_URL \}\}/);
  const apply = workflow.slice(workflow.indexOf('      - name: Apply migrations and start verified release'), workflow.indexOf('      - name: Restore Pages before pre-migration recovery'));
  assert.ok(apply.indexOf('deploy.sh" up') < apply.indexOf('release-smoke-target.mjs" read'));
  assert.doesNotMatch(apply, /SMOKE_PUBLIC_OBJECT_URL is required/);
  assert.match(workflow, /source: .*server\/release-smoke-target.mjs/);
});
