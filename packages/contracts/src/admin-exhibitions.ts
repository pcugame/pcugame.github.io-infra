import type { ResponsiveImage } from './responsive-image.js';

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
	poster?: ResponsiveImage;
	posterOriginalName?: string;
	posterSize?: number;
};
