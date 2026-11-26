export type UserRole = 'USER' | 'OPERATOR' | 'ADMIN';
export type ProjectStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type AssetKind = 'THUMBNAIL' | 'IMAGE' | 'POSTER' | 'GAME' | 'VIDEO' | 'WEBGL' | 'DOCUMENT' | 'ATTACHMENT';
export type AssetPlaybackStatus = 'PENDING' | 'READY' | 'FAILED';
export const PROJECT_PLATFORMS = ['PC', 'MOBILE', 'WEB'] as const;
export type Platform = typeof PROJECT_PLATFORMS[number];
export type Visibility = 'PUBLIC' | 'AUTHENTICATED' | 'STAFF';
