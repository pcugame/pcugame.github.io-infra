import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('direct deploy guard permits absent or terminal journals but blocks pending and unknown states', () => {
  for (const phase of [null, 'complete', 'aborted', 'candidate', 'aborting', 'switch', 'unknown']) {
    const root = mkdtempSync(join(tmpdir(), 'rolling-fence-'));
    try {
      mkdirSync(join(root, 'deploy')); mkdirSync(join(root, 'cutover-state'));
      copyFileSync(resolve('server/deploy.sh'), join(root, 'deploy.sh'));
      for (const module of ['common', 'lifecycle', 'preflight', 'backup', 'migrate', 'activate', 'smoke']) {
        writeFileSync(join(root, 'deploy', `${module}.sh`), module === 'common'
          ? 'CUTOVER_STATE_DIR="$DEPLOY_DIR/cutover-state"\ndo_inventory_snapshot() { echo entered; }\n' : '');
      }
      if (phase) writeFileSync(join(root, 'cutover-state/rolling-release.json'), JSON.stringify({ phase }));
      const result = spawnSync('bash', [join(root, 'deploy.sh'), 'inventory'], {
        env: { ...process.env, DEPLOY_DIR: root, RELEASE_HOST_LOCK_HELD: 'false', RELEASE_ROLLING_ACTIVE: 'false' }, encoding: 'utf8',
      });
      assert.equal(result.status === 0, [null, 'complete', 'aborted'].includes(phase), result.stderr);
      assert.equal(result.stdout.includes('entered'), [null, 'complete', 'aborted'].includes(phase));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
