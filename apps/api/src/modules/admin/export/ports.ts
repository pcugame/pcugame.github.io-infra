import type { AssetKind, ExportProgress, ExportResult } from '@pcu/contracts';

export type ExportRepresentationRole = 'ORIGINAL' | 'CARD_480' | 'DISPLAY_960' | 'WEBGL_SOURCE';

export interface ExportSnapshotObject {
	id: string;
	assetId: number;
	kind: AssetKind;
	role: ExportRepresentationRole;
	bucket: string;
	objectKey: string;
	mimeType: string;
	sizeBytes: number | null;
	etag: string | null;
	representationUpdatedAt: string | null;
	originalName: string;
	source: 'canonical';
}

export interface ExportProjectSnapshot {
	id: number;
	title: string;
	exhibition: { year: number; title: string };
	currentWebglDeploymentId: string | null;
	members: { name: string; studentId: string; sortOrder: number }[];
	objects: ExportSnapshotObject[];
}

export interface ExportSnapshot {
	version: 1;
	jobId: string;
	year: number | null;
	createdAt: string;
	projects: ExportProjectSnapshot[];
}

export interface ClaimedExportJob {
	id: string;
	year: number | null;
	dryRun: boolean;
	claimToken: string;
	attemptCount: number;
	maxAttempts: number;
	createdAt: string;
	snapshot: ExportSnapshot | null;
	snapshotHash: string | null;
}

export interface ExportJobStatus {
	id: string;
	state: 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED' | 'CANCELLED';
	progress: ExportProgress | null;
	result: ExportResult | null;
	error: string | null;
}
