// ── 공유 Enum 상수 ────────────────────────���─────────────────

export const USER_ROLES = ['USER', 'OPERATOR', 'ADMIN'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const PROJECT_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const ASSET_KINDS = ['THUMBNAIL', 'IMAGE', 'POSTER', 'GAME', 'VIDEO'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
