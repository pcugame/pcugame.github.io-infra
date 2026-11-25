// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LabResultSchema, labDefaultReview, type LabReviewBundle, type LabHumanReview } from '@pcu/contracts';
import { HumanReview } from '../features/nickname-evaluation/HumanReview';
import { labApi } from '../lib/api/lab';

vi.mock('../lib/api/lab', () => ({ labApi: { review: vi.fn(), saveReview: vi.fn(), approveFeedback: vi.fn() } }));
vi.mock('../lib/query/visibility', () => ({ useViewerKey: () => (key: unknown[]) => key }));
afterEach(cleanup);
const item = LabResultSchema.parse({ bertScore: { status: 'SUCCEEDED', precision: 0.8765, recall: 0.7654, f1: 0.8192,
  reason: null, attempts: 1, inputHash: 'a'.repeat(64), identity: null, completedAt: '2026-11-25T00:00:00Z' }, caseId: 'one', testCase: { id: 'one', nickname: '달빛산책', familyId: 'moon', split: 'train', reference: { expectedReason: 'SECRET_EXPECTED_REASON', expectedScore: 0 } },
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
    await screen.findAllByText('MODEL_REASON', { selector: 'dd' });
    expect(screen.queryByText('SECRET_EXPECTED_REASON')).toBeNull();
    expect(screen.queryByText(/0.8765/)).toBeNull();
    fireEvent.keyDown(window, { key: '1' });
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(next).toHaveBeenCalledOnce());
    expect(vi.mocked(labApi.saveReview).mock.calls[0][2].body).toMatchObject({ verdict: 'correct', blind: true, correction: {} });
    expect(labApi.approveFeedback).not.toHaveBeenCalled();
    client.clear();
  });
  it('keeps verdict independent from negative feedback and never requires a corrected response', async () => {
    const { client } = mount();
    await screen.findAllByText('MODEL_REASON', { selector: 'dd' });
    fireEvent.click(screen.getByRole('button', { name: '3 오답' }));
    expect(screen.getByRole('button', { name: 'D 학습 제외' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(window, { key: 's' });
    fireEvent.click(screen.getByLabelText('근거 없는 사실 생성'));
    fireEvent.click(screen.getByRole('button', { name: '1 정답' }));
    expect(screen.getByRole('button', { name: 'S 부정' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '기대 정답 공개' }));
    fireEvent.click(screen.getByRole('button', { name: /검수 저장/ }));
    await waitFor(() => expect(labApi.saveReview).toHaveBeenCalled());
    expect(vi.mocked(labApi.saveReview).mock.calls[0][2].body).toMatchObject({ verdict: 'correct', behavior: 'negative',
      behaviorReasons: ['fabricated_fact'], blind: false, correction: {}, reusedReference: false });
    expect(screen.queryByText('필요한 부분만 교정')).toBeNull();
    expect(item.output!.reason).toBe('MODEL_REASON');
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
    expect(screen.queryByRole('button', { name: '검수 내용으로 후보 생성 (미승인)' })).toBeNull();
    fireEvent.change(memo, { target: { value: '저장 전 내용' } });
    fireEvent.keyDown(window, { key: 'j' });
    expect(next).not.toHaveBeenCalled();
    client.clear();
  });
});
