import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { LAB_RESEARCH_PROFILE, LAB_RESEARCH_LIMITS, LabCaseSchema, LabReviewBodySchema, LabSourceSchema,
  labFamilyKey, labNicknameInput, type LabSource } from '@pcu/contracts';
import { evaluateResearch, type ResearchTransport } from '../../apps/api/src/modules/benchmark-worker/research.js';
import { createSearchProvider, type SearchProvider } from '../../apps/api/src/modules/benchmark-worker/search.js';
import { LabFailure, requestJson } from '../../apps/api/src/modules/benchmark-worker/http.js';
import { sha, json, lines, save, protocol, newDirectory } from './data.mts';

const rate = z.number().min(0).max(1);
export const Policy = z.strictObject({ version: z.literal('nickname-promotion-v1'), riskThreshold: z.number().int().min(1).max(100),
  minCases: z.number().int().positive(), minNormal: z.number().int().positive(), minPerSlice: z.number().int().positive(),
  minCitations: z.number().int().positive(), maxFalsePositiveRate: rate, maxFalsePositiveRegression: rate,
  minRationaleGain: rate, minSearchGain: rate, maxQualityRegression: rate, minCitationSupport: rate,
  maxScoreMaeRegression: z.number().min(0).max(100),
  minJsonValidity: rate, minUncertaintyQuality: rate, maxNormalUnresolved: rate,
  maxTokenRatio: z.number().positive(), maxLatencyRatio: z.number().positive(), requireReplay: z.boolean() });
export const queryKey = (query: string, language: string) => JSON.stringify([language, labFamilyKey(query)]);
const Corpus = z.strictObject({ version: z.literal('nickname-search-replay-v1'), entries: z.record(z.string(),
  z.strictObject({ query: z.string(), language: z.string(), sources: z.array(LabSourceSchema.omit({ id: true })), collectedAt: z.string() })) });
export function replayProvider(corpus: z.infer<typeof Corpus>): SearchProvider {
  return { async search(query, language) {
    const entry = corpus.entries[queryKey(query, language)];
    if (!entry) throw new LabFailure('REPLAY_MISS');
    return structuredClone(entry.sources);
  } };
}

