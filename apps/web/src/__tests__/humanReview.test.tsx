// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LabResultSchema, labDefaultReview, type LabReviewBundle, type LabHumanReview } from '@pcu/contracts';
import { HumanReview } from '../features/nickname-evaluation/HumanReview';
import { labApi } from '../lib/api/lab';

vi.mock('../lib/api/lab', () => ({ labApi: { review: vi.fn(), saveReview: vi.fn(), candidate: vi.fn() } }));
vi.mock('../lib/query/visibility', () => ({ useViewerKey: () => (key: unknown[]) => key }));
afterEach(cleanup);
const item = LabResultSchema.parse({ caseId: 'one', testCase: { id: 'one', nickname: '달빛산책', familyId: 'moon', split: 'train', reference: { expectedReason: 'SECRET_EXPECTED_REASON', expectedScore: 0 } },
  status: 'SUCCEEDED', output: { schemaVersion: '2', nickname: '달빛산책', interpretedTerm: null, reason: 'MODEL_REASON', score: 80, confidence: 0.6, sourceIds: [], abstained: false },
  sources: [], history: [], durationMs: 10, searchCount: 0, jsonValid: true, error: null, attempts: 1, toolSucceeded: false, toolSupport: 'unknown' });
let bundle: LabReviewBundle;
beforeEach(() => {
  vi.clearAllMocks();
  bundle = { resultHash: 'a'.repeat(64), reviews: [], candidates: [], effectiveSplit: 'train', splitError: null };
  vi.mocked(labApi.review).mockImplementation(async () => structuredClone(bundle));
  vi.mocked(labApi.saveReview).mockImplementation(async (runId, caseId, input) => {
    const review: LabHumanReview = { id: '00000000-0000-4000-8000-000000000002', runId, caseId, revision: 1, actorId: 1, createdAt: '2026-11-25T00:00:00Z', resultHash: input.resultHash, body: input.body };
    bundle.reviews = [review]; return review;
  });
});
function mount(next = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><HumanReview runId="00000000-0000-4000-8000-000000000001" item={item} next={next} /></QueryClientProvider>);
  return { ...view, next, client };
}
describe('human review UI', () => {
  it('hides the reference, supports keyboard verdict and saves blind judgment before advancing', async () => {
    const { next, client } = mount();
    await screen.findByText('MODEL_REASON', { selector: 'dd' });
    expect(screen.queryByText('SECRET_EXPECTED_REASON')).toBeNull();
    fireEvent.keyDown(window, { key: '1' });
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(next).toHaveBeenCalledOnce());
    expect(vi.mocked(labApi.saveReview).mock.calls[0][2].body).toMatchObject({ verdict: 'correct', blind: true, correction: {} });
    expect(labApi.candidate).not.toHaveBeenCalled();
    client.clear();
  });
  it('records multiple errors and reuses expected fields selectively without changing the original', async () => {
    const { client } = mount();
    await screen.findByText('MODEL_REASON', { selector: 'dd' });
    fireEvent.click(screen.getByRole('button', { name: '3 오답' }));
    fireEvent.click(screen.getByLabelText('부적절한 점수'));
    fireEvent.click(screen.getByLabelText('과도한 위험 판단·오탐'));
    fireEvent.click(screen.getByText('필요한 부분만 교정'));
    fireEvent.click(screen.getByRole('button', { name: '기대 근거·점수로 교정 초안 채우기' }));
    expect(screen.getByText('SECRET_EXPECTED_REASON', { selector: 'dd' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /검수 저장/ }));
    await waitFor(() => expect(labApi.saveReview).toHaveBeenCalled());
    expect(vi.mocked(labApi.saveReview).mock.calls[0][2].body).toMatchObject({ verdict: 'incorrect', errors: ['score', 'false_positive'], blind: false, reusedReference: true,
      correction: { reason: 'SECRET_EXPECTED_REASON', score: 0, abstained: false } });
    expect(item.output!.reason).toBe('MODEL_REASON');
    expect(item.output!.score).toBe(80);
    client.clear();
  });
  it('does not interpret typing as shortcuts and blocks candidate generation for held-out data', async () => {
    bundle.effectiveSplit = 'test';
    bundle.reviews = [{ id: '00000000-0000-4000-8000-000000000002', runId: '00000000-0000-4000-8000-000000000001', caseId: 'one', actorId: 1,
      revision: 1, resultHash: bundle.resultHash, createdAt: '2026-11-25T00:00:00Z', body: { ...labDefaultReview(item), verdict: 'correct', cause: 'none' } }];
    const { next, client } = mount();
    const memo = await screen.findByLabelText('검수 메모');
    fireEvent.keyDown(memo, { key: '3' });
    expect(screen.getByRole('button', { name: '1 정답' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByRole('button', { name: '검수 내용으로 후보 생성 (미승인)' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(memo, { target: { value: '저장 전 내용' } });
    fireEvent.keyDown(window, { key: 'j' });
    expect(next).not.toHaveBeenCalled();
    client.clear();
  });
});
