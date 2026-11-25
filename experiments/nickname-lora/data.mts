import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import {
  LAB_RESEARCH_SYSTEM_PROMPT, LAB_RESEARCH_ACTION_PROMPT, LAB_RESEARCH_ANSWER_PROMPT,
  LabCandidateSchema, LabHumanReviewSchema, LabResultSchema, LabCurationPolicySchema,
  LabResearchActionSchema, LabResearchAnswerSchema, labBuildCandidate, labValidateSelection, labFamilyKey,
} from '@pcu/contracts';
import { researchPrompt } from '../../apps/api/src/modules/benchmark-worker/research.js';

export const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
export const lines = (text: string) => text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
export async function save(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
export async function newDirectory(path: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await mkdir(path, { mode: 0o700 });
}
export const protocol = () => ({ version: 'nickname-research-v1',
  implementationHashes: Object.fromEntries(['./data.mts', './evaluation.mts', './gate.mts',
    '../../apps/api/src/modules/benchmark-worker/research.ts', '../../apps/api/src/modules/benchmark-worker/search.ts',
    '../../apps/api/src/modules/benchmark-worker/http.ts'].map(path => [path, sha(readFileSync(new URL(path, import.meta.url)))])),
  system: LAB_RESEARCH_SYSTEM_PROMPT, action: LAB_RESEARCH_ACTION_PROMPT, answer: LAB_RESEARCH_ANSWER_PROMPT,
  actionSchema: z.toJSONSchema(LabResearchActionSchema, { target: 'draft-7' }),
  answerSchema: z.toJSONSchema(LabResearchAnswerSchema, { target: 'draft-7' }) });

export function validateMessages(messages: {role: string; content: string}[]) {
  if (messages.map(m => m.role).join(',') !== 'system,user,assistant') throw Error('Expected one exact research generation');
  const input = JSON.parse(messages[1]!.content);
  const expectedKeys = ['case', 'normalizationHypothesis', 'hypotheses', 'searchOutcomes', 'searchesRemaining', 'sources', 'allowedSourceIds', 'originalPagesFetched'];
  if (Object.keys(input).sort().join() !== expectedKeys.sort().join() || Object.keys(input.case).join() !== 'nickname')
    throw Error('Input is not the actual research protocol; legacy/fallback/label-enriched examples must be rerun');
  const value = JSON.parse(messages[2]!.content);
  const action = 'action' in value;
  const expectedSystem = LAB_RESEARCH_SYSTEM_PROMPT + '\n' + (action ? LAB_RESEARCH_ACTION_PROMPT : LAB_RESEARCH_ANSWER_PROMPT);
  if (![expectedSystem, expectedSystem + '\nPrevious JSON was invalid. Regenerate a complete object, exact nickname, valid citations and quotes.'].includes(messages[0]!.content))
    throw Error('System prompt differs from the current inference protocol');
  if (researchPrompt(input.case.nickname, input.hypotheses, input.searchOutcomes, input.searchesRemaining, input.sources) !== messages[1]!.content)
    throw Error('Inference prompt projection changed');
  if (action) {
    const target = LabResearchActionSchema.parse(value);
    if (target.action === 'search' ? !target.query?.trim() : target.query !== null) throw Error('Invalid action/query');
    if (target.action === 'search' && input.searchesRemaining <= 0) throw Error('Search budget exhausted');
  } else {
    const answer = LabResearchAnswerSchema.parse(value);
    if (answer.nickname !== input.case.nickname || (answer.abstained && answer.score !== null) ||
        (answer.interpretationStatus === 'unverified_hypothesis' && (!answer.abstained || answer.score !== null)) ||
        (answer.interpretationStatus === 'supported_hypothesis' && !answer.sourceIds.length)) throw Error('Invalid answer semantics');
    if (/https?:\/\//i.test(answer.reason + (answer.interpretedTerm ?? ''))) throw Error('Use supplied IDs, not URLs');
    for (const check of answer.evidenceChecks) {
      const source = input.sources.find((s: {id: string}) => s.id === check.sourceId);
      if (!source || !check.quote.trim() || !source.snippet.includes(check.quote)) throw Error('Citation not in supplied evidence');
    }
    if (new Set(answer.sourceIds).size !== answer.sourceIds.length || answer.sourceIds.some(id =>
      !answer.evidenceChecks.some(e => e.sourceId === id && e.relation !== 'unrelated'))) throw Error('Unsupported citation');
  }
  return { input, value, action };
}

export async function prepare(trainPath: string, provenancePath: string, output: string) {
  const text = await readFile(trainPath, 'utf8');
  const provenanceText = await readFile(provenancePath, 'utf8');
  const provenance = JSON.parse(provenanceText);
  if (provenance.version !== 'human-curation-v1' || provenance.kind !== 'train' ||
      !provenance.files.some((f: {filename: string; sha256: string}) => f.filename === basename(trainPath) && f.sha256 === sha(text)))
    throw Error('Train file is not bound to this Human Evaluation export');
  const raw = lines(text);
  if (!raw.length || raw.length !== provenance.records.length) throw Error('Export row count mismatch');
  const candidates = [];
  const metadata: { caseId: string; nickname: string; familyId: string; tags: string[]; categories: string[];
    objective: string; cohort: string; candidateId: string; reviewId: string; reviewRevision: number; retention: boolean }[] = [];
  for (const [i, record] of provenance.records.entries()) {
    const candidate = LabCandidateSchema.parse(record.candidate);
    const review = LabHumanReviewSchema.parse(record.review);
    const result = LabResultSchema.parse(record.originalResult);
    if (result.testCase.tags.filter(t => t.startsWith('obfuscation:')).length !== 1)
      throw Error('Training cases need one obfuscation:<method> tag (or obfuscation:none) for held-out style validation');
    if (candidate.reviewId !== review.id || candidate.caseId !== result.caseId || review.caseId !== result.caseId ||
        review.resultHash !== sha(JSON.stringify(result)) ||
        candidate.runId !== review.runId || candidate.body.familyId !== labFamilyKey(result.testCase.familyId ?? '') ||
        provenance.familySplit[candidate.body.familyId] !== 'train' || candidate.body.split !== 'train' ||
        (result.testCase.split && result.testCase.split !== 'train')) throw Error('Review/split provenance mismatch');
    const decision = candidate.decisions.at(-1);
    if (!decision || decision.decision !== 'approved' || !decision.grounded || !decision.familyVerified)
      throw Error('Human approval is required');
    if (candidate.contentHash !== sha(JSON.stringify(candidate.body))) throw Error('Candidate content changed');
    const rebuilt = labBuildCandidate(result, review.body, { reviewId: review.id, objective: candidate.body.objective,
      ...(candidate.body.stepIndex !== null ? {stepIndex: candidate.body.stepIndex} : {}) }, 'train');
    if (JSON.stringify(rebuilt) !== JSON.stringify(candidate.body) ||
        JSON.stringify(raw[i]) !== JSON.stringify({ messages: candidate.body.messages })) throw Error('Recorded model context or target changed');
    const { value, action } = validateMessages(candidate.body.messages);
    const categories = ['json_contract', ...(action ? ['investigation_action',
      ...(value.query || value.hypotheses.length ? ['meaning_query'] : [])] : [
      ...(candidate.body.suppliedSources.length ? ['evidence_judgment'] : []),
      ...(value.abstained ? ['abstention'] : []), ...(candidate.body.cohort === 'normal' ? ['normal_retention'] : []),
    ])];
    metadata.push({ caseId: candidate.caseId, nickname: result.testCase.nickname, familyId: candidate.body.familyId,
      tags: result.testCase.tags, categories, objective: candidate.body.objective, cohort: candidate.body.cohort,
      candidateId: candidate.id, reviewId: review.id, reviewRevision: review.revision, retention: candidate.body.retention });
    candidates.push(candidate);
  }
  const selection = labValidateSelection(candidates, LabCurationPolicySchema.parse(provenance.policy));
  await newDirectory(output);
  await writeFile(join(output, 'train.jsonl'), text, { mode: 0o600, flag: 'wx' });
  await writeFile(join(output, 'provenance.json'), provenanceText, { mode: 0o600, flag: 'wx' });
  await save(join(output, 'manifest.json'), { version: 'nickname-sft-v1', split: 'train', smokeOnly: false,
    trainSha256: sha(text), provenanceSha256: sha(provenanceText), exportId: provenance.id,
    datasetVersion: provenance.datasetHash, protocolHash: sha(JSON.stringify(protocol())), rows: metadata, selection,
    categoryCounts: Object.fromEntries(['investigation_action', 'meaning_query', 'evidence_judgment', 'abstention', 'normal_retention', 'json_contract']
      .map(category => [category, metadata.filter(row => row.categories.includes(category)).length])) });
}

// Only plumbing fixtures. These are never labeled as human-reviewed data or eligible for promotion.
export async function smokeData(output: string) {
  const nickname = '달빛산책연습';
  const source = { id: 'S1', title: '합성 smoke 자료', snippet: '산책은 가볍게 걷는 활동을 뜻한다.',
    evidenceKind: 'search_snippet' as const, originalFetched: false as const };
  const examples = [
    { stage: 'action', sources: [], target: { action: 'search', query: '산책 뜻', hypotheses: [{ term: '산책', basis: '일반적인 걷기 활동인지 확인' }] } },
    { stage: 'answer', sources: [source], target: { evidenceChecks: [{ sourceId: 'S1', quote: '산책은 가볍게 걷는 활동', claim: '산책의 일반적인 의미', relation: 'ordinary_usage' }],
      interpretationStatus: 'literal', schemaVersion: '2', nickname, interpretedTerm: '산책', reason: '제공된 발췌문은 산책을 가볍게 걷는 활동으로 설명한다. 닉네임은 달빛 아래 걷는 일반적인 표현으로 해석할 수 있다. 원문 페이지와 작성자의 의도는 확인하지 않았다.',
      score: 5, confidence: 0.8, sourceIds: ['S1'], abstained: false } },
    { stage: 'answer', sources: [], target: { evidenceChecks: [], interpretationStatus: 'unverified_hypothesis', schemaVersion: '2', nickname,
      interpretedTerm: null, reason: '표기만으로 특정한 은어나 비속어의 뜻을 확정할 근거가 부족하다. 일반적인 독법도 가능하지만 추가 자료가 없어 판단을 유보한다.', score: null, confidence: 0.2, sourceIds: [], abstained: true } },
  ];
  const rows = examples.map(e => ({ messages: [
    { role: 'system', content: LAB_RESEARCH_SYSTEM_PROMPT + '\n' + (e.stage === 'action' ? LAB_RESEARCH_ACTION_PROMPT : LAB_RESEARCH_ANSWER_PROMPT) },
    { role: 'user', content: researchPrompt(nickname, [], [], 2, e.sources) },
    { role: 'assistant', content: JSON.stringify(e.target) },
  ] }));
  rows.forEach(r => validateMessages(r.messages));
  const text = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  await newDirectory(output);
  await writeFile(join(output, 'train.jsonl'), text, { mode: 0o600, flag: 'wx' });
  await save(join(output, 'manifest.json'), { version: 'nickname-sft-v1', split: 'train', smokeOnly: true,
    trainSha256: sha(text), protocolHash: sha(JSON.stringify(protocol())),
    rows: rows.map((_, i) => ({ caseId: `synthetic-${i}`, nickname, familyId: 'synthetic-smoke', tags: [], categories: ['plumbing_only'] })) });
}
