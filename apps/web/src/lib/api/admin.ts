// ── Admin API 호출 ───────────────────────────────────────────

import type {
  CreateExhibitionRequest,
  UpdateExhibitionRequest,
  AdminExhibitionItem,
  UpdateProjectRequest,
  AdminProjectItem,
  AdminProjectDetail,
  SubmitProjectResponse,
  AddMemberRequest,
  UpdateMemberRequest,
} from '../../contracts';
import { api } from './client';

// ── Exhibition ──────────────────────────────────────────────

export const adminExhibitionApi = {
  list() {
    return api.get<{ items: AdminExhibitionItem[] }>('/api/admin/exhibitions');
  },

  create(body: CreateExhibitionRequest) {
    return api.post<{ id: number; year: number }>('/api/admin/exhibitions', body);
  },

  update(id: number, body: UpdateExhibitionRequest) {
    return api.patch<AdminExhibitionItem>(`/api/admin/exhibitions/${id}`, body);
  },

  delete(id: number) {
    return api.delete<void>(`/api/admin/exhibitions/${id}`);
  },
};

// ── Project ──────────────────────────────────────────────────

export const adminProjectApi = {
  list() {
    return api.get<{ items: AdminProjectItem[] }>('/api/admin/projects');
  },

  getDetail(id: number) {
    return api.get<AdminProjectDetail>(`/api/admin/projects/${id}`);
  },

  update(id: number, body: UpdateProjectRequest) {
    return api.patch<AdminProjectDetail>(`/api/admin/projects/${id}`, body);
  },

  delete(id: number) {
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
  addAsset(projectId: number, formData: FormData) {
    return api.post<{ assetId: number; url: string }>(
      `/api/admin/projects/${projectId}/assets`,
      formData,
    );
  },

  /** 포스터 지정 */
  setPoster(projectId: number, body: { assetId: number }) {
    return api.patch<{ posterAssetId: number }>(
      `/api/admin/projects/${projectId}/poster`,
      body,
    );
  },
};

// ── Member CRUD ──────────────────────────────────────────────

export const adminMemberApi = {
  add(projectId: number, body: AddMemberRequest) {
    return api.post<{ id: number }>(`/api/admin/projects/${projectId}/members`, body);
  },

  update(projectId: number, memberId: number, body: UpdateMemberRequest) {
    return api.patch<void>(
      `/api/admin/projects/${projectId}/members/${memberId}`,
      body,
    );
  },

  remove(projectId: number, memberId: number) {
    return api.delete<void>(
      `/api/admin/projects/${projectId}/members/${memberId}`,
    );
  },
};

// ── Asset 삭제 ───────────────────────────────────────────────

export const adminAssetApi = {
  remove(assetId: number) {
    return api.delete<void>(`/api/admin/assets/${assetId}`);
  },
};

// ── Banned IPs ──────────────────────────────────────────────

export interface BannedIpItem {
  id: number;
  ip: string;
  reason: string;
  createdAt: string;
}

// ── Site Settings ───────────────────────────────────────────

export interface SiteSettingsData {
  maxGameFileMb: number;
  maxChunkSizeMb: number;
}

export const adminSettingsApi = {
  get() {
    return api.get<SiteSettingsData>('/api/admin/settings');
  },

  update(body: Partial<SiteSettingsData>) {
    return api.patch<SiteSettingsData>('/api/admin/settings', body);
  },
};

// ── Banned IPs ──────────────────────────────────────────────

export const adminBannedIpApi = {
  list() {
    return api.get<{ items: BannedIpItem[] }>('/api/admin/banned-ips');
  },

  unban(id: number) {
    return api.delete<void>(`/api/admin/banned-ips/${id}`);
  },
};