export async function freeze(options: { data: string; training: string; base: string; candidate: string; policy: string;
  output: string; search: string; corpus?: string; validationGate?: string; unconstrained?: boolean }) {
  if (!['replay', 'live'].includes(options.search)) throw Error('--search must be replay or live');
  const [dataText, trainText, baseText, candidateText] = await Promise.all([
    readFile(options.data, 'utf8'), readFile(options.training, 'utf8'), readFile(options.base, 'utf8'), readFile(options.candidate, 'utf8')]);
  const training = JSON.parse(trainText), base = JSON.parse(baseText), candidate = JSON.parse(candidateText);
  const policy = Policy.parse(await json(options.policy));
  if (training.smokeOnly || candidate.smokeOnly || base.smokeOnly) throw Error('Synthetic smoke runs cannot enter quality evaluation or promotion');
  if (training.version !== 'nickname-sft-v1' || candidate.datasetManifestHash !== sha(trainText) || candidate.datasetHash !== training.trainSha256)
    throw Error('Candidate was not trained on this dataset manifest');
  if (base.version !== 'nickname-model-v1' || candidate.version !== 'nickname-model-v1' ||
      base.kind !== 'base' || candidate.kind !== 'adapter' || base.config.model_id !== candidate.config.model_id ||
      base.config.revision !== candidate.config.revision || base.config.precision !== candidate.config.precision ||
      base.config.quantization !== candidate.config.quantization || base.config.backend !== candidate.config.backend)
    throw Error('Compare the same original model revision, precision, quantization and backend');
  const generation = { ...LAB_RESEARCH_LIMITS, schemaMode: options.unconstrained ? 'unconstrained' : 'constrained',
    precision: base.config.precision, backend: base.config.backend, seed: 42 };
  const trainedFamilies = new Set(training.rows.map((r: any) => labFamilyKey(r.familyId)));
  const trainedNames = new Set(training.rows.map((r: any) => labFamilyKey(r.nickname)));
  const trainedStyles = new Set(training.rows.flatMap((r: any) => r.tags.filter((t: string) => t.startsWith('obfuscation:'))));
  const seenIds = new Set<string>(), seenNames = new Set<string>();
  const dataset = lines(dataText).map(row => {
    if (row.purpose !== 'evaluation_only' || !['validation', 'test'].includes(row.split)) throw Error('Expected Human Evaluation validation/test export');
    const item = LabCaseSchema.parse(row.case);
    const review = LabReviewBodySchema.parse(row.review.body ?? row.review);
    if (!item.familyId || !review.cohort || (item.split && item.split !== row.split)) throw Error('Missing or inconsistent family/split/cohort');
    if (trainedFamilies.has(labFamilyKey(item.familyId)) || trainedNames.has(labFamilyKey(item.nickname))) throw Error('Train/evaluation family or nickname leakage');
    const style = item.tags.filter(t => t.startsWith('obfuscation:'));
    if (style.length !== 1) throw Error('Each evaluation case requires one obfuscation:<method> tag (or obfuscation:none)');
    if (seenIds.has(item.id) || seenNames.has(labFamilyKey(item.nickname))) throw Error('Duplicate evaluation case');
    seenIds.add(item.id); seenNames.add(labFamilyKey(item.nickname));
    return { case: item, split: row.split, cohort: review.cohort, slices: ['unseen_family',
      ...(style[0] !== 'obfuscation:none' && !trainedStyles.has(style[0]) ? ['unseen_obfuscation'] : []),
      ...(review.cohort === 'normal' ? ['normal'] : [])] };
  });
  const split = dataset[0]?.split;
  if (!dataset.length || dataset.some(r => r.split !== split)) throw Error('Evaluate one nonempty split at a time');
  let validationGateHash: string | null = null;
  if (split === 'test') {
    if (!options.validationGate) throw Error('Final test requires a passing validation gate with the frozen candidate');
    const gateText = await readFile(options.validationGate, 'utf8');
    const gate = JSON.parse(gateText);
    if (gate.decision !== 'eligible_for_final_test' || gate.candidateHash !== sha(candidateText) ||
        gate.policyHash !== sha(JSON.stringify(policy))) throw Error('Candidate or policy changed since validation selection');
    if (gate.protocolHash !== sha(JSON.stringify(protocol())) || JSON.stringify(gate.generation) !== JSON.stringify(generation))
      throw Error('Protocol or generation settings changed since validation selection');
    validationGateHash = sha(gateText);
  }
  let corpus = null;
  if (options.search === 'replay') {
    if (!options.corpus) throw Error('Freeze a search corpus before replay evaluation');
    const raw = await readFile(options.corpus, 'utf8');
    Corpus.parse(JSON.parse(raw));
    corpus = { path: resolve(options.corpus), hash: sha(raw) };
  }
  await newDirectory(options.output);
  await save(join(options.output, 'plan.json'), { version: 'nickname-comparison-v1', createdAt: new Date().toISOString(),
    nodeVersion: process.version, platform: process.platform, architecture: process.arch,
    split, dataset, datasetHash: sha(dataText), trainingHash: sha(trainText),
    base: { path: resolve(options.base), hash: sha(baseText) }, candidate: { path: resolve(options.candidate), hash: sha(candidateText) },
    policy, policyHash: sha(JSON.stringify(policy)), protocolHash: sha(JSON.stringify(protocol())),
    search: options.search, corpus, validationGateHash,
    generation,
    arms: { A: { model: 'base', searchMode: 'no_search' }, B: { model: 'base', searchMode: 'agentic_retrieval' },
      C: { model: 'candidate', searchMode: 'no_search' }, D: { model: 'candidate', searchMode: 'agentic_retrieval' } } });
}

