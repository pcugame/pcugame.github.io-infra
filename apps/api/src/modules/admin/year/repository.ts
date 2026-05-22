import { prisma } from '../../../lib/prisma.js';

/** @returns All exhibitions ordered by sortOrder asc, year desc, with project counts */
export function findAllExhibitions() {
	return prisma.exhibition.findMany({
		orderBy: [{ sortOrder: 'asc' }, { year: 'desc' }],
		include: { _count: { select: { projects: true } } },
	});
}

/** @returns Exhibition matching the unique (year, title) pair, or null */
export function findExhibitionByComposite(year: number, title: string) {
	return prisma.exhibition.findUnique({
		where: { year_title: { year, title } },
	});
}

/** @returns Exhibition by primary key, or null */
export function findExhibitionById(id: number) {
	return prisma.exhibition.findUnique({ where: { id } });
}

/** @returns Exhibition by primary key with project count, or null */
export function findExhibitionByIdWithCount(id: number) {
	return prisma.exhibition.findUnique({
		where: { id },
		include: { _count: { select: { projects: true } } },
	});
}

/** Create a new Exhibition record */
export function createExhibition(data: { year: number; title?: string; isUploadEnabled?: boolean; sortOrder?: number }) {
	return prisma.exhibition.create({ data });
}

/** Delete an Exhibition by primary key (cascades via DB FK) */
export function deleteExhibition(id: number) {
	return prisma.exhibition.delete({ where: { id } });
}

/** Partial-update an Exhibition and return the updated record with project count */
export function updateExhibition(
	id: number,
	data: { title?: string; isUploadEnabled?: boolean; sortOrder?: number },
) {
	return prisma.exhibition.update({
		where: { id },
		data,
		include: { _count: { select: { projects: true } } },
	});
}

/** Store processed poster metadata on an exhibition and return the previous key. */
export async function replaceExhibitionPoster(
	id: number,
	data: {
		storageKey: string;
		originalName: string;
		mimeType: string;
		sizeBytes: bigint;
	},
) {
	return prisma.$transaction(async (tx) => {
		const existing = await tx.exhibition.findUnique({
			where: { id },
			select: { posterStorageKey: true },
		});

		if (!existing) return null;

		const updated = await tx.exhibition.update({
			where: { id },
			data: {
				posterStorageKey: data.storageKey,
				posterOriginalName: data.originalName,
				posterMimeType: data.mimeType,
				posterSizeBytes: data.sizeBytes,
			},
			include: { _count: { select: { projects: true } } },
		});

		return { updated, oldStorageKey: existing.posterStorageKey };
	});
}

/** Clear poster metadata from an exhibition and return the removed key. */
export async function clearExhibitionPoster(id: number) {
	return prisma.$transaction(async (tx) => {
		const existing = await tx.exhibition.findUnique({
			where: { id },
			select: { posterStorageKey: true },
		});

		if (!existing) return null;

		const updated = await tx.exhibition.update({
			where: { id },
			data: {
				posterStorageKey: null,
				posterOriginalName: '',
				posterMimeType: '',
				posterSizeBytes: 0,
			},
			include: { _count: { select: { projects: true } } },
		});

		return { updated, oldStorageKey: existing.posterStorageKey };
	});
}
