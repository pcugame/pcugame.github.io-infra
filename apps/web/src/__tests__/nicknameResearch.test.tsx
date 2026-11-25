// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LabResultSchema, LAB_RESEARCH_SYSTEM_PROMPT } from '@pcu/contracts';
import { ResultDetail } from '../features/nickname-evaluation/ResultDetail';
import { RunEditor } from '../features/nickname-evaluation/RunEditor';

vi.mock('../lib/api/lab', () => ({ labApi: { datasets: async () => [] } }));
vi.mock('../lib/query/visibility', () => ({ useViewerKey: () => (key: unknown[]) => key }));
afterEach(cleanup);

describe('nickname research presentation', () => {
  it('enables JSON actions independently of native tools and displays the actual research policy', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><RunEditor status={{ enabled: true, model: 'Qwen3-4B',
      provider: 'transformers-generate', modelStatus: 'available', searchStatus: 'available', toolSupport: 'unsupported',
      agenticRetrieval: true, mock: false, generationLimits: { fixedTemperature: 0, maxInputTokens: 2048, maxOutputTokens: 768 },
    }} onCreated={() => {}} /></QueryClientProvider>);
    const option = await screen.findByRole('option', { name: '모델이 검색하며 분석' });
    expect((option as HTMLOptionElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('검색 모드'), { target: { value: 'agentic_retrieval' } });
    expect((screen.getByLabelText('검색 모드') as HTMLSelectElement).value).toBe('agentic_retrieval');
    expect((screen.getByLabelText('고정 평가 지침') as HTMLTextAreaElement).value).toBe(LAB_RESEARCH_SYSTEM_PROMPT);
    client.clear();
  });
  it('shows hypotheses, model queries, tokens and snippet-only evidence without rendering web instructions as HTML', () => {
    const item = LabResultSchema.parse({ caseId: 'single', testCase: { id: 'single', nickname: '가상',
      reference: { expectedReason: '검토 가설', expectedScore: 50 } }, status: 'SUCCEEDED',
      output: { schemaVersion: '2', nickname: '가상', interpretedTerm: null, reason: '자료 부족', score: null, confidence: 0.1, sourceIds: ['S1'], abstained: true },
      sources: [{ id: 'S1', title: '수집 자료', snippet: '<script>alert(1)</script>', url: 'https://example.org/evidence', collectedAt: '2026-11-25T00:00:00Z' }],
      durationMs: 100, searchCount: 1, jsonValid: true, error: null, attempts: 1, toolSucceeded: true, toolSupport: 'unsupported',
      history: [{ research: { limitations: ['SEARCH_SNIPPETS_ONLY_ORIGINAL_PAGES_NOT_FETCHED'], inputTokens: 500, outputTokens: 100,
        steps: [{ kind: 'action', prompt: '실제 모델 입력', suppliedSources: [], durationMs: 10, inputTokens: 500, outputTokens: 100, action: { action: 'search', query: '모델이 만든 검색어', hypotheses: [{ term: '가능한 독법', basis: '해석 가설' }] } },
          { kind: 'search', query: '모델이 만든 검색어', durationMs: 20 }] } }],
    });
    const { container } = render(<ResultDetail item={item} />);
    expect(screen.getByText('검색: 모델이 만든 검색어')).toBeTruthy();
    expect(screen.getByText('해석 가설: 가능한 독법 · 해석 가설')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'S1 · 수집 자료' }).getAttribute('href')).toBe('https://example.org/evidence');
    expect(screen.getAllByText(/원문 미검증/).length).toBeGreaterThan(0);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toContain('실제 모델 입력');
    expect(container.querySelector('pre')?.textContent).toContain('suppliedSources');
  });
});
