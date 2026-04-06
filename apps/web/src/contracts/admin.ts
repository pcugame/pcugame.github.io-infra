// ── Admin API 타입 ───────────────────────────────────────────

import type { AssetKind, ProjectStatus } from './enums';
import type { ProjectVideo } from './public';

// ── Exhibition ───────────────────────────────────────────────

export type CreateExhibitionRequest = {
  year: number;
  title?: string;
  isUploadEnabled?: boolean;
  sortOrder?: number;
};

export type UpdateExhibitionRequest = {
  title?: string;
  isUploadEnabled?: boolean;
  sortOrder?: number;
};

export type AdminExhibitionItem = {
  id: number;
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
};

export type AdminProjectItem = {
  id: number;
  title: string;
  slug: string;
  year: number;
  status: ProjectStatus;
  createdByUserName?: string;
  updatedAt: string;
};

export type AdminProjectDetail = {
  id: number;
  title: string;
  slug: string;
  year: number;
  summary?: string;
  description?: string;
  isLegacy: boolean;
  video: ProjectVideo | null;
  status: ProjectStatus;
  sortOrder: number;
  posterAssetId?: number;
  posterUrl?: string;
  members: { id: number; name: string; studentId: string; sortOrder: number; userId: number | null }[];
  assets: {
    id: number;
    kind: AssetKind;
    url: string;
    originalName: string;
    size: number;
  }[];
};

// ── Submit (all-in-one) ──────────────────────────────────────

export type SubmitProjectPayload = {
  exhibitionId: number;
  title: string;
  summary?: string;
  description?: string;
  videoUrl?: string;
  videoMimeType?: string;
  members: { name: string; studentId: string; sortOrder?: number }[];
  autoPublish?: boolean;
};

export type SubmitProjectResponse = {
  id: number;
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

// ── Backward compat aliases ─────────────────────────────────
/** @deprecated Use AdminExhibitionItem */
export type AdminYearItem = AdminExhibitionItem;
/** @deprecated Use CreateExhibitionRequest */
export type CreateYearRequest = CreateExhibitionRequest;
/** @deprecated Use UpdateExhibitionRequest */
export type UpdateYearRequest = UpdateExhibitionRequest;
