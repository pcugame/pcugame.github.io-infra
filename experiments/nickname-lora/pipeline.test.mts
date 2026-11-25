import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { LabCurationPolicySchema, LabResultSchema, labBuildPreference, labTrainingLine, labReviewResult, labDefaultReview } from '@pcu/contracts';
import { prepare, smokeData, json, lines, validateMessages, sha, save, protocol } from './data.mts';
import { freeze, replayProvider, queryKey, evaluate } from './evaluation.mts';
import { metrics, gate, reviewTemplate, select } from './gate.mts';

async function fixtureExport(directory: string) {
  await smokeData(join(directory, 'smoke'));
  const examples = lines(await readFile(join(directory, 'smoke/train.jsonl'), 'utf8'));
  const records = [];
  for (let i = 0; i < 3; i++) {
    const example = structuredClone(examples[i === 0 ? 1 : i]);
    const nickname = `달빛산책연습${i}`;
    for (const m of example.messages) m.content = m.content.replaceAll('달빛산책연습', nickname);
    const { input, value, action } = validateMessages(example.messages);
    const { evidenceChecks, interpretationStatus, ...answer } = value;
    const step = { kind: action ? 'action' : 'answer', prompt: example.messages[1].content,
      systemPrompt: example.messages[0].content, suppliedSources: input.sources, rawResponse: JSON.stringify(example.messages[2].content), finishReason: 'stop',
      ...(action ? { action: value } : { answer, evidenceChecks, interpretationStatus }) };
    const result = LabResultSchema.parse({ bertScore: null, caseId: `case-${i}`, testCase: { id: `case-${i}`, nickname, familyId: `family-${i}`,
      split: 'train', tags: ['obfuscation:none'], reference: { expectedReason: 'fixture', expectedScore: 5, sources: [] } },
      status: 'SUCCEEDED', output: action ? null : answer, sources: [], durationMs: 1, searchCount: 0,
      jsonValid: true, error: null, attempts: 1, toolSucceeded: false, toolSupport: 'unsupported',
      history: [{ event: 'finished', research: { steps: [step] } }] });
    const review = { id: randomUUID(), runId: randomUUID(), caseId: result.caseId, revision: 1, actorId: 1,
      createdAt: new Date().toISOString(), resultHash: sha(JSON.stringify(labReviewResult(result))), body: { ...labDefaultReview(result),
        behavior: i === 1 ? 'negative' as const : 'positive' as const, behaviorReasons: i === 1 ? ['excessive_risk' as const] : [],
        verdict: 'correct' as const, cause: 'none' as const, cohort: i === 2 ? 'ambiguous' as const : 'normal' as const } };
    const body = labBuildPreference(result, review.body, 'train', { feedbackPolicy: 'fixture-policy', promptHash: 'a'.repeat(64) });
    const candidate = { id: randomUUID(), reviewId: review.id, runId: review.runId, caseId: result.caseId, actorId: 1,
      createdAt: review.createdAt, contentHash: sha(JSON.stringify(body)), status: 'approved', body,
      decisions: [{ actorId: 1, at: review.createdAt, decision: 'approved', grounded: true, familyVerified: true }], stale: false };
    records.push({ candidate, review, originalResult: result });
  }
  const text = records.map(r => JSON.stringify(labTrainingLine(r.candidate as any))).join('\n') + '\n';
  const path = join(directory, 'train.jsonl'); await writeFile(path, text);
  const provenance = { version: 'preference-v1', scope: { feedbackPolicy: 'fixture-policy', promptHash: 'a'.repeat(64) }, kind: 'train', id: 'fixture-export', datasetHash: 'fixture-data',
    files: [{ filename: 'train.jsonl', sha256: sha(text) }], policy: LabCurationPolicySchema.parse({}),
    familySplit: { 'family-0': 'train', 'family-1': 'train', 'family-2': 'train' }, records };
  const provenancePath = join(directory, 'provenance.json'); await save(provenancePath, provenance);
  return { path, provenancePath, provenance, text };
}

test('approved export preserves exact research input and separates objective metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nickname-export-'));
  const f = await fixtureExport(dir);
  await prepare(f.path, f.provenancePath, join(dir, 'prepared'));
  const manifest = await json(join(dir, 'prepared/manifest.json'));
  assert.equal(manifest.smokeOnly, false);
  assert.equal(manifest.version, 'nickname-preference-v1');
  assert.deepEqual(manifest.rows.map((r: any) => r.label), [true, false, true]);
  assert.equal(manifest.selection.positive, 2);
  assert.equal(await readFile(join(dir, 'prepared/preference.jsonl'), 'utf8'), f.text);
  await assert.rejects(readFile(join(dir, 'prepared/train.jsonl')));
  assert.ok(!f.text.includes('expectedReason'));
});

