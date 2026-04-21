import type { AdminExhibitionItem, CreateExhibitionRequest, UpdateExhibitionRequest } from '@pcu/contracts';
import { notFound, conflict } from '../../../shared/errors.js';
import * as repo from './repository.js';

/** List all exhibitions with project counts, mapped to API shape */
export async function listExhibitions(): Promise<AdminExhibitionItem[]> {
	const exhibitions = await repo.findAllExhibitions();
	return exhibitions.map((e) => ({
		id: e.id,
		year: e.year,
		title: e.title || undefined,
		isUploadEnabled: e.isUploadEnabled,
		sortOrder: e.sortOrder,
		projectCount: e._count.projects,
	}));
}

/** Create an exhibition after checking for duplicates */
export async function createExhibition(data: CreateExhibitionRequest) {
	const existing = await repo.findExhibitionByComposite(data.year, data.title || '');
	if (existing) throw conflict(`"${data.title || data.year}" 전시회가 이미 존재합니다`);

	const created = await repo.createExhibition(data);
	return { id: created.id, year: created.year };
}

/** Delete an exhibition by ID. Throws 404 if not found. */
export async function deleteExhibition(id: number) {
	const exhibition = await repo.findExhibitionByIdWithCount(id);
	if (!exhibition) throw notFound('Exhibition not found');

	await repo.deleteExhibition(id);
}

/** Partial-update an exhibition. Throws 404 if not found. Returns updated shape. */
export async function updateExhibition(
	id: number,
	patch: UpdateExhibitionRequest,
): Promise<AdminExhibitionItem> {
	const exhibition = await repo.findExhibitionById(id);
	if (!exhibition) throw notFound('Exhibition not found');

	const updated = await repo.updateExhibition(id, {
		...(patch.title !== undefined ? { title: patch.title } : {}),
		...(patch.isUploadEnabled !== undefined ? { isUploadEnabled: patch.isUploadEnabled } : {}),
		...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
	});

	return {
		id: updated.id,
		year: updated.year,
		title: updated.title || undefined,
		isUploadEnabled: updated.isUploadEnabled,
		sortOrder: updated.sortOrder,
		projectCount: updated._count.projects,
	};
}
