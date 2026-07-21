import type { CreateExhibitionRequest } from '@pcu/contracts';

export interface ExhibitionRecord {
	id: number;
	year: number;
	title: string;
	isUploadEnabled: boolean;
	sortOrder: number;
	posterStorageKey: string | null;
	posterOriginalName: string;
	posterSizeBytes: bigint;
	_count: { projects: number };
}

export interface ExhibitionRepository {
	findAllExhibitions(): Promise<ExhibitionRecord[]>;
	findExhibitionByComposite(year: number, title: string): Promise<{ id: number } | null>;
	findExhibitionById(id: number): Promise<{ id: number } | null>;
	findExhibitionByIdWithCount(id: number): Promise<{
		id: number;
		posterStorageKey: string | null;
		_count: { projects: number };
	} | null>;
	createExhibition(data: CreateExhibitionRequest): Promise<{ id: number; year: number }>;
	deleteExhibition(id: number): Promise<unknown>;
	updateExhibition(id: number, patch: {
		title?: string;
		isUploadEnabled?: boolean;
		sortOrder?: number;
	}): Promise<ExhibitionRecord>;
	replaceExhibitionPoster(id: number, data: {
		storageKey: string;
		originalName: string;
		mimeType: string;
		sizeBytes: bigint;
	}): Promise<{ updated: ExhibitionRecord; oldStorageKey: string | null } | null>;
	clearExhibitionPoster(id: number): Promise<{
		updated: ExhibitionRecord;
		oldStorageKey: string | null;
	} | null>;
}
