import { z } from 'zod';

export const UserRoleSchema = z.enum(['USER', 'OPERATOR', 'ADMIN']);
export type UserRole = z.output<typeof UserRoleSchema>;
export const ProjectStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']);
export type ProjectStatus = z.output<typeof ProjectStatusSchema>;
export const AssetKindSchema = z.enum(['THUMBNAIL', 'IMAGE', 'POSTER', 'GAME', 'VIDEO', 'WEBGL', 'DOCUMENT', 'ATTACHMENT']);
export type AssetKind = z.output<typeof AssetKindSchema>;
export const AssetPlaybackStatusSchema = z.enum(['PENDING', 'READY', 'FAILED']);
export type AssetPlaybackStatus = z.output<typeof AssetPlaybackStatusSchema>;
export const PROJECT_PLATFORMS = ['PC', 'MOBILE', 'WEB'] as const;
export type Platform = typeof PROJECT_PLATFORMS[number];
export const VisibilitySchema = z.enum(['PUBLIC', 'AUTHENTICATED', 'STAFF']);
export type Visibility = z.output<typeof VisibilitySchema>;
