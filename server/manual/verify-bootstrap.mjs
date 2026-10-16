// Isolated Docker acceptance fixture, never an installer. Requires a built API
// image; creates only uniquely named temporary containers, network and volume.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const name = `pcu-manual-${process.pid}`;
const work = mkdtempSync(join(tmpdir(), name));
const apiImage = process.env.MANUAL_API_IMAGE || 'pcu-manual-api:verify';
const pgImage = readFileSync(new URL('./rootless/gp-postgres.container', import.meta.url), 'utf8').match(/^Image=(.+)$/m)[1];
const password = randomBytes(24).toString('hex');
function run(args, input, success = true) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 120_000 });
  if (success) assert.equal(result.status, 0, result.stderr || result.stdout);
  else assert.notEqual(result.status, 0, 'operation must fail closed');
  return result.stdout.trim();
}
const psql = (sql, success = true, ...vars) => run(['exec', '-i', `${name}-db`, 'psql', '-U', 'pcu', '-d', 'pcu', '-v', 'ON_ERROR_STOP=1', '-At', ...vars], sql, success);
const sqlFile = file => readFileSync(new URL(`./sql/${file}.sql`, import.meta.url), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  run(['network', 'create', name]);
  run(['volume', 'create', name]);
  writeFileSync(join(work, 'db.env'), `POSTGRES_USER=pcu\nPOSTGRES_DB=pcu\nPOSTGRES_PASSWORD=${password}\n`, { mode: 0o600 });
  run(['run', '-d', '--name', `${name}-db`, '--network', name, '--network-alias', 'postgres', '--env-file', join(work, 'db.env'), '-v', `${name}:/var/lib/postgresql/data`, pgImage]);
  for (let i = 0; i < 40; i++) {
    const result = spawnSync('docker', ['exec', `${name}-db`, 'pg_isready', '-U', 'pcu'], { encoding: 'utf8' });
    if (result.status === 0) break;
    await sleep(250);
  }
  psql(sqlFile('empty-database'));
  let env = readFileSync(new URL('./config/app.env.example', import.meta.url), 'utf8')
    .replace('REPLACE_WITH_DATABASE_PASSWORD', password).replace(/^NODE_EXTRA_CA_CERTS=.*\n/m, '');
  writeFileSync(join(work, 'app.env'), env, { mode: 0o600 });
  const oneOff = ['run', '--rm', '--network', name, '--env-file', join(work, 'app.env'), '--entrypoint', 'npm', apiImage];
  run([...oneOff, 'run', 'db:migrate:deploy']);
  const migrations = psql('SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;');
  assert.ok(Number(migrations) > 0);
  psql(sqlFile('empty-database'), false);
  psql(sqlFile('buckets'));
  psql(sqlFile('buckets')); // exact desired registry is idempotent
  assert.equal(psql('SELECT count(*) FROM storage_buckets;'), '2');
  psql(sqlFile('buckets').replaceAll('pcu-public', 'wrong-public'), false);
  assert.equal(psql('SELECT bucket FROM storage_buckets WHERE visibility=\'PUBLIC\';'), 'pcu-public');
  const apiArgs = ['run', '-d', '--name', `${name}-api`, '--network', name, '--env-file', join(work, 'app.env'), '-p', '127.0.0.1::4000', apiImage];
  for (let generation = 0; generation < 2; generation++) {
    run(apiArgs);
    const origin = `http://${run(['port', `${name}-api`, '4000/tcp'])}`;
    let healthy = false;
    for (let i = 0; i < 60; i++) {
      try {
        const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { healthy = true; break; }
      } catch { /* wait for the real server startup */ }
      await sleep(250);
    }
    assert.ok(healthy, 'image must serve health after explicit migration');
    const me = await fetch(`${origin}/api/me`);
    assert.equal(me.status, 200);
    assert.equal((await me.json()).data.authenticated, false);
    assert.equal(psql('SELECT count(*) FROM users;'), '0', 'startup must not seed users');
    assert.equal(psql('SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;'), migrations);
    run(['stop', '-t', '65', `${name}-api`]);
    run(['rm', `${name}-api`]);
  }
  const id = psql("INSERT INTO users (google_sub,email,name,updated_at) VALUES ('manual-test-sub','manual@pcu.test','Manual fixture',now()) RETURNING id;").split('\n')[0];
  psql(sqlFile('first-admin'), false, '-v', `user_id=${id}`, '-v', 'google_subject=wrong');
  assert.equal(psql('SELECT role FROM users;'), 'USER');
  psql(sqlFile('first-admin'), true, '-v', `user_id=${id}`, '-v', 'google_subject=manual-test-sub');
  assert.equal(psql('SELECT role FROM users;'), 'ADMIN');
  psql(sqlFile('first-admin'), false, '-v', `user_id=${id}`, '-v', 'google_subject=manual-test-sub');
  run(['restart', `${name}-db`]);
  for (let i = 0; i < 40; i++) {
    if (spawnSync('docker', ['exec', `${name}-db`, 'pg_isready', '-U', 'pcu']).status === 0) break;
    await sleep(250);
  }
  assert.equal(psql('SELECT role FROM users;'), 'ADMIN');
  assert.equal(psql('SELECT count(*) FROM storage_buckets;'), '2');
  console.log(`PASS: ${migrations} Prisma migrations on an empty DB; nonempty refusal; registry conflict rollback; exact first-admin transaction; API recreation without seed/migration; DB restart persistence.`);
} finally {
  for (const suffix of ['api', 'db']) spawnSync('docker', ['rm', '-f', `${name}-${suffix}`]);
  spawnSync('docker', ['volume', 'rm', name]);
  spawnSync('docker', ['network', 'rm', name]);
  rmSync(work, { recursive: true, force: true });
}
