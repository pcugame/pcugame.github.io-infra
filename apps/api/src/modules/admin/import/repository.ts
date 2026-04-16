import { prisma } from '../../../lib/prisma.js';
import type { Prisma, PrismaClient } from '@prisma/client';

type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

/** Find exhibition by unique (year, title) pair within a transaction */
export function findExhibitionByComposite(tx: Tx, year: number, title: string) {
	return tx.exhibition.findUnique({
		where: { year_title: { year, title } },
		include: { _count: { select: { projects: true } } },
	});
}

/** Upsert exhibition — create if not exists, leave existing untouched */
export function upsertExhibition(
	tx: Tx,
	data: { year: number; title: string; isUploadEnabled?: boolean },
) {
	return tx.exhibition.upsert({
		where: { year_title: { year: data.year, title: data.title } },
		update: {},
		create: {
			year: data.year,
			title: data.title,
			isUploadEnabled: data.isUploadEnabled ?? true,
		},
	});
}

/** Check if a project with given exhibition+slug already exists */
export function findProjectBySlug(tx: Tx, exhibitionId: number, slug: string) {
	return tx.project.findUnique({
		where: { project_exhibition_slug: { exhibitionId, slug } },
	});
}

/** Create a project with members in one call */
export function createProjectWithMembers(
	tx: Tx,
	data: {
		exhibitionId: number;
		slug: string;
		title: string;
		summary: string;
		description: string;
		isIncomplete: boolean;
		status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
		githubUrl: string;
		platforms: ('PC' | 'MOBILE' | 'WEB')[];
		creatorId: number;
		members: { name: string; studentId: string; sortOrder: number }[];
	},
) {
	const { members, ...projectData } = data;
	return tx.project.create({
		data: {
			...projectData,
			members: {
				create: members,
			},
		},
	});
}

/** Run a callback inside a Prisma interactive transaction */
export function runTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
	return prisma.$transaction(fn, { timeout: 30_000 });
}