test('unapproved, stale, cross-split, and modified export data fail closed', async () => {
  for (const mutate of [
    (p: any) => { p.records[0].candidate.status = 'draft'; },
    (p: any) => { p.records[0].candidate.stale = true; },
    (p: any) => { p.familySplit['family-0'] = 'test'; },
    (p: any) => { p.records[0].review.resultHash = '0'.repeat(64); },
    (p: any) => { p.files[0].sha256 = '0'.repeat(64); },
    (p: any) => { p.scope.feedbackPolicy = 'other policy'; },
    (p: any) => { p.version = 'human-curation-v1'; },
  ]) {
    const dir = await mkdtemp(join(tmpdir(), 'nickname-reject-')), f = await fixtureExport(dir);
    mutate(f.provenance); await writeFile(f.provenancePath, JSON.stringify(f.provenance));
    await assert.rejects(prepare(f.path, f.provenancePath, join(dir, 'prepared')));
  }
});

test('model inputs reject hidden labels and targets reject invented citations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nickname-protocol-'));
  await smokeData(join(dir, 'smoke'));
  const rows = lines(await readFile(join(dir, 'smoke/train.jsonl'), 'utf8'));
  const messages = structuredClone(rows[0].messages);
  messages[1].content = JSON.stringify({ ...JSON.parse(messages[1].content), expectedScore: 95 });
  assert.throws(() => validateMessages(messages), /actual research protocol/);
  const evidence = rows[1].messages;
  const target = JSON.parse(evidence[2].content); target.evidenceChecks[0].quote = 'invented';
  evidence[2].content = JSON.stringify(target);
  assert.throws(() => validateMessages(evidence), /supplied evidence/);
});

test('replay returns the same frozen evidence, preserves empty results, and never falls back', async () => {
  const corpus = { version: 'nickname-search-replay-v1' as const, entries: {
    [queryKey('달빛 뜻', 'ko')]: { query: '달빛 뜻', language: 'ko', sources: [], collectedAt: '2026-11-25' } } };
  const replay = replayProvider(corpus);
  assert.deepEqual(await replay.search('  달빛   뜻 ', 'ko', new AbortController().signal), []);
  await assert.rejects(replay.search('different', 'ko', new AbortController().signal), (e: any) => e.code === 'REPLAY_MISS');
});

async function comparisonFixture(dir: string) {
  const training = { version: 'nickname-sft-v1', smokeOnly: false, trainSha256: 'datahash',
    rows: [{ familyId: 'train-family', nickname: '학습연습', tags: ['obfuscation:none'] }] };
  await save(join(dir, 'training.json'), training);
  const cfg = { model_id: 'Qwen/Qwen3-4B-Instruct-2507', revision: 'a'.repeat(40), precision: 'bf16', backend: 'rocm', quantization: 'none' };
  await save(join(dir, 'base.json'), { version: 'nickname-model-v1', kind: 'base', config: cfg, smokeOnly: false });
  await save(join(dir, 'candidate.json'), { version: 'nickname-model-v1', kind: 'adapter', config: cfg, smokeOnly: false,
    datasetManifestHash: sha(await readFile(join(dir, 'training.json'))), datasetHash: 'datahash' });
  const rows = [0, 1, 2].map(i => ({ purpose: 'evaluation_only', split: 'validation', case: {
    id: `test-${i}`, nickname: `새로운${i}`, familyId: `heldout-${i}`, split: 'validation', tags: ['obfuscation:unseen-glyph'],
    reference: { expectedReason: 'fixture', expectedScore: 5, sources: [] } },
    review: { ...labDefaultReview({ status: 'SUCCEEDED', history: [], error: null } as any), cohort: 'normal' } }));
  await writeFile(join(dir, 'evaluation.jsonl'), rows.map(r => JSON.stringify(r)).join('\n'));
  await save(join(dir, 'corpus.json'), { version: 'nickname-search-replay-v1', entries: {} });
  return { data: join(dir, 'evaluation.jsonl'), training: join(dir, 'training.json'), base: join(dir, 'base.json'),
    candidate: join(dir, 'candidate.json'), policy: resolvePolicy(), output: join(dir, 'frozen'),
    search: 'replay', corpus: join(dir, 'corpus.json') };
}
const resolvePolicy = () => new URL('./policy.json', import.meta.url).pathname;
const fakeIdentity = { backend: 'rocm', gpu_name: 'fake GPU', gpu_arch: 'fake arch', torch_version: 'fake torch',
  engine_version: 'fake Transformers', chat_template_sha256: 'c'.repeat(64) };

