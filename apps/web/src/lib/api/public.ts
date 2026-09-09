// ── Public API 호출 ──────────────────────────────────────────

import type {
	PublicUploadConfig,
  PublicYearListResponse,
  PublicYearProjectsResponse,
  PublicExhibitionProjectsResponse,
  PublicProjectDetailResponse,
} from '../../contracts';
import { api, isApiError } from './client';

export const publicApi = {
  /** 공개 연도 목록 (전시 목록) */
  getYears() {
    return api.get<PublicYearListResponse>('/api/public/years');
  },

  /** 특정 연도의 공개 프로젝트 목록 */
  getYearProjects(year: number) {
    return api.get<PublicYearProjectsResponse>(`/api/public/years/${year}/projects`);
  },

  /** 특정 전시의 공개 프로젝트 목록 */
  getExhibitionProjects(id: number) {
    return api.get<PublicExhibitionProjectsResponse>(`/api/public/exhibitions/${id}/projects`);
  },

  /** 프로젝트 상세 (id 또는 slug, slug일 경우 year query 포함 가능) */
  getProjectDetail(idOrSlug: string | number, year?: number) {
    const query = year ? `?year=${year}` : '';
    return api.get<PublicProjectDetailResponse>(
      `/api/public/projects/${encodeURIComponent(String(idOrSlug))}${query}`,
    ).then((project) => ({ ...project, attachments: project.attachments ?? [] }));
  },

  /**
   * New material uploads are capability-gated so a newer web build can be
   * deployed before an API release that knows DOCUMENT and ATTACHMENT.
   */
  async getUploadConfig(): Promise<PublicUploadConfig | undefined> {
    try {
      return await api.get<PublicUploadConfig>('/api/public/upload-config');
    } catch (error) {
      if (isApiError(error) && error.status === 404) return undefined;
      throw error;
    }
  },
};
