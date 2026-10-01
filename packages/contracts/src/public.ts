import type { Visibility } from './enums.js';
import type { AssetPlaybackStatus, Platform } from './enums.js';
import type { ResponsiveImage } from './responsive-image.js';

/** GET /api/public/years */
export type PublicYearItem = {
	visibility: Visibility;
	id: number;
	year: number;
	title?: string;
	projectCount: number;
	poster?: ResponsiveImage;
};

export type PublicYearListResponse = {
	items: PublicYearItem[];
};

/** GET /api/public/years/:year/projects */
export type PublicProjectCard = {
	canChangeVisibility: boolean;
	exhibitionVisibility: Visibility;
	visibility: Visibility;
	id: number;
	slug: string;
	title: string;
	summary?: string;
	poster?: ResponsiveImage;
	members: { name: string; studentId: string }[];
	exhibitionId?: number;
	exhibitionTitle?: string;
};

export type PublicExhibition = {
	visibility: Visibility;
	id: number;
	title: string;
};

export type PublicYearProjectsResponse = {
	year: number;
	exhibitions: PublicExhibition[];
	items: PublicProjectCard[];
	empty: boolean;
};

/** GET /api/public/exhibitions/:id/projects */
export type PublicExhibitionProjectsResponse = {
	exhibition: { id: number; year: number; title: string; visibility: Visibility };
	items: PublicProjectCard[];
	empty: boolean;
};

/** Project video (locally uploaded) */
export type ProjectVideo = {
	assetId: number;
	sortOrder: number | null;
	role: 'MAIN' | 'ADDITIONAL';
	/** Present only when a READY browser-playable representation exists. */
	url?: string;
	mimeType: string;
	originalDownloadUrl?: string;
	playbackStatus?: AssetPlaybackStatus;
	playbackError?: string;
};

/** GET /api/public/projects/:idOrSlug */
export type PublicProjectImage = {
	id: number;
	kind: 'IMAGE' | 'POSTER';
	image: ResponsiveImage;
};

export type PublicProjectMember = {
	id: number;
	name: string;
	studentId: string;
};

/** A project-owned file that is always delivered as a download. */
export type ProjectAttachment = {
	assetId: number;
	kind: 'DOCUMENT' | 'ATTACHMENT';
	originalName: string;
	mimeType: string;
	sizeBytes: number;
	downloadUrl: string;
};

/** Capability fields are optional so a web deployment remains compatible with an older API. */
export type PublicUploadConfig = {
	materialMaxCount?: number;
	materialMaxBytes?: number;
};

export type PublicProjectDetailResponse = {
	canChangeVisibility: boolean;
	exhibitionVisibility: Visibility;
	visibility: Visibility;
	id: number;
	year: number;
	slug: string;
	title: string;
	summary?: string;
	description?: string;
	githubUrl?: string;
	platforms: Platform[];
	isIncomplete: boolean;
	video: ProjectVideo | null;
	videos: ProjectVideo[];
	members: PublicProjectMember[];
	images: PublicProjectImage[];
	/** Omitted by older API releases; clients treat it as an empty list. */
	attachments?: ProjectAttachment[];
	poster?: ResponsiveImage;
	gameDownloadUrl?: string;
	webglDisplayWidth?: number | null;
	webglDisplayHeight?: number | null;
	webglUrl?: string;
	/** Stable trusted API player URL; never exchanged for a file capability. */
	webglPlayUrl?: string;
	status: 'PUBLISHED' | 'ARCHIVED';
};
