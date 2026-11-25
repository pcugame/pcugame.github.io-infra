import { randomUUID } from 'node:crypto';
import {
  labReviewResult, LabCandidateSchema, LabCurationExportSchema, LabHumanReviewSchema, LabReviewBodySchema,
  labBuildPreference, labPreferenceScope, labAssertPreferenceScope, labEvaluationLine, labFamilyKey, labFamilyPlan, labHumanMetrics, labTrainingLine, labValidateSelection,
  type LabCandidate, type LabApproveFeedback, type LabCurationExportRequest,
  type LabReviewBody, type LabSaveReview, type LabCase,
} from '@pcu/contracts';
import type { PrismaClient, Prisma, LabHumanReview as ReviewRow, LabTrainingCandidate as CandidateRow } from '../../generated/prisma/client.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { readableRun, resultView, withCase, sha, type Actor } from './access.js';

type Tx = Prisma.TransactionClient;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const viewReview = (r: ReviewRow) => LabHumanReviewSchema.parse({ ...r, createdAt: r.createdAt.toISOString() });
function guarded<T>(fn: () => T): T {
  try { return fn(); } catch (e) { throw badRequest(e instanceof Error ? e.message : 'Invalid curation input', 'VALIDATION_ERROR'); }
}
type FamilyCase = Pick<LabCase, 'nickname' | 'familyId' | 'split'>;
async function familyPlan(tx: Tx, selected: FamilyCase[]) {
  const [rows, fixed] = await Promise.all([
    tx.labTestCase.findMany({ select: { familyId: true, split: true, nickname: true, caseId: true } }),
    tx.labFamilySplit.findMany(),
  ]);
  const families = new Set(selected.flatMap(c => c.familyId ? [labFamilyKey(c.familyId)] : []));
  const names = new Set(selected.map(c => labFamilyKey(c.nickname)));
  for (const row of rows) if (row.familyId && families.has(labFamilyKey(row.familyId))) names.add(labFamilyKey(row.nickname));
  // Quarantine legacy conflicts in their own families; an unrelated historical dataset must not block all curation.
  const relevant = rows.filter(row => names.has(labFamilyKey(row.nickname)) || (row.familyId && families.has(labFamilyKey(row.familyId))));
  for (const row of relevant) if (row.familyId) families.add(labFamilyKey(row.familyId));
  return guarded(() => labFamilyPlan(relevant.map(r => ({ nickname: r.nickname,
    familyId: r.familyId ?? undefined, split: (r.split ?? undefined) as FamilyCase['split'] })),
  Object.fromEntries(fixed.filter(r => families.has(r.familyId)).map(r => [r.familyId, r.split as 'train' | 'validation' | 'test']))));
}
export async function freezeLabFamilies(tx: Tx, selected: FamilyCase[]) {
  // Serialize new datasets and releases across owners; family IDs must be stable across dataset versions.
  await tx.$queryRaw`SELECT 1 AS held FROM pg_advisory_xact_lock(796405102, 1)`;
  const plan = await familyPlan(tx, selected);
  if (Object.keys(plan).length) await tx.labFamilySplit.createMany({
    data: Object.entries(plan).map(([familyId, split]) => ({ familyId, split })), skipDuplicates: true,
  });
  return plan;
}
async function lockRun(tx: Tx, actor: Actor, id: string) {
  await readableRun(tx, actor, id);
  await tx.$queryRaw`SELECT id FROM "LabRun" WHERE id=${id} FOR UPDATE`;
  return readableRun(tx, actor, id);
}
async function getResult(tx: Tx, runId: string, caseId: string) {
  const row = await tx.labResult.findUnique({ where: { runId_caseId: { runId, caseId } }, include: withCase });
  if (!row) throw notFound('Result not found');
  return resultView(row);
}
async function currentReview(tx: Tx, runId: string, caseId: string) {
  return tx.labHumanReview.findFirst({ where: { runId, caseId }, orderBy: { revision: 'desc' } });
}
function viewCandidate(row: CandidateRow, review: ReviewRow, latest: ReviewRow | null, hash: string): LabCandidate {
  return LabCandidateSchema.parse({ ...row, runId: review.runId, caseId: review.caseId, createdAt: row.createdAt.toISOString(),
    stale: review.id !== latest?.id || review.resultHash !== hash });
}
export function createLabHumanRepository(db: PrismaClient) {
  async function state(tx: Tx, actor: Actor, runId: string) {
    const run = await readableRun(tx, actor, runId);
    const [rawResults, rawReviews, candidates, exports] = await Promise.all([
      tx.labResult.findMany({ where: { runId }, include: withCase, orderBy: { ordinal: 'asc' } }),
      tx.labHumanReview.findMany({ where: { runId }, orderBy: { revision: 'desc' } }),
      tx.labTrainingCandidate.findMany({ where: { review: { runId } }, include: { review: true }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }),
      tx.labCurationExport.findMany({ where: { runId }, select: { id: true, runId: true, actorId: true, createdAt: true, kind: true, manifest: true }, orderBy: { createdAt: 'desc' } }),
    ]);
    const results = rawResults.map(resultView);
    const latest = new Map<string, ReviewRow>();
    for (const r of rawReviews) if (!latest.has(r.caseId)) latest.set(r.caseId, r);
    const hashes = new Map(results.map(r => [r.caseId, sha(JSON.stringify(labReviewResult(r)))]));
    const valid = new Map<string, LabReviewBody>();
    for (const [caseId, review] of latest) if (review.resultHash === hashes.get(caseId)) valid.set(caseId, LabReviewBodySchema.parse(review.body));
    return { run, results, latest, valid, hashes,
      candidates: candidates.map(c => viewCandidate(c, c.review, latest.get(c.review.caseId) ?? null, hashes.get(c.review.caseId)!)),
      exports: exports.map(e => ({ ...e, createdAt: e.createdAt.toISOString() })),
    };
  }
  return {
    async humanReview(actor: Actor, runId: string, caseId: string) {
      return db.$transaction(async tx => {
        await readableRun(tx, actor, runId);
        const result = await getResult(tx, runId, caseId);
        const resultHash = sha(JSON.stringify(labReviewResult(result)));
        const reviews = await tx.labHumanReview.findMany({ where: { runId, caseId }, orderBy: { revision: 'desc' } });
        const candidates = await tx.labTrainingCandidate.findMany({ where: { review: { runId, caseId } }, include: { review: true }, orderBy: { createdAt: 'desc' } });
        let effectiveSplit = null;
        let splitError = null;
        try { const plan = await familyPlan(tx, [result.testCase]); effectiveSplit = result.testCase.familyId ? plan[labFamilyKey(result.testCase.familyId)] ?? null : null; }
        catch (e) { splitError = e instanceof Error ? e.message : 'Split conflict'; }
        return { resultHash, reviews: reviews.map(viewReview), effectiveSplit, splitError,
          candidates: candidates.map(c => viewCandidate(c, c.review, reviews[0] ?? null, resultHash)) };
      }, { isolationLevel: 'RepeatableRead' });
    },
    async saveHumanReview(actor: Actor, runId: string, caseId: string, input: LabSaveReview) {
      return db.$transaction(async tx => {
        await lockRun(tx, actor, runId);
        const result = await getResult(tx, runId, caseId);
        if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(result.status)) throw conflict('실행 중인 결과는 검수할 수 없습니다.');
        if (sha(JSON.stringify(labReviewResult(result))) !== input.resultHash) throw conflict('결과가 변경되었습니다. 새로 불러와 검수하세요.');
        const previous = await currentReview(tx, runId, caseId);
        if ((previous?.id ?? null) !== input.previousReviewId) throw conflict('다른 검수 내용이 저장되었습니다. 새로 불러오세요.');
        if (input.body.verdict === 'correct' && (result.status !== 'SUCCEEDED' || !result.output || !result.jsonValid)) throw badRequest('유효한 성공 응답만 정답으로 평가할 수 있습니다.');
        if (new Set(input.body.sourceChecks.map(c => c.sourceId)).size !== input.body.sourceChecks.length ||
          input.body.sourceChecks.some(c => !result.output?.sourceIds.includes(c.sourceId))) throw badRequest('실제로 인용한 출처만 평가하세요.');
        return viewReview(await tx.labHumanReview.create({ data: { runId, caseId, actorId: actor.id,
          revision: (previous?.revision ?? 0) + 1, resultHash: input.resultHash, resultSnapshot: json(result), body: json(input.body) } }));
      });
    },
    async approveFeedback(actor: Actor, runId: string, input: LabApproveFeedback) {
      return db.$transaction(async tx => {
        await lockRun(tx, actor, runId);
        const s = await state(tx, actor, runId);
        guarded(() => labAssertPreferenceScope(labPreferenceScope(s.run), input.scope));
        const reviews = input.reviewIds.map(id => [...s.latest.values()].find(r => r.id === id));
        if (reviews.some(r => !r || !s.valid.has(r.caseId))) throw conflict('검수 또는 결과가 변경되었습니다. 다시 선택하세요.');
        const results = reviews.map(r => s.results.find(v => v.caseId === r!.caseId)!);
        const plan = await freezeLabFamilies(tx, results.map(r => r.testCase));
        const approved: LabCandidate[] = [];
        for (let i = 0; i < reviews.length; i++) {
          const review = reviews[i]!;
          const result = results[i]!;
          const body = guarded(() => labBuildPreference(result, LabReviewBodySchema.parse(review.body),
            plan[labFamilyKey(result.testCase.familyId ?? '')] ?? null, input.scope));
          const existing = s.candidates.find(c => c.reviewId === review.id && c.body.version === 'preference-v1' && c.status === 'approved' && !c.stale);
          if (existing) { approved.push(existing); continue; }
          const row = await tx.labTrainingCandidate.create({ data: { reviewId: review.id, actorId: actor.id,
            contentHash: sha(JSON.stringify(body)), body: json(body), status: 'approved',
            decisions: json([{ actorId: actor.id, at: new Date().toISOString(), decision: 'approved', grounded: true, familyVerified: true }]) } });
          approved.push(viewCandidate(row, review, review, s.hashes.get(review.caseId)!));
        }
        return approved;
      }, { timeout: 30_000 });
    },
    async curationOverview(actor: Actor, runId: string, threshold: number) {
      return db.$transaction(async tx => {
        const s = await state(tx, actor, runId);
        const scope = labPreferenceScope(s.run);
        let plan: Record<string, 'train' | 'validation' | 'test'> = {};
        let splitError: string | null = null;
        try { plan = await familyPlan(tx, s.results.map(r => r.testCase)); }
        catch (e) { splitError = e instanceof Error ? e.message : 'Split conflict'; }
        const feedback = [...s.latest.values()].map(row => {
          const result = s.results.find(r => r.caseId === row.caseId)!;
          const review = viewReview(row);
          let exclusion = splitError;
          try {
            if (!s.valid.has(row.caseId)) throw new Error('결과가 변경되었습니다. 재검수하세요.');
            labBuildPreference(result, review.body, plan[labFamilyKey(result.testCase.familyId ?? '')] ?? null, scope);
          } catch (e) { exclusion = e instanceof Error ? e.message : 'Invalid feedback'; }
          return { review, nickname: result.testCase.nickname, familyId: result.testCase.familyId ?? null,
            eligible: !exclusion, exclusion, candidateId: s.candidates.find(c => c.reviewId === review.id && c.body.version === 'preference-v1' && c.status === 'approved' && !c.stale)?.id ?? null };
        });
        return { scope, feedback, metrics: labHumanMetrics(s.results, s.valid, threshold, s.latest.size - s.valid.size), candidates: s.candidates, exports: s.exports };
      }, { isolationLevel: 'RepeatableRead' });
    },
    async createCurationExport(actor: Actor, runId: string, input: LabCurationExportRequest) {
      return db.$transaction(async tx => {
        await lockRun(tx, actor, runId);
        const s = await state(tx, actor, runId);
        guarded(() => labAssertPreferenceScope(labPreferenceScope(s.run), input.scope));
        const selectedIds = new Set(input.candidateIds);
        const selectedCases = new Set(s.candidates.filter(c => selectedIds.has(c.id)).map(c => c.caseId));
        const plan = await freezeLabFamilies(tx, s.results.filter(r => input.kind !== 'train' || selectedCases.has(r.caseId)).map(r => r.testCase));
        const id = randomUUID();
        const createdAt = new Date();
        const files: { filename: string; content: string }[] = [];
        let selection: unknown;
        let records: unknown[];
        if (input.kind === 'train') {
          const selected = input.candidateIds.map(id => s.candidates.find(c => c.id === id));
          if (new Set(input.candidateIds).size !== input.candidateIds.length || selected.some(c => !c)) throw badRequest('Invalid candidate selection');
          const candidates = selected as LabCandidate[];
          if (candidates.some(c => plan[c.body.familyId] !== 'train')) throw conflict('평가 전용 표현군은 학습에 포함할 수 없습니다.');
          selection = guarded(() => labValidateSelection(candidates, input.policy, input.scope));
          files.push({ filename: `nickname-preference-${id}.jsonl`, content: candidates.map(c => JSON.stringify(labTrainingLine(c))).join('\n') + '\n' });
          records = candidates.map(c => ({ candidate: c, review: viewReview(s.latest.get(c.caseId)!), originalResult: s.results.find(r => r.caseId === c.caseId) }));
        } else {
          if (input.candidateIds.length) throw badRequest('평가 파일에는 학습 피드백을 지정할 수 없습니다.');
          const selected = s.results.filter(r => r.testCase.familyId && plan[labFamilyKey(r.testCase.familyId)] === input.kind && s.valid.has(r.caseId));
          if (!selected.length) throw badRequest('이 split에 검수된 평가 사례가 없습니다.');
          // Gold remains the original reference, never a corrected training answer. Test has no candidate-generation route.
          records = selected.map(r => ({ ...labEvaluationLine(s.run, r, s.valid.get(r.caseId)!, input.kind), review: viewReview(s.latest.get(r.caseId)!) }));
          files.push({ filename: `nickname-${input.kind}-${id}.jsonl`, content: records.map(r => JSON.stringify(r)).join('\n') + '\n' });
          selection = { count: selected.length, evaluationOnly: true };
        }
        const manifest = { version: 'preference-v1', scope: input.scope, run: s.run, id, runId, datasetHash: s.run.datasetHash, model: s.run.model,
          promptHash: s.run.promptHash, evaluationProtocol: s.run.evaluationProtocol, actorId: actor.id, createdAt: createdAt.toISOString(),
          kind: input.kind, policy: input.policy, selection, familySplit: Object.fromEntries(s.results.filter(r => r.testCase.familyId).map(r => { const key = labFamilyKey(r.testCase.familyId!); return [key, plan[key]]; })),
          files: files.map(f => ({ filename: f.filename, sha256: sha(f.content) })), records };
        files.push({ filename: `nickname-provenance-${id}.json`, content: JSON.stringify(manifest, null, 2) });
        const row = await tx.labCurationExport.create({ data: { id, runId, actorId: actor.id, createdAt, kind: input.kind, files: json(files), manifest: json({ ...manifest, records: undefined, familySplit: undefined }) } });
        return LabCurationExportSchema.parse({ ...row, createdAt: createdAt.toISOString() });
      }, { timeout: 30_000 });
    },
    async curationExport(actor: Actor, runId: string, exportId: string) {
      await readableRun(db, actor, runId);
      const row = await db.labCurationExport.findFirst({ where: { id: exportId, runId } });
      if (!row) throw notFound('Export not found');
      return LabCurationExportSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
    },
  };
}
