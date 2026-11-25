import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, cp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateExpressions } from './validate.mjs';
import { loadDatabase, renderDatabase, targetText } from './build.mjs';
import { validateCases, renderCases } from '../curated/build.mjs';
import { classifyPaths } from '../../../scripts/classify-ci-changes.mjs';

const db = await loadDatabase();
const cases = JSON.parse(await readFile(new URL('../curated/cases.json', import.meta.url), 'utf8'));
const fixture = () => structuredClone({ ...db, cases });
const entry = (f, id) => f.entries.find(e => e.id === id);
const check = f => validateExpressions(f.entries, f.sources);

test('review ledger, variants and research summaries agree with the checked-in artifacts', async () => {
  const f = fixture();
  const groups = check(f);
  assert.equal(groups.size, f.entries.length);
  assert(f.entries.reduce((n, e) => n + e.variants.length, 0) > groups.size);
  const inputs = validateCases(f.cases, f.sources, f.entries);
  assert(inputs.every(row => Object.keys(row).sort().join(',') === 'id,nickname'));
  assert.equal(inputs.length, f.cases.filter(c => c.evaluation === 'confirmed').length);
  for (const [name, content] of Object.entries(renderDatabase(db)))
    assert.equal(await readFile(new URL(name, import.meta.url), 'utf8'), content);
  for (const [name, content] of Object.entries(renderCases(f.cases, f.sources, f.entries)))
    assert.equal(await readFile(new URL('../curated/' + name, import.meta.url), 'utf8'), content);
});

test('unverified report retains unknown target and no asserted sexual context or origin', () => {
  const e = entry(fixture(), 'ko-lightbulb');
  assert.deepEqual(e.review.decision, 'held');
  assert.equal(e.review.status, 'unverified');
  assert.deepEqual(e.interpretations[0].target, { state: 'unknown', label: null });
  assert.deepEqual(e.riskTypes, ['violence']);
  assert.equal(e.variants[0].provenance, 'user_report');
  assert.equal(e.interpretations[0].confidence, 'hypothesis');
  assert.deepEqual(e.interpretations[0].evidence, []);
  assert(!cases.some(c => c.meaningGroupIds.includes(e.id)));
});

test('held and excluded meanings cannot enter confirmed evaluation', () => {
  for (const group of ['ko-lightbulb', 'ko-pure-blood', 'ko-foreign-1488']) {
    const f = fixture();
    f.cases[0].meaningGroupIds = [group];
    assert.throws(() => validateCases(f.cases, f.sources, f.entries), /Unverified group/);
  }
  const f = fixture();
  f.cases[0].meaningSources.push('daejeon2020');
  assert.throws(() => validateCases(f.cases, f.sources, f.entries), /Candidate-only meaning source/);
  f.cases[0].meaningSources.pop();
  const group = entry(f, 'ko-hyeji');
  group.review = { ...group.review, decision: 'held', status: 'provisional' };
  group.interpretations[0].confidence = 'hypothesis';
  f.cases.filter(c => c.meaningGroupIds.includes(group.id)).forEach(c => { c.evaluation = 'exploratory'; });
  const inputs = validateCases(f.cases, f.sources, f.entries);
  assert(!inputs.some(i => f.cases.find(c => c.id === i.id).meaningGroupIds.includes(group.id)));
});

test('user reports and synthetic sources cannot be promoted to confirmed meanings', () => {
  const f = fixture();
  const e = entry(f, 'ko-lightbulb');
  e.review.decision = 'accepted';
  assert.throws(() => check(f), /Unverified acceptance/);
  e.review.status = 'verified';
  e.interpretations[0].confidence = 'supported';
  e.interpretations[0].evidence = e.variants[0].evidence;
  assert.throws(() => check(f), /Report\/synthesis used as confirmed meaning/);
  const survey = fixture();
  const candidate = entry(survey, 'ko-jabalkkom');
  candidate.review.decision = 'accepted';
  candidate.review.status = 'verified';
  candidate.interpretations[0].confidence = 'supported';
  assert.throws(() => check(survey), /Source supports candidates only/);
});

test('unknown and absent targets both support review without becoming controls', () => {
  const unknown = cases.find(c => c.id === 'curated-stabbing-threat');
  const absent = cases.find(c => c.id === 'curated-blind-money');
  assert.equal(unknown.role, 'probe');
  assert.equal(absent.role, 'probe');
  assert.equal(unknown.target.state, 'unknown');
  assert.equal(absent.target.state, 'none');
  assert.notEqual(targetText(unknown.target), targetText(absent.target));
  const inputs = validateCases([unknown, absent], db.sources, db.entries);
  assert.equal(inputs.length, 2);
  const f = fixture();
  f.cases[0].target = { state: 'identified', label: null };
  assert.throws(() => validateCases(f.cases, f.sources, f.entries), /Target state\/label mismatch/);
});

