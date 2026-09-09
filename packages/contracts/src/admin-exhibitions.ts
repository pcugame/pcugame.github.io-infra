import type { ResponsiveImage } from './responsive-image.js';

export type CreateExhibitionRequest = {
	year: number;
	title?: string;
	isModificationEnabled?: boolean;
	/** @deprecated Use isModificationEnabled. */
	isUploadEnabled?: boolean;
	sortOrder?: number;
};

export type UpdateExhibitionRequest = {
	title?: string;
	isModificationEnabled?: boolean;
	/** @deprecated Use isModificationEnabled. */
	isUploadEnabled?: boolean;
	sortOrder?: number;
};

export type AdminExhibitionItem = {
	id: number;
	year: number;
	title?: string;
	isModificationEnabled?: boolean;
	/** @deprecated Compatibility alias. */
	isUploadEnabled: boolean;
	sortOrder: number;
	projectCount: number;
	poster?: ResponsiveImage;
	posterOriginalName?: string;
	posterSize?: number;
};