test('freeze rejects family leakage and test without validation selection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nickname-freeze-')), options = await comparisonFixture(dir);
  await freeze(options);
  const plan = await json(join(options.output, 'plan.json'));
  assert.deepEqual(plan.dataset[0].slices, ['unseen_family', 'unseen_obfuscation', 'normal']);
  assert.equal(plan.generation.seed, 42);
  let text = await readFile(options.data, 'utf8');
  await writeFile(options.data, text.replaceAll('heldout-0', 'train-family'));
  await assert.rejects(freeze({ ...options, output: join(dir, 'bad') }), /leakage/);
  await writeFile(options.data, text.replaceAll('validation', 'test'));
  await assert.rejects(freeze({ ...options, output: join(dir, 'test') }), /passing validation gate/);
});

test('missing human review and abstention do not improve accuracy or hide normal unresolved cases', () => {
  const plan = { dataset: [{ case: { id: 'one' }, cohort: 'normal', slices: ['normal'] }], policy: { riskThreshold: 50 } };
  const report = { arm: 'D', planHash: 'hash', results: [{ caseId: 'one', output: { score: null, sourceIds: [] },
    durationMs: 10, research: { inputTokens: 10, outputTokens: 5, steps: [] } }] };
  const m = metrics(plan, report, []);
  assert.equal(m.missing, 1); assert.equal(m.rationale, 0); assert.equal(m.normalUnresolved, 1);
  assert.equal(m.citationSupport, null);
});

test('gate requires all four matching arms and keeps base for insufficient evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nickname-gate-')), options = await comparisonFixture(dir);
  await freeze(options);
  const planPath = join(options.output, 'plan.json'), planText = await readFile(planPath, 'utf8'), plan = JSON.parse(planText);
  const paths = [];
  for (const arm of ['A', 'B', 'C', 'D']) {
    const report = { arm, identity: fakeIdentity, planHash: sha(planText), registrationHash: plan[plan.arms[arm].model].hash,
      generation: plan.generation, search: plan.search, corpusHash: plan.corpus.hash,
      results: plan.dataset.map((row: any) => ({ caseId: row.case.id, output: { score: 0, sourceIds: [] },
        error: null, durationMs: 1, research: { steps: [], inputTokens: 10, outputTokens: 5 } })) };
    const path = join(dir, arm + '.json'); await save(path, report); paths.push(path);
  }
  const reviews = join(dir, 'reviews.json'); await reviewTemplate(paths, reviews);
  await assert.rejects(gate(planPath, paths.slice(0, 3), reviews, join(dir, 'missing.json')), /four arms/);
  assert.equal(await gate(planPath, paths, reviews, join(dir, 'gate.json')), 'keep_base');
  const result = await json(join(dir, 'gate.json'));
  assert.ok(result.reasons.some((s: string) => s.includes('missing reviews')));
  assert.ok(result.reasons.some((s: string) => s.includes('insufficient')));
  plan.policy.maxFalsePositiveRate = 0.9;
  await writeFile(planPath, JSON.stringify(plan));
  await assert.rejects(gate(planPath, paths, reviews, join(dir, 'changed.json')), /policy changed/);
});

