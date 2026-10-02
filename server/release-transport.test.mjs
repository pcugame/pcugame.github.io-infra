import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/release-api-cutover.yml', import.meta.url), 'utf8');
const steps = workflow.split(/^      - /m).slice(1);

test('every release SSH/SCP action allows bounded connection establishment, including recovery', () => {
  const remote = steps.filter(step => /uses: appleboy\/(?:ssh|scp)-action@/.test(step));
  assert.equal(remote.length, 12);
  for (const step of remote) {
    assert.match(step, /^          timeout: 120s$/m, step.split('\n')[0]);
    assert.doesNotMatch(step, /retry|continue-on-error:/i);
  }
});

test('connection timeout does not replace release command limits or retry stateful stages', () => {
  const find = name => {
    const matches = steps.filter(step => step.startsWith(`name: ${name}\n`));
    assert.equal(matches.length, 1, name);
    return matches[0];
  };
  for (const name of ['Preflight verified release', 'Back up and drain production', 'Apply release migrations',
    'Activate API and workers', 'Verify complete runtime health', 'Run final release smoke and record evidence',
    'Run forward fix']) {
    assert.match(find(name), /^          command_timeout: 60m$/m);
  }
  assert.match(find('Snapshot DB and verify isolated restore'), /^          command_timeout: 20m$/m);
  for (const name of ['Check persisted pre-migration recovery boundary', 'Recover original runtime only before migration attempt']) {
    assert.match(find(name), /^          command_timeout: 10m$/m);
  }
  assert.match(find('Apply release migrations'), /script: bash "\$\{DEPLOY_DIR\}\/release-orchestrate.sh" migrate/);
});
