// ── TanStack Query Key 상수 ──────────────────────────────────
// 모든 query key를 여기서 관리하여 invalidate 시 일관성을 유지한다.

export const queryKeys = {
  // ── Auth ────────────────────────────────────────────────────
  me: ['me'] as const,

  // ── Public ─────────────────────────────────────────────────
  publicYears: ['publicYears'] as const,
  yearProjects: (year: number) => ['yearProjects', year] as const,
  exhibitionProjects: (id: number) => ['exhibitionProjects', id] as const,
  projectDetail: (year: number, slug: string) =>
    ['projectDetail', year, slug] as const,
  projectDetailById: (id: number) => ['projectDetailById', id] as const,

  // ── Admin ──────────────────────────────────────────────────
  adminExhibitions: ['adminExhibitions'] as const,
  adminProjects: ['adminProjects'] as const,
  adminProject: (id: number) => ['adminProject', id] as const,
  adminBannedIps: ['adminBannedIps'] as const,
  adminSettings: ['adminSettings'] as const,
} as const;