test('A–D use the real Worker protocol over HTTP and never send evaluation labels', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nickname-worker-')), options = await comparisonFixture(dir);
  const corpus = { version: 'nickname-search-replay-v1', entries: {
    [queryKey('산책 뜻', 'ko')]: { query: '산책 뜻', language: 'ko', collectedAt: new Date().toISOString(),
      sources: [{ title: '합성 자료', url: 'https://example.org/walk', snippet: '산책은 가볍게 걷는 활동이다.', collectedAt: new Date().toISOString() }] } } };
  await writeFile(options.corpus, JSON.stringify(corpus));
  await freeze(options);
  const planPath = join(options.output, 'plan.json'), plan = await json(planPath);
  let currentArm = 'A', calls = 0;
  const server = createServer(async (req, res) => {
    const send = (value: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/health') return send({ ok: true, model: 'fake-local-transformers', busy: false, identity: { ...fakeIdentity,
      registrationHash: plan[plan.arms[currentArm].model].hash, structured_output_transport: 'transformers-lm-format-enforcer',
      precision: 'bf16', seed: 42, weights_sha256: 'b'.repeat(64), chat_template_sha256: 'c'.repeat(64) } });
    let raw = ''; for await (const chunk of req) raw += chunk;
    assert.ok(!/expectedReason|expectedScore|familyId|cohort|heldout-/.test(raw));
    const body = JSON.parse(raw), input = JSON.parse(body.prompt);
    assert.deepEqual(Object.keys(input.case), ['nickname']);
    assert.equal(body.weights_sha256, 'b'.repeat(64));
    if (req.url === '/tokenize') return send({ input_tokens: 600 });
    calls++;
    const isAction = !!body.json_schema.properties.action;
    const value = isAction ? { action: input.sources.length ? 'finish' : 'search', query: input.sources.length ? null : '산책 뜻', hypotheses: [] }
      : { schemaVersion: '2', nickname: input.case.nickname, interpretedTerm: null, reason: '합성 자료를 이용한 프로토콜 검증 응답이다.',
        interpretationStatus: 'literal', score: 5, confidence: 0.8, sourceIds: input.sources.length ? ['S1'] : [], abstained: false,
        evidenceChecks: input.sources.length ? [{ sourceId: 'S1', quote: '산책은 가볍게 걷는 활동', claim: '일반적인 의미', relation: 'ordinary_usage' }] : [] };
    send({ text: JSON.stringify(value), input_tokens: 600, output_tokens: 100, seconds: 0.01, finish_reason: 'stop' });
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    for (const arm of ['A', 'B', 'C', 'D']) {
      currentArm = arm;
      const output = join(dir, arm);
      await evaluate(planPath, arm, endpoint, output);
      const report = await json(join(output, 'report.json'));
      assert.equal(report.results.length, 3);
      assert.ok(report.results.every((r: any) => !r.error && r.output));
      assert.ok(report.results.every((r: any) => r.searchCount === (arm === 'A' || arm === 'C' ? 0 : 1)));
    }
    assert.equal(calls, 24);
  } finally { await new Promise<void>((ok, reject) => server.close(e => e ? reject(e) : ok())); }
});

test('passing validation selects a fixed candidate for test but cannot adopt it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nickname-pass-')), options = await comparisonFixture(dir);
  const policy = { ...await json(resolvePolicy()), minCases: 3, minNormal: 3, minPerSlice: 3, minCitations: 1 };
  options.policy = join(dir, 'policy.json'); await save(options.policy, policy);
  await freeze(options);
  const planPath = join(options.output, 'plan.json'), planText = await readFile(planPath, 'utf8'), plan = JSON.parse(planText);
  const paths = [];
  for (const arm of ['A', 'B', 'C', 'D']) {
    const report = { arm, identity: fakeIdentity, planHash: sha(planText), registrationHash: plan[plan.arms[arm].model].hash,
      generation: plan.generation, search: plan.search, corpusHash: plan.corpus.hash,
      results: plan.dataset.map((row: any) => ({ caseId: row.case.id, output: { score: 5, sourceIds: arm === 'B' || arm === 'D' ? ['S1'] : [] },
        error: null, durationMs: 10, research: { steps: [{ kind: 'answer', answer: {}, durationMs: 10 }], inputTokens: 10, outputTokens: 5 } })) };
    const path = join(dir, arm + '.json'); await save(path, report); paths.push(path);
  }
  const reviewPath = join(dir, 'reviews.json'); await reviewTemplate(paths, reviewPath);
  const reviews = await json(reviewPath);
  const baselineMistake = sha(sha(planText) + 'Btest-0');
  for (const review of reviews.rows) Object.assign(review, { reviewer: 'fixture-reviewer', reviewedAt: new Date().toISOString(),
    rationaleFit: review.id !== baselineMistake, interpretationSuccess: true, uncertaintyAppropriate: true,
    searchAppropriate: review.id !== baselineMistake,
    sourceChecks: review.sourceChecks.map((s: any) => ({ ...s, relevant: true, supports: true })) });
  await writeFile(reviewPath, JSON.stringify(reviews));
  const gatePath = join(dir, 'validation-gate.json');
  assert.equal(await gate(planPath, paths, reviewPath, gatePath), 'eligible_for_final_test');
  await assert.rejects(select(options.candidate, join(dir, 'selected.json'), gatePath), /Final test/);
  await writeFile(options.data, (await readFile(options.data, 'utf8')).replaceAll('validation', 'test'));
  await freeze({ ...options, output: join(dir, 'final'), validationGate: gatePath });
  const changedPolicy = { ...policy, maxFalsePositiveRate: 0.5 }; await writeFile(options.policy, JSON.stringify(changedPolicy));
  await assert.rejects(freeze({ ...options, output: join(dir, 'changed'), validationGate: gatePath }), /policy changed/);
});
