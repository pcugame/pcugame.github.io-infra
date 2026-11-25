import type { LabReviewBundle, LabSaveReview, LabHumanReview, LabApproveFeedback, LabCandidate, LabCurationOverview, LabCurationExport, LabCurationExportRequest, LabUpload, LabSplitSchema, LabBetaUserSchema, LabCase, LabCreateRunSchema, LabDataset, LabResult, LabRun, LabStatus } from '@pcu/contracts';
import type { z } from 'zod';
import { api } from './client';

type Page<T> = { items: T[]; total: number };
export type LabBetaUser = z.infer<typeof LabBetaUserSchema>;
export type LabFormat = 'json' | 'jsonl' | 'csv';
export type LabSplit = z.infer<typeof LabSplitSchema>;
export type CompareEntry = { caseId: string; left: LabResult | null; right: LabResult | null };

function pageQuery(page: number, q: string, status?: string) {
  const query = new URLSearchParams({ page: String(page), q });
  if (status) query.set('status', status);
  return query;
}

const runPath = (id: string) => `/api/lab/runs/${encodeURIComponent(id)}`;
export const labApi = {
  review: (id: string, caseId: string) => api.get<LabReviewBundle>(`${runPath(id)}/results/${encodeURIComponent(caseId)}/review`),
  saveReview: (id: string, caseId: string, body: LabSaveReview) => api.post<LabHumanReview>(`${runPath(id)}/results/${encodeURIComponent(caseId)}/review`, body),
  approveFeedback: (id: string, body: LabApproveFeedback) => api.post<LabCandidate[]>(`${runPath(id)}/feedback/approve`, body),
  curation: (id: string, threshold = 50) => api.get<LabCurationOverview>(`${runPath(id)}/curation?threshold=${threshold}`),
  createCurationExport: (id: string, body: LabCurationExportRequest) => api.post<LabCurationExport>(`${runPath(id)}/curation/exports`, body),
  curationExport: (id: string, exportId: string) => api.get<LabCurationExport>(`${runPath(id)}/curation/exports/${encodeURIComponent(exportId)}`),
  status: () => api.get<LabStatus>('/api/lab/status'),
  datasets: (page = 1) => api.get<LabDataset[]>(`/api/lab/datasets?page=${page}`),
  upload: (input: LabUpload) => api.post<LabDataset>('/api/lab/datasets', input),
  cases: (id: string, page: number, q: string, split?: LabSplit) => api.get<Page<LabCase>>(`/api/lab/datasets/${encodeURIComponent(id)}/cases?${pageQuery(page, q)}${split ? `&split=${split}` : ''}`),
  runs: (page = 1) => api.get<LabRun[]>(`/api/lab/runs?page=${page}`),
  run: (id: string) => api.get<LabRun>(`/api/lab/runs/${encodeURIComponent(id)}`),
  create: (input: z.input<typeof LabCreateRunSchema>) => api.post<{ runId: string }>('/api/lab/runs', input),
  results: (id: string, page: number, q: string, status: string) => api.get<Page<LabResult>>(`/api/lab/runs/${encodeURIComponent(id)}/results?${pageQuery(page, q, status)}`),
  cancel: (id: string) => api.post<{ runId: string }>(`/api/lab/runs/${encodeURIComponent(id)}/cancel`),
  retryBertScore: (id: string) => api.post<{ runId: string }>(`${runPath(id)}/bertscore/retry`),
  retry: (id: string) => api.post<{ runId: string }>(`/api/lab/runs/${encodeURIComponent(id)}/retry`),
  compare: (left: string, right: string, page: number, q: string) =>
    api.get<Page<CompareEntry>>(`/api/lab/compare?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}&${pageQuery(page, q)}`),
  export: (id: string, format: LabFormat, threshold = 50) =>
    api.get<{ filename: string; content: string }>(`/api/lab/runs/${encodeURIComponent(id)}/export?format=${format}&threshold=${threshold}`),
  betaUsers: (q: string, page = 1) => api.get<{ items: LabBetaUser[] }>(`/api/lab/beta-users?q=${encodeURIComponent(q)}&page=${page}`),
  changeBeta: (id: number, role: 'USER' | 'BETA_TESTER') => api.patch<LabBetaUser>(`/api/lab/beta-users/${id}`, { role }),
};
