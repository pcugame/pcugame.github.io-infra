// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { LabResultSchema, LabRunSchema, labBertScoreSummary, labHumanMetrics, labPromptSettings } from '@pcu/contracts';
import { RunResults } from '../features/nickname-evaluation/RunResults';
import { labApi } from '../lib/api/lab';

vi.mock('../lib/query/visibility', () => ({ useViewerKey: () => (key: unknown[]) => key }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('keeps an unsaved blind review mounted while BERTScore completes, without leaking case or aggregate scores', async () => {
  const id = '51512681-b19c-4da7-8e98-955e17dd938c';
  const at = '2026-11-25T00:00:00Z';
  const item = LabResultSchema.parse({ caseId: 'one', testCase: { id: 'one', nickname: '달빛산책',
    reference: { expectedReason: 'REFERENCE', expectedScore: 0 } }, status: 'SUCCEEDED',
    output: { schemaVersion: '2', nickname: '달빛산책', interpretedTerm: null, reason: 'MODEL', score: 0, confidence: 1, sourceIds: [], abstained: false },
    sources: [], history: [], durationMs: 10, searchCount: 0, jsonValid: true, error: null, attempts: 1, toolSucceeded: false, toolSupport: 'unknown',
    bertScore: { status: 'PENDING', precision: null, recall: null, f1: null, reason: null, attempts: 0, inputHash: '', identity: null, completedAt: null } });
  const run = LabRunSchema.parse({ id, datasetId: id, datasetHash: 'd'.repeat(64), datasetVersion: '3', schemaVersion: '3',
    evaluationProtocol: 'nickname-risk-v1', ...labPromptSettings(), promptHash: 'p'.repeat(64), model: 'test', provider: 'test',
    searchMode: 'no_search', temperature: 0, maxTokens: 256, size: 1, status: 'COMPLETED', createdAt: at, startedAt: at,
    completedAt: at, success: 1, failed: 0, cancelled: 0, stats: { meanScore: 0, scored: 1, abstained: 0 }, bertScore: labBertScoreSummary([item]) });
  vi.spyOn(labApi, 'run').mockResolvedValue(run);
  const rows = vi.spyOn(labApi, 'results').mockResolvedValue({ items: [item], total: 1 });
  vi.spyOn(labApi, 'review').mockResolvedValue({ resultHash: 'a'.repeat(64), reviews: [], candidates: [], effectiveSplit: null, splitError: null });
  vi.spyOn(labApi, 'curation').mockResolvedValue({ metrics: labHumanMetrics([item], new Map()), candidates: [], exports: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><RunResults id={id} /></QueryClientProvider>);
  const notes = await screen.findByLabelText<HTMLTextAreaElement>('검수 메모');
  fireEvent.change(notes, { target: { value: '저장 전 메모' } });
  let resolve!: (value: { items: typeof item[]; total: number }) => void;
  rows.mockImplementation(() => new Promise(done => { resolve = done; }));
  const scored = { ...item, bertScore: { ...item.bertScore!, status: 'SUCCEEDED' as const, precision: 0.8765, recall: 0.7654, f1: 0.8192, completedAt: at } };
  const calls = rows.mock.calls.length;
  act(() => { client.setQueryData(['lab-run', id], { ...run, bertScore: labBertScoreSummary([scored]) }); });
  await waitFor(() => expect(rows.mock.calls.length).toBeGreaterThan(calls));
  expect(screen.getByLabelText('검수 메모')).toBe(notes);
  expect(notes.value).toBe('저장 전 메모');
  await act(async () => { resolve({ items: [scored], total: 1 }); });
  expect(screen.getByLabelText('검수 메모')).toBe(notes);
  expect(screen.queryByText(/0.8765/)).toBeNull();
  expect(screen.queryByText('REFERENCE')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '기대 정답 공개' }));
  expect(await screen.findByText('P 0.8765 / R 0.7654 / F1 0.8192')).toBeTruthy();
  expect(screen.getByLabelText('검수 메모')).toBe(notes);
  expect(notes.value).toBe('저장 전 메모');
  client.clear();
});
