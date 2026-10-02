import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(new URL('../.github/workflows/pr-checks.yml', import.meta.url), 'utf8');
// A bounded reader for this workflow's top-level jobs and step blocks. It does
// not attempt to implement YAML. actionlint separately validates YAML/actions.
const jobs = [...workflow.slice(workflow.indexOf('jobs:\n')).matchAll(/^  ([a-z][\w-]*):\n([\s\S]*?)(?=^  [a-z][\w-]*:|$(?![\s\S]))/gm)]
  .map(match => ({ id: match[1], body: match[2] }));
const job = id => { const found = jobs.find(item => item.id === id); assert.ok(found, id); return found.body; };
const steps = body => [...body.matchAll(/^      - (?:name:|uses:)[\s\S]*?(?=^      - |$(?![\s\S]))/gm)].map(match => match[0]);
const stepWith = (body, text) => {
  const found = steps(body).filter(step => step.includes(text));
  assert.equal(found.length, 1, `unique step containing ${text}`);
  return found[0];
};
const conditional = (step, expression) => assert.ok(step.includes(`        if: ${expression}\n`), expression);

test('required contexts remain unconditional at trigger and verify boundaries', () => {
  assert.deepEqual(jobs.map(item => item.id), ['verify', 'integration']);
  assert.match(workflow, /^  pull_request:\n    branches: \[master\]\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s+paths(?:-ignore)?:/m);
  assert.doesNotMatch(job('verify').split('    steps:')[0], /^    if:/m);
  assert.doesNotMatch(workflow, /continue-on-error:|\|\| true/);
  assert.match(stepWith(job('verify'), 'actions/checkout'), /fetch-depth: 0/);
  assert.match(job('verify'), /integration: \$\{\{ steps\.changes\.outputs\.integration \}\}/);
  for (const text of ['Test CI classification', 'Select verification', 'Test integration runner', 'Check migration history']) {
    assert.doesNotMatch(stepWith(job('verify'), text), /^        if:/m);
  }
  assert.match(stepWith(job('verify'), 'Select verification'), /id: changes/);
  const verify = job('verify');
  assert.ok(verify.indexOf('Test CI classification') < verify.indexOf('Select verification'));
  assert.ok(verify.indexOf('Select verification') < verify.indexOf('actions/setup-go'));
});

test('selected verify steps cover every original workspace and control command', () => {
  const verify = job('verify');
  const commands = {
    release: ['actions/setup-go@v5', 'bash server/quadlet/build-compat-generator.sh', 'npm run test:release-controls'],
    install: ['npm ci --include-workspace-root', 'npm audit --audit-level=high'],
    contracts: ['npm run build --workspace=@pcu/contracts', 'npm test --workspace=@pcu/contracts'],
    api: ['npm run db:generate --workspace=apps/api', 'npm test --workspace=apps/api',
      'npm run lint --workspace=apps/api', 'npm run architecture', 'npm run build --workspace=apps/api'],
    web: ['npm test --workspace=apps/web', 'npm run lint --workspace=apps/web', 'npm run build --workspace=apps/web'],
  };
  for (const [flag, values] of Object.entries(commands)) {
    for (const value of values) {
      const selective = value.startsWith('npm test --workspace=') || value.startsWith('npm run lint --workspace=')
        || (value.startsWith('npm run build --workspace=') && flag !== 'contracts');
      conditional(stepWith(verify, value), `steps.changes.outputs.${flag} == 'true'${selective ? " && steps.changes.outputs.full != 'true'" : ''}`);
    }
  }
  for (const name of ['Test all workspaces', 'Lint all workspaces', 'Build all workspaces']) {
    conditional(stepWith(verify, name), "steps.changes.outputs.full == 'true'");
  }
  assert.match(stepWith(verify, 'Test all workspaces'), /run: npm test\n/);
  assert.match(stepWith(verify, 'Lint all workspaces'), /run: npm run lint\n/);
  assert.match(stepWith(verify, 'Build all workspaces'), /run: npm run build\n/);
  const setup = steps(verify).filter(step => step.includes('actions/setup-node@v4'));
  assert.equal(setup.length, 2);
  assert.doesNotMatch(setup[0], /^        if:/m);
  conditional(setup[1], "steps.changes.outputs.install == 'true'");
  assert.match(setup[1], /cache-dependency-path: package-lock.json/);
  assert.ok(verify.indexOf('Build shared contracts prerequisite') < verify.indexOf('Test API'));
  assert.ok(verify.indexOf('Generate Prisma client') < verify.indexOf('Test API'));
});

const integration = job('integration');
const gateStep = steps(integration)[0];
const gate = gateStep.match(/        run: \|\n([\s\S]*)/)?.[1].replace(/^          /gm, '');

test('integration runs its gate even when verify fails; all expensive steps remain conditional', () => {
  assert.match(integration, /^    needs: verify\n    if: always\(\)\n/m);
  assert.match(integration, /timeout-minutes: 25/);
  assert.match(gateStep, /VERIFY_RESULT: \$\{\{ needs\.verify\.result \}\}/);
  assert.match(gateStep, /INTEGRATION_REQUIRED: \$\{\{ needs\.verify\.outputs\.integration \}\}/);
  assert.ok(gate);
  assert.doesNotMatch(gateStep, /^        if:/m);
  const rest = steps(integration).slice(1);
  assert.equal(rest.length, 7);
  for (const step of rest.slice(0, -1)) conditional(step, "needs.verify.outputs.integration == 'true'");
  conditional(rest.at(-1), "always() && needs.verify.result == 'success' && needs.verify.outputs.integration == 'true'");
  for (const command of ['npm ci --include-workspace-root', 'npm run db:generate --workspace=apps/api',
    'npm run test:integration', 'npm run test:file-gateway',
    'docker compose -f docker-compose.integration.yml down -v --remove-orphans']) {
    stepWith(integration, command);
  }
});

test('actual integration gate accepts intentional skip and rejects upstream failure or ambiguous outputs', () => {
  for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
    for (const selection of ['true', 'false', '', 'TRUE', 'null', ' true', 'false\ntrue']) {
      const execution = spawnSync('bash', ['-c', gate], { encoding: 'utf8', env: {
        ...process.env, VERIFY_RESULT: result, INTEGRATION_REQUIRED: selection,
      } });
      const expected = result === 'success' && ['true', 'false'].includes(selection);
      assert.equal(execution.status === 0, expected, `${JSON.stringify({ result, selection })}: ${execution.stderr}`);
      if (expected && selection === 'false') assert.match(execution.stdout, /intentionally skipped/);
    }
  }
  const missing = spawnSync('bash', ['-c', gate], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.notEqual(missing.status, 0);
});
