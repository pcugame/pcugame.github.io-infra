// ── TanStack Query Key 상수 ──────────────────────────────────
// 모든 query key를 여기서 관리하여 invalidate 시 일관성을 유지한다.

export const queryKeys = {
  // ── Auth ────────────────────────────────────────────────────
  me: ['me'] as const,

  // ── Public ─────────────────────────────────────────────────
  publicYears: ['publicYears'] as const,
  yearProjects: (year: number) => ['yearProjects', year] as const,
  projectDetail: (year: number, slug: string) =>
    ['projectDetail', year, slug] as const,
  projectDetailById: (id: string) => ['projectDetailById', id] as const,

  // ── Admin ──────────────────────────────────────────────────
  adminYears: ['adminYears'] as const,
  adminProjects: ['adminProjects'] as const,
  adminProject: (id: string) => ['adminProject', id] as const,
  adminBannedIps: ['adminBannedIps'] as const,
} as const;
