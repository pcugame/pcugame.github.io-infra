// ── Admin API 타입 ───────────────────────────────────────────

import type { AssetKind, DownloadPolicy, ProjectStatus } from './enums';

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
  youtubeUrl?: string | null;
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
  youtubeUrl?: string;
  status: ProjectStatus;
  sortOrder: number;
  downloadPolicy: DownloadPolicy;
  posterAssetId?: string;
  posterUrl?: string;
  members: { id: string; name: string; studentId: string; sortOrder: number }[];
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
  youtubeUrl?: string;
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
