import type { AssetPlaybackStatus, Platform } from './enums.js';

/** GET /api/public/years */
export type PublicYearItem = {
	id: number;
	year: number;
	title?: string;
	projectCount: number;
	posterUrl?: string;
};

export type PublicYearListResponse = {
	items: PublicYearItem[];
};

/** GET /api/public/years/:year/projects */
export type PublicProjectCard = {
	id: number;
	slug: string;
	title: string;
	summary?: string;
	posterUrl?: string;
	members: { name: string; studentId: string }[];
	exhibitionId?: number;
	exhibitionTitle?: string;
};

export type PublicExhibition = {
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
	exhibition: { id: number; year: number; title: string };
	items: PublicProjectCard[];
	empty: boolean;
};

/** Project video (locally uploaded) */
export type ProjectVideo = {
	url: string;
	mimeType: string;
	originalDownloadUrl?: string;
	playbackStatus?: AssetPlaybackStatus;
	playbackError?: string;
};

/** GET /api/public/projects/:idOrSlug */
export type PublicProjectImage = {
	id: number;
	url: string;
	kind: 'IMAGE' | 'POSTER';
};

export type PublicProjectMember = {
	id: number;
	name: string;
	studentId: string;
};

export type PublicProjectDetailResponse = {
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
	posterUrl?: string;
	gameDownloadUrl?: string;
	webglUrl?: string;
	status: 'PUBLISHED' | 'ARCHIVED';
};
