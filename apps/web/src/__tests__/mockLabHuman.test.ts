import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { labDefaultReview, LabCurationPolicySchema } from '@pcu/contracts';
import { labApi } from '../lib/api/lab';
import { forgetMockCacheForTests, resetMockState, selectMockUser } from '../lib/api/mock/transport';

beforeEach(async () => { vi.stubEnv('VITE_MOCK', 'true'); vi.useFakeTimers({ toFake: ['Date'] }); await resetMockState(); await selectMockUser('BETA_TESTER'); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
describe('persistent mock human review workflow', () => {
  it('persists reviews, approval and representative exports across reload; keeps test separate', async () => {
    const cases = ['normal', 'ambiguous', 'test'].map((id, i) => ({ id, nickname: `닉네임${i}`, familyId: id, split: id === 'test' ? 'test' : 'train', reference: { expectedReason: '검토 가설', expectedScore: 0 } }));
    const dataset = await labApi.upload({ name: 'human', format: 'jsonl', content: cases.map(c => JSON.stringify(c)).join('\n') });
    const { runId } = await labApi.create({ datasetId: dataset.id, size: 3, finalTest: true, model: 'mock-nickname-evaluation', searchMode: 'no_search', temperature: 0, maxTokens: 512 });
    vi.setSystemTime(Date.now() + 3000);
    const results = await labApi.results(runId, 1, '', '');
    expect((await labApi.curation(runId)).candidates).toEqual([]);
    const selected: string[] = [];
    const scope = (await labApi.curation(runId)).scope!;
    for (const result of results.items) {
      const bundle = await labApi.review(runId, result.caseId);
      const review = await labApi.saveReview(runId, result.caseId, { previousReviewId: null, resultHash: bundle.resultHash,
        body: { ...labDefaultReview(result), verdict: result.caseId === 'ambiguous' ? 'incorrect' : 'correct', behavior: result.caseId === 'ambiguous' ? 'negative' : 'positive', behaviorReasons: result.caseId === 'ambiguous' ? ['excessive_risk'] : [] } });
      if (result.caseId === 'test') { await expect(labApi.approveFeedback(runId, { reviewIds: [review.id], scope })).rejects.toMatchObject({ status: 400 }); continue; }
      const [candidate] = await labApi.approveFeedback(runId, { reviewIds: [review.id], scope });
      selected.push(candidate.id);
    }
    await forgetMockCacheForTests();
    expect((await labApi.curation(runId)).metrics.reviewed).toBe(3);
    const file = await labApi.createCurationExport(runId, { scope, kind: 'train', candidateIds: selected, approved: true, policy: LabCurationPolicySchema.parse({}) });
    expect(file.files[0].content.trim().split('\n')).toHaveLength(2);
    expect(file.manifest.mock).toBe(true);
    const lines = file.files[0].content.trim().split('\n').map(line => JSON.parse(line));
    expect(lines.map(line => line.label)).toEqual([true, false]);
    expect(lines[0].completion[0].content).toContain('합성 판단');
    await forgetMockCacheForTests();
    expect((await labApi.curationExport(runId, file.id)).files).toEqual(file.files);
    const test = await labApi.createCurationExport(runId, { scope, kind: 'test', candidateIds: [], approved: true, policy: LabCurationPolicySchema.parse({}) });
    expect(test.files[0].content).toContain('evaluation_only');
    expect(JSON.parse(test.files[0].content).messages).toBeUndefined();
  });
});
