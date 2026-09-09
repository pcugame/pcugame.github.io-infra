import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

for (const failApply of [false, true]) {
  test(`materials additive update ${failApply ? 'stays drained after migration failure' : 'preserves assets before starting runtime'}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'pcu-material-update-'));
    try {
      writeFileSync(join(directory, '.env'), '');
      writeFileSync(join(directory, 'deploy.sh'), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$DEPLOY_DIR/actions"
if [[ "\${FAIL_APPLY:-}" == 1 && "$*" == 'release-migrate apply-expand' ]]; then exit 17; fi
`, { mode: 0o755 });
      writeFileSync(join(directory, 'podman'), `#!/usr/bin/env bash
set -eu
if [[ "$*" == *'exec -i gp-postgres'* ]]; then
  sql=$(cat)
  if [[ "$sql" == *'_prisma_migrations'* ]]; then echo '1|0|0'; else echo '{"id":1,"kind":"IMAGE"}'; fi
fi
`, { mode: 0o755 });
      const result = spawnSync('bash', [new URL('./release-phase1-materials-update.sh', import.meta.url).pathname,
        `ghcr.io/pcugame/pcu-graduationproject-v2-api@sha256:${'a'.repeat(64)}`, 'b'.repeat(40)], {
        encoding: 'utf8', env: { ...process.env, DEPLOY_DIR: directory, CUTOVER_STATE_DIR: directory,
          PATH: `${directory}:${process.env.PATH}`, FAIL_APPLY: failApply ? '1' : '0' },
      });
      assert.equal(result.status, failApply ? 17 : 0, result.stderr);
      const actions = readFileSync(join(directory, 'actions'), 'utf8').trim().split('\n');
      assert.ok(actions.indexOf('drain') < actions.findIndex(x => x.startsWith('backup ')));
      assert.ok(actions.findIndex(x => x.startsWith('inventory ')) < actions.indexOf('release-migrate apply-expand'));
      assert.ok(!actions.some(x => x.includes('apply-contract') || x.startsWith('correction apply')));
      if (failApply) {
        assert.equal(actions.at(-1), 'drain');
        assert.ok(!actions.includes('up'));
      } else assert.ok(actions.indexOf('release-assert phase1') < actions.indexOf('up'));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
