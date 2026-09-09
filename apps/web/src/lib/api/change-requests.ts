import type {
  CreateProjectChangeRequest,
  ProjectChangeDetail,
  ProjectChangeKind,
  ProjectChangeListResponse,
  ProjectChangeState,
  ProjectChangeValues,
  UpdateProjectChangeRequest,
} from '@pcu/contracts';
import { api } from './client';

export const changeRequestApi = {
  listMine({ offset = 0, limit = 20 }: { offset?: number; limit?: number } = {}) {
    return api.get<ProjectChangeListResponse>(`/api/me/change-requests?offset=${offset}&limit=${limit}`);
  },
  listForProject(projectId: number) {
    return api.get<ProjectChangeListResponse>(`/api/me/projects/${projectId}/change-requests`);
  },
  create(projectId: number, body: CreateProjectChangeRequest) {
    return api.post<ProjectChangeDetail>(`/api/me/projects/${projectId}/change-requests`, body);
  },
  get(id: string) {
    return api.get<ProjectChangeDetail>(`/api/me/change-requests/${id}`);
  },
  update(id: string, body: UpdateProjectChangeRequest) {
    return api.patch<ProjectChangeDetail>(`/api/me/change-requests/${id}`, body);
  },
  submit(id: string) {
    return api.post<ProjectChangeDetail>(`/api/me/change-requests/${id}/submit`);
  },
  cancel(id: string) {
    return api.post<ProjectChangeDetail>(`/api/me/change-requests/${id}/cancel`);
  },
};

export const adminChangeRequestApi = {
  list({ state = 'PENDING', offset = 0, limit = 50 }: { state?: ProjectChangeState; offset?: number; limit?: number } = {}) {
    return api.get<ProjectChangeListResponse>(`/api/admin/change-requests?state=${state}&offset=${offset}&limit=${limit}`);
  },
  get(id: string) {
    return api.get<ProjectChangeDetail>(`/api/admin/change-requests/${id}`);
  },
  approve(id: string) {
    return api.post<ProjectChangeDetail>(`/api/admin/change-requests/${id}/approve`);
  },
  reject(id: string, reason: string) {
    return api.post<ProjectChangeDetail>(`/api/admin/change-requests/${id}/reject`, { reason });
  },
  retry(id: string) {
    return api.post<ProjectChangeDetail>(`/api/admin/change-requests/${id}/retry`);
  },
};

export type { ProjectChangeKind as ChangeRequestKind, ProjectChangeValues as ChangeRequestChanges };
