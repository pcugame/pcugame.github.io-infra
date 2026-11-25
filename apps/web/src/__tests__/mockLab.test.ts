import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAB_NICKNAME_SYSTEM_PROMPT, LabResultSchema, LabRunSchema, type LabCase, type LabRun } from '@pcu/contracts';
import { labApi } from '../lib/api/lab';
import { api } from '../lib/api/client';
import { forgetMockCacheForTests, getMockState, resetMockState, selectMockUser, setMockControls, updateMockState } from '../lib/api/mock/transport';
import { submissionMode } from '../lib/auth/roles';

const jsonl = Array.from({ length: 57 }, (_, index) => JSON.stringify({
 id: `case-${index}`, nickname: `${index >= 50 ? '모호' : '가상'}닉네임${index}`,
 reference: { expectedReason: `가설 ${index}`, expectedScore: 50, sources: [] }, tags: [],
} satisfies LabCase)).join('\n');
const upload = (name: string, content: string) => labApi.upload({ name, format: 'jsonl', content });
const settings = {
 model: 'mock-nickname-evaluation', size: 1, temperature: 0.2, maxTokens: 512,
 searchMode: 'model_tool_call',
} as const;
function advance(ms: number) { vi.setSystemTime(Date.now() + ms); }

beforeEach(async () => {
  vi.stubEnv('VITE_MOCK', 'true');
  vi.useFakeTimers({ toFake: ['Date'] });
  await resetMockState();
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('nickname evaluation lab mock HTTP boundary', () => {
  it('keeps staff and lab permissions independent across role changes', async () => {
    for (const [selection, status] of [['anonymous', 401], ['OPERATOR', 403], ['owner', 403]] as const) {
      await selectMockUser(selection);
      await expect(labApi.status()).rejects.toMatchObject({ status });
      await expect(labApi.betaUsers('')).rejects.toMatchObject({ status });
    }
    await selectMockUser('ADMIN');
    expect((await labApi.betaUsers('2088099')).items).toMatchObject([{ id: 3, role: 'USER' }]);
    await expect(labApi.changeBeta(1, 'USER')).rejects.toMatchObject({ status: 404 });
    await expect(labApi.changeBeta(2, 'BETA_TESTER')).rejects.toMatchObject({ status: 404 });
    await expect(api.patch('/api/lab/beta-users/3', { role: 'ADMIN' })).rejects.toMatchObject({ status: 400 });
    await labApi.changeBeta(3, 'BETA_TESTER');
    await selectMockUser('owner');
    expect(await api.get('/api/me')).toMatchObject({ user: { id: 3, role: 'BETA_TESTER' } });
    expect(submissionMode('BETA_TESTER')).toBe('user');
    expect(await api.get('/api/admin/projects/1')).toMatchObject({ id: 1 });
    await expect(api.get('/api/admin/settings')).rejects.toMatchObject({ status: 403 });
    await expect(labApi.changeBeta(3, 'USER')).rejects.toMatchObject({ status: 403 });
    expect(await labApi.status()).toMatchObject({ mock: true });
    await selectMockUser('ADMIN'); await labApi.changeBeta(3, 'USER');
    await selectMockUser('owner');
    await expect(labApi.runs()).rejects.toMatchObject({ status: 403 });
    expect(getMockState()?.lab?.audits).toMatchObject([
      { actorId: 1, targetId: 3, beforeRole: 'USER', afterRole: 'BETA_TESTER' },
      { actorId: 1, targetId: 3, beforeRole: 'BETA_TESTER', afterRole: 'USER' },
    ]);
  });

  it('persists full runs, null scores, aligned comparisons, exports and owner scoping', async () => {
    await selectMockUser('BETA_TESTER');
    await expect(upload('bad', '{}')).rejects.toMatchObject({ status: 400 });
    const d = await upload('test.jsonl', jsonl);
    expect(await upload('duplicate.jsonl', jsonl)).toEqual(d);
    expect((await labApi.cases(d.id, 2, '')).items[0].id).toBe('case-25');
    const runs: LabRun[] = [];
    for (const size of [1, 10, 57] as const) {
      const { runId } = await labApi.create({ ...settings, datasetId: d.id, size });
      advance(50000);
      const run = LabRunSchema.parse(await labApi.run(runId));
      expect(run).toMatchObject({ provider: 'mock', status: 'COMPLETED', success: size, systemPrompt: LAB_NICKNAME_SYSTEM_PROMPT });
      runs.push(run);
    }
    await forgetMockCacheForTests();
    const last = runs[2];
    expect(last.stats).toMatchObject({ scored: 50, abstained: 7 });
    const rows = await labApi.results(last.id, 3, '', 'SUCCEEDED');
    expect(rows.total).toBe(57);
    expect(LabResultSchema.parse(rows.items[6])).toMatchObject({
      caseId: 'case-56', jsonValid: true, toolSucceeded: true, output: { score: null, abstained: true, sourceIds: [] },
    });
    const compare = await labApi.compare(runs[0].id, last.id, 1, 'case-0');
    expect(compare.items[0]).toMatchObject({ caseId: 'case-0', left: { caseId: 'case-0' }, right: { caseId: 'case-0' } });
    expect(JSON.parse((await labApi.export(last.id, 'json')).content).results).toHaveLength(57);
    expect((await labApi.export(runs[1].id, 'jsonl')).content.trimEnd().split('\n')).toHaveLength(10);
    expect((await labApi.export(last.id, 'csv')).content).toContain('score,confidence,durationMs');
    await selectMockUser('ADMIN');
    expect(await labApi.run(last.id)).toMatchObject({ id: last.id });
    await labApi.changeBeta(3, 'BETA_TESTER'); await selectMockUser('owner');
    expect(await labApi.datasets()).toEqual([]); expect(await labApi.runs()).toEqual([]);
    for (const request of [() => labApi.export(last.id, 'json'), () => labApi.results(last.id, 1, '', ''),
      () => labApi.compare(runs[1].id, last.id, 1, ''), () => labApi.cases(d.id, 1, ''), () => labApi.cancel(last.id)]) {
      await expect(request()).rejects.toMatchObject({ status: 404 });
    }
  });

  it('keeps older datasets and runs reachable beyond the first 25 entries', async () => {
    await selectMockUser('BETA_TESTER');
    const original = await upload('original.jsonl', jsonl);
    const { runId } = await labApi.create({ ...settings, datasetId: original.id });
    await updateMockState(state => {
      const lab = state.lab!;
      for (let i = 0; i < 25; i++) {
        const d = crypto.randomUUID();
        lab.datasets.unshift({ ownerId: 7, cases: [], info: { ...original, id: d } });
        lab.runs.unshift({ ...lab.runs[0], rows: [], info: { ...lab.runs[0].info, id: crypto.randomUUID(), datasetId: d, status: 'COMPLETED' } });
      }
    });
    expect(await labApi.datasets()).toHaveLength(25);
    expect(await labApi.datasets(2)).toMatchObject([{ id: original.id }]);
    expect(await labApi.runs()).toHaveLength(25);
    expect(await labApi.runs(2)).toMatchObject([{ id: runId }]);
  });

  it('resumes selected cases after a failed attempt and preserves partial results on cancellation', async () => {
    await selectMockUser('BETA_TESTER');
    const d = await upload('retry.jsonl', jsonl);
    const { runId } = await labApi.create({ ...settings, datasetId: d.id, caseIds: ['case-30'] });
    await setMockControls({ worker: 'fail' }); advance(2000);
    expect(await labApi.run(runId)).toMatchObject({ failed: 1 });
    await setMockControls({ worker: 'auto' }); await labApi.retry(runId); advance(2000);
    const result = await labApi.results(runId, 1, '', '');
    expect(result.items[0]).toMatchObject({ caseId: 'case-30', attempts: 2, status: 'SUCCEEDED', history: [{ status: 'FAILED' }, { status: 'SUCCEEDED' }] });
    const other = await labApi.create({ ...settings, datasetId: d.id, size: 10 });
    advance(310); await labApi.cancel(other.runId); advance(60000);
    expect(await labApi.run(other.runId)).toMatchObject({ status: 'CANCELLED', success: 1, cancelled: 9 });
  });
});


it('imports nickname references and CSV, preserves custom instructions and split selection across reload', async () => {
 await selectMockUser('BETA_TESTER');
 const content = 'nickname,expectedReason,expectedScore,split\r\n가상하나,검증할 가설,70,train\r\n가상둘,일반적인 해석,0,test\r\n';
 const dataset = await labApi.upload({ name: 'human.csv', format: 'csv', content });
 expect(dataset).toMatchObject({ schemaVersion: '3', count: 2 });
 expect((await labApi.cases(dataset.id, 1, '', 'test')).items).toMatchObject([{ nickname: '가상둘', reference: { expectedScore: 0 } }]);
 expect((await labApi.cases(dataset.id, 1, '', 'validation')).total).toBe(0);
 await expect(api.post('/api/lab/runs', { ...settings, datasetId: dataset.id, systemPrompt: null })).rejects.toMatchObject({ status: 400 });
 const prompts = { systemPrompt: ' 사용자 지침\n ', actionPrompt: '', answerPrompt: '답변 기준' };
 const fixed = { ...settings, ...prompts, datasetId: dataset.id };
 await expect(labApi.create({ ...fixed, split: 'test', caseIds: ['nick-0001'] })).rejects.toMatchObject({ status: 400 });
 await expect(labApi.create({ ...fixed, size: 3 })).rejects.toMatchObject({ status: 400 });
 const { runId } = await labApi.create({ ...fixed, split: 'test', finalTest: true, caseIds: ['nick-0002'] });
 advance(2000);
 const run = LabRunSchema.parse(await labApi.run(runId));
 expect(run).toMatchObject({ success: 1, evaluationProtocol: 'nickname-risk-v1', split: 'test' });
 await forgetMockCacheForTests();
 expect(await labApi.run(runId)).toMatchObject(prompts);
 const result = LabResultSchema.parse((await labApi.results(runId, 1, '', '')).items[0]);
 expect(result).toMatchObject({ caseId: 'nick-0002', testCase: { reference: { expectedScore: 0 } }, output: { schemaVersion: '2', nickname: '가상둘' } });
 expect(JSON.parse((await labApi.export(runId, 'jsonl')).content)).toMatchObject({ schemaVersion: '3', evaluationProtocol: 'nickname-risk-v1', sources: [] });
 const otherDataset = await upload('other snapshot', jsonl);
 const other = await labApi.create({ ...settings, datasetId: otherDataset.id });
 await expect(labApi.compare(runId, other.runId, 1, '')).rejects.toMatchObject({ status: 400 });
});
