// ── Public API 응답 타입 ─────────────────────────────────────

import type { DownloadPolicy } from './enums';

/** GET /api/public/years */
export type PublicYearItem = {
  id: string;
  year: number;
  title?: string;
  projectCount: number;
};

export type PublicYearListResponse = {
  items: PublicYearItem[];
};

/** GET /api/public/years/:year/projects */
export type PublicProjectCard = {
  id: string;
  slug: string;
  title: string;
  summary?: string;
  posterUrl?: string;
  members: { name: string; studentId: string }[];
  exhibitionId?: string;
  exhibitionTitle?: string;
};

export type PublicExhibition = {
  id: string;
  title: string;
};

export type PublicYearProjectsResponse = {
  year: number;
  exhibitions: PublicExhibition[];
  items: PublicProjectCard[];
  empty: boolean;
};

/** 프로젝트 영상 정보 (NAS 자체 호스팅) */
export type ProjectVideo = {
  provider: 'NAS';
  url: string;
  mimeType: string;
};

/** GET /api/public/projects/:idOrSlug */
export type PublicProjectImage = {
  id: string;
  url: string;
  kind: 'IMAGE' | 'POSTER';
};

export type PublicProjectMember = {
  id: string;
  name: string;
  studentId: string;
};

export type PublicProjectDetailResponse = {
  id: string;
  year: number;
  slug: string;
  title: string;
  summary?: string;
  description?: string;
  isLegacy: boolean;
  video: ProjectVideo | null;
  members: PublicProjectMember[];
  images: PublicProjectImage[];
  posterUrl?: string;
  gameDownloadUrl?: string;
  downloadPolicy: DownloadPolicy;
  status: 'PUBLISHED';
};
