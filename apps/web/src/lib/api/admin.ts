// ── Admin API 호출 ───────────────────────────────────────────

import type {
  CreateExhibitionRequest,
  UpdateExhibitionRequest,
  AdminExhibitionItem,
  UpdateProjectRequest,
  AdminProjectListQuery,
  AdminProjectListResponse,
  AdminProjectDetail,
  SubmitProjectResponse,
  BulkUpdateProjectStatusRequest,
  BulkDeleteProjectsRequest,
  SetProjectPosterRequest,
  AddMemberRequest,
  UpdateMemberRequest,
  SwapProjectMembersRequest,
  BannedIpListResponse,
  SiteSettingsData,
  UpdateSiteSettingsRequest,
  ImportPreviewResult,
  ImportExecuteResult,
  ExportResult,
  ExportStatusResponse,
} from '../../contracts';
import { api, uploadFormData } from './client';

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

  uploadPoster(id: number, formData: FormData) {
    return uploadFormData<AdminExhibitionItem>(`/api/admin/exhibitions/${id}/poster`, formData, {
      title: '전시회 포스터 업로드',
      processingMessage: '포스터 전송 및 변환이 끝날 때까지 이 창을 닫거나 새로고침하지 마세요.',
    });
  },

  deletePoster(id: number) {
    return api.delete<void>(`/api/admin/exhibitions/${id}/poster`);
  },
};

// ── Project ──────────────────────────────────────────────────

function buildQuery(params: AdminProjectListQuery): string {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') query.set(key, String(value));
  });
  const text = query.toString();
  return text ? `?${text}` : '';
}

function getProjects(params: AdminProjectListQuery = {}) {
  return api.get<AdminProjectListResponse>(`/api/admin/projects${buildQuery(params)}`);
}

export const adminProjectApi = {
  getProjects,

  list: getProjects,

  getDetail(id: number) {
    return api.get<AdminProjectDetail>(`/api/admin/projects/${id}`);
  },

  update(id: number, body: UpdateProjectRequest) {
    return api.patch<AdminProjectDetail>(`/api/admin/projects/${id}`, body);
  },

  delete(id: number) {
    return api.delete<void>(`/api/admin/projects/${id}`);
  },

  deleteWebgl(id: number) {
    return api.delete<void>(`/api/admin/projects/${id}/webgl`);
  },

  /** 작품 + 파일 일괄 등록 (multipart/form-data) */
  submit(formData: FormData) {
    return uploadFormData<SubmitProjectResponse>(
      '/api/admin/projects/submit',
      formData,
      {
        title: '작품 파일 업로드',
        processingMessage: '파일 전송 및 변환이 끝날 때까지 이 창을 닫거나 새로고침하지 마세요.',
      },
    );
  },

  /** 기존 프로젝트에 자산 추가 */
  addAsset(projectId: number, formData: FormData, title = '자산 업로드') {
    return uploadFormData<{ assetId: number; url: string }>(
      `/api/admin/projects/${projectId}/assets`,
      formData,
      {
        title,
        processingMessage: '파일 전송 및 변환이 끝날 때까지 이 창을 닫거나 새로고침하지 마세요.',
      },
    );
  },

  /** 포스터 지정 */
  setPoster(projectId: number, body: SetProjectPosterRequest) {
    return api.patch<{ posterAssetId: number }>(
      `/api/admin/projects/${projectId}/poster`,
      body,
    );
  },

  /** 일괄 상태 변경 */
  bulkStatus(ids: number[], status: BulkUpdateProjectStatusRequest['status']) {
    return api.patch<{ updated: number }>(
      '/api/admin/projects/bulk/status',
      { ids, status } satisfies BulkUpdateProjectStatusRequest,
    );
  },

  /** 일괄 삭제 */
  bulkDelete(ids: number[]) {
    return api.post<{ deleted: number; assetsRemoved: number }>(
      '/api/admin/projects/bulk/delete',
      { ids } satisfies BulkDeleteProjectsRequest,
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

  swap(projectId: number, memberIdA: number, memberIdB: number) {
    return api.patch<void>(
      `/api/admin/projects/${projectId}/members/swap`,
      { memberIdA, memberIdB } satisfies SwapProjectMembersRequest,
    );
  },
};

// ── Asset 삭제 ───────────────────────────────────────────────

export const adminAssetApi = {
  remove(assetId: number) {
    return api.delete<void>(`/api/admin/assets/${assetId}`);
  },
};

export const adminSettingsApi = {
  get() {
    return api.get<SiteSettingsData>('/api/admin/settings');
  },

  update(body: UpdateSiteSettingsRequest) {
    return api.patch<SiteSettingsData>('/api/admin/settings', body);
  },
};

// ── Banned IPs ──────────────────────────────────────────────

export const adminBannedIpApi = {
  list() {
    return api.get<BannedIpListResponse>('/api/admin/banned-ips');
  },

  unban(id: number) {
    return api.delete<void>(`/api/admin/banned-ips/${id}`);
  },
};

export const adminExportApi = {
  run(year?: number) {
    return api.post<ExportResult>('/api/admin/export', { year });
  },

  status() {
    return api.get<ExportStatusResponse>('/api/admin/export/status');
  },
};

// ── Import ─────────────────────────────────────────────────

export const adminImportApi = {
  preview(file: File) {
    const fd = new FormData();
    fd.append('file', file);
    return uploadFormData<ImportPreviewResult>('/api/admin/import/preview', fd, {
      title: 'JSON 파일 업로드',
      processingMessage: '파일 처리 중에는 이 창을 닫거나 새로고침하지 마세요.',
    });
  },

  execute(file: File) {
    const fd = new FormData();
    fd.append('file', file);
    return uploadFormData<ImportExecuteResult>('/api/admin/import/execute', fd, {
      title: 'JSON 임포트 실행',
      processingMessage: '파일 처리 중에는 이 창을 닫거나 새로고침하지 마세요.',
    });
  },
};
