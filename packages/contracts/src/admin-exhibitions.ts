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
	posterUrl?: string;
	posterOriginalName?: string;
	posterSize?: number;
};
