import { z } from 'zod';
import { toSlug } from '../../../shared/slug.js';
import { badRequest } from '../../../shared/errors.js';
import * as repo from './repository.js';

// ── JSON 스키마 정의 ─────────────────────────────────────────

const ImportMember = z.object({
	name: z.string().min(1).max(50),
	studentId: z.string().max(20).optional().default(''),
	sortOrder: z.number().int().min(0).optional(),
});

const ImportProject = z.object({
	year: z.number().int().min(2000).max(2100),
	title: z.string().min(1).max(120),
	slug: z.string().max(80).optional(),
	summary: z.string().max(300).optional().default(''),
	description: z.string().max(5000).optional().default(''),
	isLegacy: z.boolean().optional().default(false),
	videoUrl: z.string().url().or(z.literal('')).optional().default(''),
	videoMimeType: z.string().max(100).optional().default(''),
	status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional().default('PUBLISHED'),
	githubUrl: z.string().max(500).optional().default(''),
	platforms: z.array(z.enum(['PC', 'MOBILE', 'WEB'])).optional().default([]),
	members: z.array(ImportMember).optional().default([]),
});

const ImportYear = z.object({
	year: z.number().int().min(2000).max(2100),
	title: z.string().max(100).optional().default(''),
	isUploadEnabled: z.boolean().optional().default(true),
});

const ImportDataSchema = z.object({
	years: z.array(ImportYear).optional().default([]),
	projects: z.array(ImportProject).optional().default([]),
});

export type ImportData = z.infer<typeof ImportDataSchema>;

// ── 프리뷰 (트랜잭션 없이 검증만) ─────────────────────────────

export interface PreviewResult {
	valid: boolean;
	exhibitions: { year: number; title: string; isNew: boolean; existingProjectCount: number }[];
	projectCount: number;
	errors: string[];
}

export async function previewImport(raw: string): Promise<PreviewResult> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { valid: false, exhibitions: [], projectCount: 0, errors: ['유효하지 않은 JSON 형식입니다.'] };
	}

	const result = ImportDataSchema.safeParse(parsed);
	if (!result.success) {
		const errors = result.error.issues.map(
			(i) => `${i.path.join('.')}: ${i.message}`,
		);
		return { valid: false, exhibitions: [], projectCount: 0, errors };
	}

	const data = result.data;

	// 전시회별로 기존 존재 여부 확인
	const yearSet = new Map<string, { year: number; title: string }>();

	for (const y of data.years) {
		const title = y.title || '';
		yearSet.set(`${y.year}::${title}`, { year: y.year, title });
	}
	for (const p of data.projects) {
		const key = `${p.year}::`;
		// years에 명시되지 않은 year는 자동 생성 대상
		if (!yearSet.has(key) && ![...yearSet.keys()].some(k => k.startsWith(`${p.year}::`))) {
			yearSet.set(key, { year: p.year, title: '' });
		}
	}

	const exhibitions: PreviewResult['exhibitions'] = [];
	for (const { year, title } of yearSet.values()) {
		const resolvedTitle = title || `${year} 졸업작품전`;
		const existing = await repo.findExhibitionByComposite(
			// preview는 트랜잭션 밖에서 실행 — prisma 직접 사용
			(await import('../../../lib/prisma.js')).prisma,
			year,
			resolvedTitle,
		);
		exhibitions.push({
			year,
			title: resolvedTitle,
			isNew: !existing,
			existingProjectCount: existing?._count.projects ?? 0,
		});
	}

	return {
		valid: true,
		exhibitions,
		projectCount: data.projects.length,
		errors: [],
	};
}

// ── 실제 임포트 (all-or-nothing 트랜잭션) ───────────────────

export interface ImportResult {
	exhibitions: { created: number; existing: number };
	projects: { created: number };
}

export async function executeImport(raw: string, creatorId: number): Promise<ImportResult> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw badRequest('유효하지 않은 JSON 형식입니다.');
	}

	const result = ImportDataSchema.safeParse(parsed);
	if (!result.success) {
		const errors = result.error.issues.map(
			(i) => `${i.path.join('.')}: ${i.message}`,
		);
		throw badRequest('JSON 검증 실패', errors.join('; '));
	}

	const data = result.data;

	return repo.runTransaction(async (tx) => {
		const exhibitionMap = new Map<string, number>(); // "year::title" -> id
		let exhibitionsCreated = 0;
		let exhibitionsExisting = 0;

		// 1. 전시회 생성/재활용
		for (const y of data.years) {
			const title = y.title || `${y.year} 졸업작품전`;
			const existing = await repo.findExhibitionByComposite(tx, y.year, title);
			if (existing) {
				exhibitionMap.set(`${y.year}::${title}`, existing.id);
				exhibitionsExisting++;
			} else {
				const created = await repo.upsertExhibition(tx, {
					year: y.year,
					title,
					isUploadEnabled: y.isUploadEnabled,
				});
				exhibitionMap.set(`${y.year}::${title}`, created.id);
				exhibitionsCreated++;
			}
		}

		// 2. 프로젝트의 year가 years에 없으면 자동 생성
		for (const p of data.projects) {
			const matchingKey = [...exhibitionMap.keys()].find(k => k.startsWith(`${p.year}::`));
			if (!matchingKey) {
				const defaultTitle = `${p.year} 졸업작품전`;
				const existing = await repo.findExhibitionByComposite(tx, p.year, defaultTitle);
				if (existing) {
					exhibitionMap.set(`${p.year}::${defaultTitle}`, existing.id);
					exhibitionsExisting++;
				} else {
					const created = await repo.upsertExhibition(tx, {
						year: p.year,
						title: defaultTitle,
					});
					exhibitionMap.set(`${p.year}::${defaultTitle}`, created.id);
					exhibitionsCreated++;
				}
			}
		}

		// 3. 프로젝트 생성
		let projectsCreated = 0;

		for (const p of data.projects) {
			// 해당 year의 exhibition ID 찾기
			const matchingKey = [...exhibitionMap.keys()].find(k => k.startsWith(`${p.year}::`));
			const exhibitionId = exhibitionMap.get(matchingKey!)!;

			// slug 생성 (중복 시 suffix)
			const baseSlug = p.slug || toSlug(p.title);
			let slug = baseSlug;
			let attempt = 0;
			while (await repo.findProjectBySlug(tx, exhibitionId, slug)) {
				attempt++;
				slug = `${baseSlug}-${attempt}`;
			}

			await repo.createProjectWithMembers(tx, {
				exhibitionId,
				slug,
				title: p.title,
				summary: p.summary,
				description: p.description,
				isLegacy: p.isLegacy,
				videoUrl: p.videoUrl,
				videoMimeType: p.videoMimeType,
				status: p.status,
				githubUrl: p.githubUrl,
				platforms: p.platforms,
				creatorId,
				members: p.members.map((m, i) => ({
					name: m.name,
					studentId: m.studentId,
					sortOrder: m.sortOrder ?? i,
				})),
			});
			projectsCreated++;
		}

		return {
			exhibitions: { created: exhibitionsCreated, existing: exhibitionsExisting },
			projects: { created: projectsCreated },
		};
	});
}
