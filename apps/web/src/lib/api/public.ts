// ── Public API 호출 ──────────────────────────────────────────

import type {
  PublicYearListResponse,
  PublicYearProjectsResponse,
  PublicProjectDetailResponse,
} from '../../contracts';
import { api } from './client';

export const publicApi = {
  /** 공개 연도 목록 */
  getYears() {
    return api.get<PublicYearListResponse>('/api/public/years');
  },

  /** 특정 연도의 공개 프로젝트 목록 */
  getYearProjects(year: number) {
    return api.get<PublicYearProjectsResponse>(`/api/public/years/${year}/projects`);
  },

  /** 프로젝트 상세 (id 또는 slug, slug일 경우 year query 포함 가능) */
  getProjectDetail(idOrSlug: string | number, year?: number) {
    const query = year ? `?year=${year}` : '';
    return api.get<PublicProjectDetailResponse>(
      `/api/public/projects/${encodeURIComponent(String(idOrSlug))}${query}`,
    );
  },
};
