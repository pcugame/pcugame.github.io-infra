// ── Admin API 호출 ───────────────────────────────────────────

import type {
  CreateYearRequest,
  UpdateYearRequest,
  AdminYearItem,
  UpdateProjectRequest,
  AdminProjectItem,
  AdminProjectDetail,
  SubmitProjectResponse,
  AddMemberRequest,
  UpdateMemberRequest,
} from '../../contracts';
import { api } from './client';

// ── Year ─────────────────────────────────────────────────────

export const adminYearApi = {
  list() {
    return api.get<{ items: AdminYearItem[] }>('/api/admin/years');
  },

  create(body: CreateYearRequest) {
    return api.post<{ id: string; year: number }>('/api/admin/years', body);
  },

  update(id: string, body: UpdateYearRequest) {
    return api.patch<AdminYearItem>(`/api/admin/years/${id}`, body);
  },
};

// ── Project ──────────────────────────────────────────────────

export const adminProjectApi = {
  list() {
    return api.get<{ items: AdminProjectItem[] }>('/api/admin/projects');
  },

  getDetail(id: string) {
    return api.get<AdminProjectDetail>(`/api/admin/projects/${id}`);
  },

  update(id: string, body: UpdateProjectRequest) {
    return api.patch<AdminProjectDetail>(`/api/admin/projects/${id}`, body);
  },

  delete(id: string) {
    return api.delete<void>(`/api/admin/projects/${id}`);
  },

  /** 작품 + 파일 일괄 등록 (multipart/form-data) */
  submit(formData: FormData) {
    return api.post<SubmitProjectResponse>(
      '/api/admin/projects/submit',
      formData,
    );
  },

  /** 기존 프로젝트에 자산 추가 */
  addAsset(projectId: string, formData: FormData) {
    return api.post<{ assetId: string; url: string }>(
      `/api/admin/projects/${projectId}/assets`,
      formData,
    );
  },

  /** 포스터 지정 */
  setPoster(projectId: string, body: { assetId: string }) {
    return api.patch<{ posterAssetId: string }>(
      `/api/admin/projects/${projectId}/poster`,
      body,
    );
  },
};

// ── Member CRUD ──────────────────────────────────────────────

export const adminMemberApi = {
  add(projectId: string, body: AddMemberRequest) {
    return api.post<{ id: string }>(`/api/admin/projects/${projectId}/members`, body);
  },

  update(projectId: string, memberId: string, body: UpdateMemberRequest) {
    return api.patch<void>(
      `/api/admin/projects/${projectId}/members/${memberId}`,
      body,
    );
  },

  remove(projectId: string, memberId: string) {
    return api.delete<void>(
      `/api/admin/projects/${projectId}/members/${memberId}`,
    );
  },
};

// ── Asset 삭제 ───────────────────────────────────────────────

export const adminAssetApi = {
  remove(assetId: string) {
    return api.delete<void>(`/api/admin/assets/${assetId}`);
  },
};
