import type { ProjectSubmissionItemStatus } from './admin-projects.js';

export type ProjectChangeKind = 'EDIT' | 'DELETE';
export type ProjectChangeState = 'DRAFT' | 'PENDING' | 'APPLYING' | 'COMPLETED' | 'REJECTED' | 'CANCELLED' | 'CONFLICT' | 'FAILED';
export interface ProjectChangeValues {
 title?: string; summary?: string; description?: string; githubUrl?: string;
 platforms?: Array<'PC' | 'MOBILE' | 'WEB'>;
 members?: Array<{ name: string; studentId: string }>;
 removeAssetIds?: number[]; posterAssetId?: number | null; videoAssetIds?: number[];
 removeWebgl?: boolean;
}
export interface ProjectChangeManifestItem {
 kind: 'DOCUMENT' | 'ATTACHMENT' | 'GAME' | 'WEBGL' | 'VIDEO' | 'IMAGE' | 'POSTER';
 slot: string; clientToken: string;
}
export interface CreateProjectChangeRequest { kind: ProjectChangeKind; reason: string; }
export interface UpdateProjectChangeRequest { reason?: string; changes?: ProjectChangeValues; manifest?: ProjectChangeManifestItem[]; }
export interface ProjectChangeSummary {
 id: string; projectId: number | null; originalProjectId: number; projectTitle: string;
 actorId: number; kind: ProjectChangeKind; state: ProjectChangeState; reason: string;
 reviewReason: string | null; reviewerId: number | null; error: string | null;
 baseVersion: number; createdAt: string; updatedAt: string; submittedAt: string | null; reviewedAt: string | null; completedAt: string | null;
}
export interface ProjectChangeDetail extends ProjectChangeSummary {
 before: ProjectChangeValues & { assets: Array<{ id: number; kind: string; originalName: string }>; currentWebglDeploymentId: string | null };
 changes: ProjectChangeValues;
 stagingProjectId: number | null; submissionId: string | null; items: ProjectSubmissionItemStatus[];
 stagedAssets: Array<{ id: number; kind: string; originalName: string; previewUrl: string }>;
}
export interface ProjectChangeListResponse { items: ProjectChangeSummary[]; total: number; }
