import type { Visibility } from './enums.js';
import type { ResponsiveImage } from './responsive-image.js';

export type CreateExhibitionRequest = {
	visibility?: Visibility;
	year: number;
	title?: string;
	isModificationEnabled?: boolean;
	/** @deprecated Use isModificationEnabled. */
	isUploadEnabled?: boolean;
	sortOrder?: number;
};

export type UpdateExhibitionRequest = {
	visibility?: Visibility;
	title?: string;
	isModificationEnabled?: boolean;
	/** @deprecated Use isModificationEnabled. */
	isUploadEnabled?: boolean;
	sortOrder?: number;
};

export type AdminExhibitionItem = {
	visibility: Visibility;
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
