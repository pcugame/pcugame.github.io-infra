import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectPagesDeploymentAccess, verifyPagesRepositoryBoundary } from './verify-github-release-boundaries.mjs';

const target = {
 full_name: 'pcugame/pcugame.github.io', default_branch: 'master', archived: false,
 permissions: { push: true, admin: false }, owner: { type: 'User' },
};
function repositoryFetch(body = target, status = 200) {
 return async (url, init) => {
  assert.equal(new URL(url).pathname, '/repos/pcugame/pcugame.github.io');
  assert.equal(init.method ?? 'GET', 'GET');
  return { ok: status === 200, status, json: async () => body };
 };
}
test('personal Pages repositories need write access, not actor or protection queries', async () => {
 const output = [];
 await inspectPagesDeploymentAccess({ token: 'secret-fixture', fetchImpl: repositoryFetch(), output: line => output.push(line) });
 assert.deepEqual(output, ['pages_repository=pcugame/pcugame.github.io', 'pages_repository_push=true', 'pages_inspection=valid']);
 assert.doesNotMatch(output.join('\n'), /secret-fixture/);
});
test('all collaborating writers pass the same release check', async () => {
 for (const login of ['alice', 'bob', 'release-bot']) {
  await verifyPagesRepositoryBoundary({ token: 'fixture', fetchImpl: repositoryFetch({ ...target, owner: { type: 'User', login } }) });
 }
});
test('wrong targets and missing write access still block', async () => {
 for (const body of [{ ...target, permissions: { push: false } }, { ...target, archived: true }, { ...target, full_name: 'other/site' }, { ...target, default_branch: 'other' }]) {
  await assert.rejects(verifyPagesRepositoryBoundary({ token: 'fixture', fetchImpl: repositoryFetch(body) }));
 }
 for (const status of [401, 403, 404]) {
  await assert.rejects(verifyPagesRepositoryBoundary({ token: 'fixture', fetchImpl: repositoryFetch({}, status) }), new RegExp(`HTTP ${status}`));
 }
});
test('missing publication token is rejected before any request', async () => {
 await assert.rejects(verifyPagesRepositoryBoundary({ token: '', fetchImpl: () => assert.fail('unexpected request') }), /PAGES_DEPLOY_TOKEN/);
});
