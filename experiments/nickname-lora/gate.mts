import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { sha, json, save, protocol } from './data.mts';
import { Policy } from './evaluation.mts';

export async function reviewTemplate(reportPaths: string[], output: string) {
  const rows = [];
  for (const path of reportPaths) {
    const report = await json(path);
    for (const result of report.results) {
      const resultHash = sha(JSON.stringify(result));
      // Blind model identity while keeping exact prompts/evidence for human inspection.
      rows.push({ id: sha(report.planHash + report.arm + result.caseId), resultHash,
        caseId: result.caseId, output: result.output, error: result.error,
        steps: result.research?.steps, sources: result.sources,
        reviewer: '', reviewedAt: null, rationaleFit: null, interpretationSuccess: null,
        uncertaintyAppropriate: null, searchAppropriate: null,
        sourceChecks: (result.output?.sourceIds ?? []).map((sourceId: string) => ({ sourceId, relevant: null, supports: null })), notes: '' });
    }
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  await save(output, { version: 'nickname-blind-review-v1', rows });
}

export function metrics(plan: any, report: any, reviewRows: any[], slice?: string) {
  const cases = plan.dataset.filter((r: any) => !slice || r.slices.includes(slice));
  let valid = 0, jsonGenerations = 0, generations = 0, rationale = 0, interpretation = 0, uncertainty = 0, search = 0;
  let normal = 0, falsePositive = 0, normalUnresolved = 0, citations = 0, supported = 0, missing = 0;
  let tokens = 0, outputTokens = 0, durationMs = 0, generationMs = 0, replayMisses = 0, failures = 0, infrastructureFailures = 0;
  let scored = 0, absoluteError = 0, inRange = 0, unresolved = 0, problematic = 0, falseNegative = 0, problematicUnresolved = 0;
  const modelFailures = new Set(['INVALID_MODEL_JSON', 'INVALID_MODEL_OUTPUT', 'INVALID_RESEARCH_ACTION', 'MODEL_OUTPUT_TRUNCATED',
    'GENERATION_LIMIT', 'TOTAL_OUTPUT_TOKEN_LIMIT', 'TOTAL_INPUT_TOKEN_LIMIT', 'SEARCH_LIMIT']);
  for (const row of cases) {
    const result = report.results.find((r: any) => r.caseId === row.case.id);
    if (!result) { missing++; continue; }
    const id = sha(report.planHash + report.arm + result.caseId);
    const review = reviewRows.find(r => r.id === id);
    if (!review || review.resultHash !== sha(JSON.stringify(result)) || !review.reviewer?.trim() ||
        !review.reviewedAt || !Number.isFinite(Date.parse(review.reviewedAt)) ||
        ['rationaleFit', 'interpretationSuccess', 'uncertaintyAppropriate', 'searchAppropriate'].some(k => typeof review[k] !== 'boolean')) {
      missing++;
    } else {
      rationale += Number(review.rationaleFit); interpretation += Number(review.interpretationSuccess);
      uncertainty += Number(review.uncertaintyAppropriate); search += Number(review.searchAppropriate);
    }
    valid += Number(!!result.output && !result.error);
    failures += Number(!!result.error);
    infrastructureFailures += Number(!!result.error && !modelFailures.has(result.error));
    const score = result.error ? null : result.output?.score ?? null;
    if (score === null) unresolved++;
    else if (row.case.reference) {
      scored++;
      absoluteError += Math.abs(score - row.case.reference.expectedScore);
      const range = row.case.reference.scoreRange ?? [row.case.reference.expectedScore, row.case.reference.expectedScore];
      inRange += Number(score >= range[0] && score <= range[1]);
    }
    if (row.cohort === 'problematic') {
      problematic++;
      if (score === null) problematicUnresolved++;
      else falseNegative += Number(score < plan.policy.riskThreshold);
    }
    if (!Number.isFinite(result.research?.inputTokens) || !Number.isFinite(result.research?.outputTokens) || !Number.isFinite(result.durationMs)) missing++;
    else { tokens += result.research.inputTokens + result.research.outputTokens; outputTokens += result.research.outputTokens; durationMs += result.durationMs; }
    for (const step of result.research?.steps ?? []) {
      if (step.kind === 'search') {
        replayMisses += Number(step.error === 'REPLAY_MISS');
        if (step.error) infrastructureFailures++;
      } else {
        generations++;
        generationMs += step.durationMs;
        // Schema/semantic repair attempts remain failures in the generation-level stability metric.
        jsonGenerations += Number(!step.error && !!(step.action || step.answer));
      }
    }
    if (row.cohort === 'normal') {
      normal++;
      if (result.output?.score == null || result.error) normalUnresolved++;
      else falsePositive += Number(result.output.score >= plan.policy.riskThreshold);
    }
    for (const sourceId of result.output?.sourceIds ?? []) {
      citations++;
      const checks = review?.sourceChecks?.filter((s: any) => s.sourceId === sourceId) ?? [];
      if (checks.length !== 1 || typeof checks[0].supports !== 'boolean' || typeof checks[0].relevant !== 'boolean') missing++;
      else supported += Number(checks[0].supports && checks[0].relevant);
    }
  }
  const n = cases.length, ratio = (a: number, b: number) => b ? a / b : null;
  const fp = normal ? falsePositive / normal : 0, z2 = 1.96 ** 2;
  return { cases: n, normal, citations, missing, failures, infrastructureFailures, replayMisses,
    scoredCases: scored, scoreMae: ratio(absoluteError, scored), scoreRangeAccuracy: ratio(inRange, n),
    unresolved: ratio(unresolved, n), problematic, falseNegative: ratio(falseNegative, problematic),
    problematicUnresolved: ratio(problematicUnresolved, problematic),
    json: ratio(valid, n), generationJson: ratio(jsonGenerations, generations), rationale: ratio(rationale, n),
    interpretation: ratio(interpretation, n), uncertainty: ratio(uncertainty, n), search: ratio(search, n),
    falsePositive: ratio(falsePositive, normal), normalUnresolved: ratio(normalUnresolved, normal),
    falsePositiveWilsonUpper: normal ? (fp + z2 / (2 * normal) + 1.96 * Math.sqrt(fp * (1 - fp) / normal + z2 / (4 * normal ** 2))) / (1 + z2 / normal) : null,
    citationSupport: ratio(supported, citations), meanTokens: ratio(tokens, n), meanDurationMs: ratio(durationMs, n),
    inputTokens: tokens - outputTokens, outputTokens, meanGenerationMs: ratio(generationMs, n),
    completionTokensPerGenerationSecond: generationMs ? outputTokens / (generationMs / 1000) : null };
}

export async function gate(planPath: string, reportPaths: string[], reviewPath: string, output: string) {
  const planText = await readFile(planPath, 'utf8'), plan = JSON.parse(planText);
  if (plan.protocolHash !== sha(JSON.stringify(protocol()))) throw Error('Evaluation implementation changed since freeze');
  const policy = Policy.parse(plan.policy);
  if (sha(JSON.stringify(policy)) !== plan.policyHash) throw Error('Frozen policy changed');
  const reviewText = await readFile(reviewPath, 'utf8'), reviews = JSON.parse(reviewText);
  if (reviews.version !== 'nickname-blind-review-v1' || new Set(reviews.rows.map((r: any) => r.id)).size !== reviews.rows.length)
    throw Error('Invalid or duplicate human reviews');
  const reports: Record<string, any> = {};
  const hashes: Record<string, string> = {};
  for (const path of reportPaths) {
    const text = await readFile(path, 'utf8'), report = JSON.parse(text);
    if (!plan.arms[report.arm] || reports[report.arm] || report.planHash !== sha(planText) ||
        report.registrationHash !== plan[plan.arms[report.arm].model].hash ||
        JSON.stringify(report.generation) !== JSON.stringify(plan.generation) || report.search !== plan.search ||
        report.corpusHash !== (plan.corpus?.hash ?? null) || report.results.length !== plan.dataset.length ||
        new Set(report.results.map((r: any) => r.caseId)).size !== plan.dataset.length)
      throw Error('Missing, duplicate, stale, or mismatched comparison arm');
    reports[report.arm] = report; hashes[report.arm] = sha(text);
  }
  if (Object.keys(reports).sort().join() !== 'A,B,C,D') throw Error('All four arms are required');
  const measurements: Record<string, Record<string, ReturnType<typeof metrics>>> = Object.fromEntries(Object.entries(reports).map(([arm, report]) => [arm, {
    all: metrics(plan, report, reviews.rows), ...Object.fromEntries(['unseen_family', 'unseen_obfuscation', 'normal']
      .map(slice => [slice, metrics(plan, report, reviews.rows, slice)])) }]));
  const reasons: string[] = [];
  const check = (ok: boolean, reason: string) => { if (!ok) reasons.push(reason); };
  const number = (v: any) => typeof v === 'number' && Number.isFinite(v);
  const ge = (v: any, threshold: number) => number(v) && v >= threshold;
  const le = (v: any, threshold: number) => number(v) && v <= threshold;
  check(!policy.requireReplay || plan.search === 'replay', 'Promotion requires a frozen replay comparison');
  const runtimeKeys = ['backend', 'gpu_name', 'gpu_arch', 'torch_version', 'engine_version', 'chat_template_sha256'];
  check(runtimeKeys.every(key => reports.A.identity?.[key] && ['B', 'C', 'D'].every(arm =>
    reports[arm].identity?.[key] === reports.A.identity[key])), 'Hardware, engine, or chat template differs across arms');
  for (const arm of ['A', 'B', 'C', 'D']) {
    const m: any = measurements[arm]!.all;
    check(!m.missing && !m.replayMisses && !m.infrastructureFailures, `${arm}: missing reviews/measurements, provider failures, or replay misses`);
    check(m.cases >= policy.minCases && m.normal >= policy.minNormal, `${arm}: insufficient cases/normal controls`);
  }
  for (const [baseline, candidate] of [['A', 'C'], ['B', 'D']]) {
    const b: any = measurements[baseline!]!.all, c: any = measurements[candidate!]!.all;
    check(le(c.falsePositive, policy.maxFalsePositiveRate) && le(c.falsePositive, b.falsePositive + policy.maxFalsePositiveRegression), `${candidate}: normal false positives`);
    check(le(c.normalUnresolved, policy.maxNormalUnresolved), `${candidate}: unresolved normal cases`);
    check(ge(c.json, policy.minJsonValidity) && ge(c.generationJson, policy.minJsonValidity), `${candidate}: JSON stability including repairs`);
    check(ge(c.uncertainty, policy.minUncertaintyQuality), `${candidate}: uncertainty handling`);
    check(ge(c.json, b.json - policy.maxQualityRegression) && ge(c.generationJson, b.generationJson - policy.maxQualityRegression) &&
      ge(c.uncertainty, b.uncertainty - policy.maxQualityRegression), `${candidate}: JSON/uncertainty regression`);
    check(le(c.meanTokens, b.meanTokens * policy.maxTokenRatio), `${candidate}: token regression`);
    check(le(c.meanDurationMs, b.meanDurationMs * policy.maxLatencyRatio), `${candidate}: latency regression`);
    check(number(b.scoreMae) && le(c.scoreMae, b.scoreMae + policy.maxScoreMaeRegression), `${candidate}: score MAE regression or unmeasured scores`);
    for (const slice of ['unseen_family', 'unseen_obfuscation', 'normal']) {
      const bs: any = measurements[baseline!]![slice], cs: any = measurements[candidate!]![slice];
      check(cs.cases >= policy.minPerSlice, `${candidate}/${slice}: insufficient sample`);
      check(ge(cs.rationale, bs.rationale - policy.maxQualityRegression) &&
        ge(cs.interpretation, bs.interpretation - policy.maxQualityRegression), `${candidate}/${slice}: quality regression`);
      if (candidate === 'D' && slice !== 'normal') {
        check(ge(cs.rationale, bs.rationale + policy.minRationaleGain), `${candidate}/${slice}: rationale gain below preregistered minimum`);
        check(ge(cs.search, bs.search + policy.minSearchGain), `${candidate}/${slice}: search behavior gain below preregistered minimum`);
      }
    }
  }
  for (const arm of ['B', 'D']) {
    const m: any = measurements[arm]!.all;
    check(m.citations >= policy.minCitations, `${arm}: insufficient citations for support measurement`);
  }
  check(ge(measurements.D!.all.citationSupport, policy.minCitationSupport), 'D: citation support');
  check(ge(measurements.D!.all.citationSupport, (measurements.B!.all.citationSupport ?? 1) - policy.maxQualityRegression), 'D: citation support regression');
  const decision = reasons.length ? 'keep_base' : plan.split === 'validation' ? 'eligible_for_final_test' : 'eligible_for_local_adoption';
  await save(output, { version: 'nickname-gate-v1', decision, reasons, measurements,
    candidateHash: plan.candidate.hash, baseHash: plan.base.hash, policyHash: plan.policyHash,
    protocolHash: plan.protocolHash, generation: plan.generation,
    planHash: sha(planText), reportHashes: hashes, reviewHash: sha(reviewText), split: plan.split,
    note: 'This decision does not deploy or replace the production model.' });
  return decision;
}

export async function select(registrationPath: string, output: string, gatePath?: string) {
  const text = await readFile(registrationPath, 'utf8'), model = JSON.parse(text);
  if (model.version !== 'nickname-model-v1' || model.smokeOnly) throw Error('Invalid or smoke-only registration');
  let gateHash = null;
  if (model.kind === 'adapter') {
    if (!gatePath) throw Error('Adapter selection requires the final test gate');
    const gateText = await readFile(gatePath, 'utf8'), result = JSON.parse(gateText);
    if (result.decision !== 'eligible_for_local_adoption' || result.candidateHash !== sha(text)) throw Error('Final test did not qualify this exact model');
    gateHash = sha(gateText);
  } else if (model.kind !== 'base') throw Error('Invalid registration kind');
  // An explicit, local pointer only. Serving processes are never restarted automatically.
  const value = JSON.stringify({ registration: relative(dirname(resolve(output)), resolve(registrationPath)), registrationHash: sha(text), gateHash,
    scope: 'local_only', selectedAt: new Date().toISOString() }, null, 2) + '\n';
  const temporary = output + '.tmp';
  await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
  await rename(temporary, output);
}
