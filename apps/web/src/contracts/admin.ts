// ── Admin API 타입 ───────────────────────────────────────────

import type { AssetKind, DownloadPolicy, ProjectStatus } from './enums';
import type { ProjectVideo } from './public';

// ── Year ─────────────────────────────────────────────────────

export type CreateYearRequest = {
  year: number;
  title?: string;
  isUploadEnabled?: boolean;
  sortOrder?: number;
};

export type UpdateYearRequest = {
  title?: string;
  isUploadEnabled?: boolean;
  sortOrder?: number;
};

export type AdminYearItem = {
  id: string;
  year: number;
  title?: string;
  isUploadEnabled: boolean;
  sortOrder: number;
  projectCount: number;
};

// ── Project ──────────────────────────────────────────────────

export type UpdateProjectRequest = {
  title?: string;
  summary?: string;
  description?: string;
  videoUrl?: string | null;
  videoMimeType?: string;
  isLegacy?: boolean;
  status?: ProjectStatus;
  sortOrder?: number;
  downloadPolicy?: DownloadPolicy;
};

export type AdminProjectItem = {
  id: string;
  title: string;
  slug: string;
  year: number;
  status: ProjectStatus;
  createdByUserName?: string;
  updatedAt: string;
};

export type AdminProjectDetail = {
  id: string;
  title: string;
  slug: string;
  year: number;
  summary?: string;
  description?: string;
  isLegacy: boolean;
  video: ProjectVideo | null;
  status: ProjectStatus;
  sortOrder: number;
  downloadPolicy: DownloadPolicy;
  posterAssetId?: string;
  posterUrl?: string;
  members: { id: string; name: string; studentId: string; sortOrder: number; userId: string | null }[];
  assets: {
    id: string;
    kind: AssetKind;
    url: string;
    originalName: string;
    size: number;
  }[];
};

// ── Submit (all-in-one) ──────────────────────────────────────

export type SubmitProjectPayload = {
  year: number;
  title: string;
  summary?: string;
  description?: string;
  videoUrl?: string;
  videoMimeType?: string;
  members: { name: string; studentId: string; sortOrder?: number }[];
  autoPublish?: boolean;
};

export type SubmitProjectResponse = {
  id: string;
  slug: string;
  year: number;
  status: 'DRAFT' | 'PUBLISHED';
  adminEditUrl: string;
  publicUrl?: string;
};

// ── Member CRUD ──────────────────────────────────────────────

export type AddMemberRequest = {
  name: string;
  studentId: string;
  sortOrder?: number;
};

export type UpdateMemberRequest = {
  name?: string;
  studentId?: string;
  sortOrder?: number;
};
