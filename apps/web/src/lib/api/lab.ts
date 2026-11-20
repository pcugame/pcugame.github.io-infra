import type { LabBetaUserSchema, LabCase, LabCreateRun, LabDataset, LabResult, LabRun, LabStatus } from '@pcu/contracts';
import type { z } from 'zod';
import { api } from './client';

type Page<T> = { items: T[]; total: number };
export type LabBetaUser = z.infer<typeof LabBetaUserSchema>;
export type LabFormat = 'json' | 'jsonl' | 'csv';
export type RunSize = 1 | 10 | 50 | 500;
export type CompareEntry = { caseId: string; left: LabResult | null; right: LabResult | null };

function pageQuery(page: number, q: string, status?: string) {
  const query = new URLSearchParams({ page: String(page), q });
  if (status) query.set('status', status);
  return query;
}

export const labApi = {
  status: () => api.get<LabStatus>('/api/lab/status'),
  datasets: (page = 1) => api.get<LabDataset[]>(`/api/lab/datasets?page=${page}`),
  upload: (name: string, jsonl: string) => api.post<LabDataset>('/api/lab/datasets', { name, jsonl }),
  cases: (id: string, page: number, q: string) => api.get<Page<LabCase>>(`/api/lab/datasets/${encodeURIComponent(id)}/cases?${pageQuery(page, q)}`),
  runs: (page = 1) => api.get<LabRun[]>(`/api/lab/runs?page=${page}`),
  run: (id: string) => api.get<LabRun>(`/api/lab/runs/${encodeURIComponent(id)}`),
  create: (input: LabCreateRun) => api.post<{ runId: string }>('/api/lab/runs', input),
  results: (id: string, page: number, q: string, status: string) => api.get<Page<LabResult>>(`/api/lab/runs/${encodeURIComponent(id)}/results?${pageQuery(page, q, status)}`),
  cancel: (id: string) => api.post<{ runId: string }>(`/api/lab/runs/${encodeURIComponent(id)}/cancel`),
  retry: (id: string) => api.post<{ runId: string }>(`/api/lab/runs/${encodeURIComponent(id)}/retry`),
  compare: (left: string, right: string, page: number, q: string) =>
    api.get<Page<CompareEntry>>(`/api/lab/compare?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}&${pageQuery(page, q)}`),
  export: (id: string, format: LabFormat) =>
    api.get<{ filename: string; content: string }>(`/api/lab/runs/${encodeURIComponent(id)}/export?format=${format}`),
  betaUsers: (q: string, page = 1) => api.get<{ items: LabBetaUser[] }>(`/api/lab/beta-users?q=${encodeURIComponent(q)}&page=${page}`),
  changeBeta: (id: number, role: 'USER' | 'BETA_TESTER') => api.patch<LabBetaUser>(`/api/lab/beta-users/${id}`, { role }),
};
