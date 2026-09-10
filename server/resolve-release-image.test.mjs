import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveReleaseImage, validateManifest } from './resolve-release-image.mjs';
const source = 'a'.repeat(40);
const image = `ghcr.io/pcugame/pcu-graduationproject-v2-api@sha256:${'b'.repeat(64)}`;
const run = { id: 1, head_sha: source, head_branch: 'master', conclusion: 'success', event: 'push' };
const artifact = { id: 2, name: `verified-api-release-${source}`, expired: false };
function api(runs = [run], artifacts = [artifact]) {
  return async url => url.includes('/zip') ? 'zip' : url.includes('/artifacts') ? { artifacts } : { workflow_runs: runs };
}
test('resolves only exact source immutable manifests from successful master build', async () => {
  assert.equal(await resolveReleaseImage(source, api(), async () => JSON.stringify({ source_sha: source, image })), image);
});
test('absence, expired artifact and wrong run source/event/branch require rebuild', async () => {
  for (const invalid of [{ head_sha: 'c'.repeat(40) }, { head_branch: 'task' }, { conclusion: 'failure' }, { event: 'pull_request' }]) {
    assert.equal(await resolveReleaseImage(source, api([{ ...run, ...invalid }]), () => assert.fail()), '');
  }
  assert.equal(await resolveReleaseImage(source, api([], []), () => assert.fail()), '');
  assert.equal(await resolveReleaseImage(source, api([run], [{ ...artifact, expired: true }]), () => assert.fail()), '');
});
test('malformed, foreign or mismatched manifests fail closed', () => {
  for (const invalid of [{ source_sha: 'c'.repeat(40), image }, { source_sha: source, image: 'latest' }, { source_sha: source, image: image.replace('pcugame/', 'attacker/') }]) assert.throws(() => validateManifest(invalid, source));
});
