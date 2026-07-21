import type { AssetKind } from './enums.js';

export type ExportAssetKind = AssetKind | 'WEBGL';

export type ImportPreviewExhibition = {
	year: number;
	title: string;
	isNew: boolean;
	existingProjectCount: number;
};

export type ImportPreviewResult = {
	valid: boolean;
	exhibitions: ImportPreviewExhibition[];
	projectCount: number;
	errors: string[];
};

export type ImportExecuteResult = {
	exhibitions: { created: number; existing: number };
	projects: { created: number };
};

export type ExportPhase = 'preparing' | 'downloading' | 'finishing';
export type ExportFileStatus = 'pending' | 'saving' | 'saved' | 'skipped' | 'failed';

export type ExportProgressFile = {
	assetId: number;
	kind: ExportAssetKind;
	originalName: string;
	fileName: string;
	status: ExportFileStatus;
};

export type ExportProgress = {
	year: number | null;
	startedAt: number;
	phase: ExportPhase;
	totalProjects: number;
	currentProjectIndex: number;
	currentProjectTitle: string | null;
	currentProjectFiles: ExportProgressFile[];
	totalFiles: number;
	downloaded: number;
	skipped: number;
	failed: number;
};

/** GET /api/admin/export/status */
export type ExportStatusResponse = {
	running: boolean;
	progress: ExportProgress | null;
};

export type ExportResult = {
	projects: number;
	totalFiles: number;
	downloaded: number;
	skipped: number;
	failed: number;
	aborted: boolean;
	paths: string[];
};