test('surface evidence cannot claim an original post from a press or survey source', () => {
  for (const group of ['ko-human-housing', 'ko-jabalkkom']) {
    const f = fixture();
    entry(f, group).variants[0].provenance = 'original';
    assert.throws(() => check(f), /Surface provenance exceeds source/);
  }
  const f = fixture();
  entry(f, 'ko-human-housing').variants.push({ ...entry(f, 'ko-human-housing').variants[0], text: 'ㅎㅠㄱㅓ' });
  assert.throws(() => check(f), /Unattested surface/);
});

test('spelling duplicates remain in one group and references fail closed', () => {
  const f = fixture();
  const duplicate = structuredClone(entry(f, 'ko-regional-base'));
  duplicate.id = 'ko-spelling-copy';
  duplicate.expression = '북괴 멀티 전라도';
  duplicate.variants = [{ ...duplicate.variants[0], text: duplicate.expression }];
  f.sources.cyphersRegionalName.surfaceForms.push(duplicate.expression);
  f.entries.push(duplicate);
  assert.throws(() => check(f), /Surface split across meaning groups/);
  const missing = fixture();
  missing.cases[0].meaningGroupIds = ['ko-no-such-group'];
  assert.throws(() => validateCases(missing.cases, missing.sources, missing.entries), /Missing meaning group/);
  delete missing.sources.rohPermutation;
  assert.throws(() => check(missing), /Missing source/);
});

test('synthesis is not laundered into observation; duplicate names and broken anagrams fail', () => {
  const f = fixture();
  const authored = f.cases.find(c => c.origin.kind === 'authored');
  authored.origin.kind = 'observed_nickname';
  authored.origin.source = authored.meaningSources[0];
  assert.throws(() => validateCases(f.cases, f.sources, f.entries), /Unattested nickname/);
  const expression = fixture();
  expression.cases.find(c => c.origin.kind === 'observed_expression').origin.kind = 'observed_nickname';
  assert.throws(() => validateCases(expression.cases, expression.sources, expression.entries), /Expression is not an observed nickname/);
  const duplicate = fixture();
  duplicate.cases.push({ ...duplicate.cases[0], id: 'unique-id' });
  assert.throws(() => validateCases(duplicate.cases, duplicate.sources, duplicate.entries), /Duplicate case/);
  const anagram = fixture();
  anagram.cases[0].anagramOf += '가';
  assert.throws(() => validateCases(anagram.cases, anagram.sources, anagram.entries), /Invalid anagram/);
});

test('critical quotation and ordinary game/food uses stay distinct from direct abuse', () => {
  const e = entry(fixture(), 'ko-hyeji');
  assert(e.contexts.some(c => c.use === 'critical'));
  for (const id of ['seed-game-defense', 'seed-elsa-ice', 'curated-skate-food', 'curated-hyeji-criticism', 'curated-boryu-greeting'])
    assert.equal(cases.find(c => c.id === id).role, 'control');
  for (const name of ['(((국제금융)))', '하얀미래1488', '검은태양기사단', '수학(((1+2)*3)-4)'])
    assert(!cases.some(c => c.nickname === name));
});

test('CI selects contracts for changed data and checks both source-only and linked artifacts', async () => {
  for (const path of ['benchmarks/nickname-evaluation/expressions/entries.json', 'benchmarks/nickname-evaluation/curated/cases.json'])
    assert.equal(classifyPaths([path]).contracts, true);
  const workflow = await readFile(new URL('../../../.github/workflows/pr-checks.yml', import.meta.url), 'utf8');
  assert.match(workflow, /- name: Validate expression DB source data\n        run: node benchmarks\/nickname-evaluation\/expressions\/build.mjs/);
  assert.match(workflow, /- name: Validate expression DB and curated nickname evaluation\n        if: steps.changes.outputs.contracts == 'true'\n        run: node --test benchmarks\/nickname-evaluation\/expressions\/validate.test.mjs/);
});

test('offline CLI detects stale outputs and invalid UTF-8; write mode restores exact artifacts', async () => {
  // Under the repo so Node resolves the same workspace contracts, without changing source files.
  const parent = fileURLToPath(new URL('../', import.meta.url));
  const dir = await mkdtemp(join(parent, '.validation-'));
  try {
    for (const name of ['expressions', 'curated']) await cp(join(parent, name), join(dir, name), { recursive: true });
    const run = (...args) => spawnSync(process.execPath, [join(dir, 'curated/build.mjs'), ...args], { encoding: 'utf8' });
    assert.equal(run().status, 0);
    await writeFile(join(dir, 'curated/cases.md'), '{}\n');
    assert.match(run().stderr, /Stale artifact/);
    assert.equal(run('--write').status, 0);
    assert.equal(run().status, 0);
    await writeFile(join(dir, 'expressions/entries.json'), Buffer.from([0xff]));
    assert.notEqual(run('--write').status, 0);
    assert.notEqual(run('--invalid').status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