export async function evaluate(planPath: string, arm: string, endpoint: string, output: string, searchUrl?: string) {
  const planText = await readFile(planPath, 'utf8'), plan = JSON.parse(planText);
  if (!plan.arms[arm] || plan.protocolHash !== sha(JSON.stringify(protocol()))) throw Error('Unknown arm or inference protocol changed since freeze');
  const spec = plan.arms[arm], registration = plan[spec.model];
  if (sha(await readFile(registration.path)) !== registration.hash) throw Error('Registration changed');
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password)
    throw Error('The experiment inference endpoint must be loopback');
  const signal = new AbortController();
  const interrupt = () => signal.abort();
  process.once('SIGINT', interrupt);
  const health = await requestJson(endpoint + '/health', { signal: AbortSignal.timeout(5000) }, 32000) as any;
  const expectedTransport = plan.generation.schemaMode === 'constrained' ? 'transformers-lm-format-enforcer' : 'transformers-unconstrained';
  if (health.identity?.registrationHash !== registration.hash || health.identity.structured_output_transport !== expectedTransport ||
      health.identity.precision !== plan.generation.precision || health.identity.seed !== plan.generation.seed)
    throw Error('Serving model or generation settings do not match the frozen plan');
  if (health.identity.backend !== plan.generation.backend || !health.identity.gpu_name || !health.identity.gpu_arch)
    throw Error('Serving GPU backend or hardware identity is missing or changed');
  const transport: ResearchTransport = {
    async health(s) {
      const current = await requestJson(endpoint + '/health', { signal: s }, 32000) as any;
      if (JSON.stringify(current.identity) !== JSON.stringify(health.identity)) throw new LabFailure('MODEL_IDENTITY_CHANGED');
      return current;
    },
    request(path, body, s) { return requestJson(endpoint + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: s }, 128000); },
  };
  let search: SearchProvider;
  if (plan.search === 'replay') {
    const text = await readFile(plan.corpus.path, 'utf8');
    if (sha(text) !== plan.corpus.hash) throw Error('Replay corpus changed after freeze');
    search = replayProvider(Corpus.parse(JSON.parse(text)));
  } else {
    if (!searchUrl && spec.searchMode !== 'no_search') throw Error('Live evaluation requires --search-url');
    search = createSearchProvider(searchUrl);
  }
  await newDirectory(output);
  // Fail closed before exposing final results, across copied plans and different output paths.
  if (plan.split === 'test') {
    const ledger = fileURLToPath(new URL('./artifacts/final-tests/', import.meta.url));
    await mkdir(ledger, { recursive: true, mode: 0o700 });
    await save(join(ledger, sha(plan.candidate.hash + plan.datasetHash + arm) + '.json'),
      { planHash: sha(planText), candidateHash: plan.candidate.hash, arm, startedAt: new Date().toISOString() });
  }
  const results = [];
  try {
    for (const row of plan.dataset) {
      signal.signal.throwIfAborted();
      const attempt = await evaluateResearch({ enabled: true, provider: 'transformers-generate', model: health.model,
        modelUrl: endpoint, generateProfile: LAB_RESEARCH_PROFILE, concurrency: 1 },
        { provider: 'transformers-generate', model: health.model, temperature: 0, maxTokens: 768,
          searchMode: spec.searchMode, input: labNicknameInput(row.case.nickname) }, signal.signal, 'unsupported', search, transport);
      const result = { caseId: row.case.id, ...attempt };
      results.push(result);
      await save(join(output, `${row.case.id}.json`), result);
    }
    await save(join(output, 'report.json'), { version: 'nickname-arm-v1', arm, planHash: sha(planText),
      registrationHash: registration.hash, identity: health.identity, generation: plan.generation, search: plan.search,
      corpusHash: plan.corpus?.hash ?? null, results });
  } finally { process.removeListener('SIGINT', interrupt); }
}

// Collect from existing live traces of BOTH models, then freeze. No evaluation-time corpus mutation.
export async function corpusFromReports(paths: string[], output: string) {
  const entries: Record<string, {query: string; language: string; sources: Omit<LabSource, 'id'>[]; collectedAt: string}> = {};
  for (const path of paths) {
    const report = await json(path);
    if (report.search !== 'live' && report.verification !== 'live-provider') throw Error('Only live observations can seed a replay corpus');
    for (const row of report.results) for (const step of row.research?.steps ?? []) {
      if (step.kind !== 'search' || step.error) continue;
      const key = queryKey(step.query, step.language);
      // First observation wins, including genuine empty results. Later drift is not silently substituted.
      entries[key] ??= { query: step.query, language: step.language, collectedAt: new Date().toISOString(),
        sources: step.sources.map(({ id: _id, ...source }: LabSource) => source) };
    }
  }
  if (!Object.keys(entries).length) throw Error('No successful live searches to freeze');
  await save(output, Corpus.parse({ version: 'nickname-search-replay-v1', entries }));
}

export async function captureQueries(path: string, searchUrl: string, output: string) {
  const querySchema = z.strictObject({ query: z.string().trim().min(1).max(100), language: z.literal('ko') });
  const queries = z.array(querySchema).min(1).max(1000).parse(lines(await readFile(path, 'utf8')));
  const provider = createSearchProvider(searchUrl);
  const entries: z.infer<typeof Corpus>['entries'] = {};
  for (const query of queries) {
    const key = queryKey(query.query, query.language);
    if (entries[key]) continue;
    const sources = await provider.search(query.query, query.language, AbortSignal.timeout(10000));
    entries[key] = { ...query, sources, collectedAt: new Date().toISOString() };
  }
  await save(output, Corpus.parse({ version: 'nickname-search-replay-v1', entries }));
}
