import { describe, it, expect } from 'vitest';
import { ImportDataSchema, ImportMember, ImportProject, ImportYear } from '../modules/admin/import/service.js';

describe('ImportDataSchema', () => {
	it('parses minimal valid input', () => {
		const result = ImportDataSchema.safeParse({
			projects: [{ year: 2025, title: 'Test' }],
		});
		expect(result.success).toBe(true);
	});

	it('parses full input with years and projects', () => {
		const result = ImportDataSchema.safeParse({
			years: [{ year: 2025, title: '2025전시', isUploadEnabled: false }],
			projects: [{
				year: 2025,
				title: 'Game',
				slug: 'game',
				summary: 'A game',
				description: 'Details',
				isIncomplete: true,
				status: 'DRAFT',
				githubUrl: 'https://github.com/test',
				platforms: ['PC', 'WEB'],
				members: [{ name: '홍길동', studentId: '20251234' }],
			}],
		});
		expect(result.success).toBe(true);
	});

	it('defaults empty object to empty arrays', () => {
		const result = ImportDataSchema.parse({});
		expect(result).toEqual({ years: [], projects: [] });
	});

	it('applies default values for optional project fields', () => {
		const result = ImportDataSchema.parse({
			projects: [{ year: 2025, title: 'Test' }],
		});
		const p = result.projects[0]!;
		expect(p.isIncomplete).toBe(false);
		expect(p.status).toBe('PUBLISHED');
		expect(p.summary).toBe('');
		expect(p.description).toBe('');
		expect(p.githubUrl).toBe('');
		expect(p.platforms).toEqual([]);
		expect(p.members).toEqual([]);
	});
});

describe('ImportProject', () => {
	it('rejects year below 2000', () => {
		const result = ImportProject.safeParse({ year: 1999, title: 'Test' });
		expect(result.success).toBe(false);
	});

	it('rejects year above 2100', () => {
		const result = ImportProject.safeParse({ year: 2101, title: 'Test' });
		expect(result.success).toBe(false);
	});

	it('rejects title longer than 120 characters', () => {
		const result = ImportProject.safeParse({ year: 2025, title: 'x'.repeat(121) });
		expect(result.success).toBe(false);
	});

	it('rejects invalid status value', () => {
		const result = ImportProject.safeParse({ year: 2025, title: 'Test', status: 'DELETED' });
		expect(result.success).toBe(false);
	});

	it('accepts valid platform values', () => {
		const result = ImportProject.safeParse({
			year: 2025,
			title: 'Test',
			platforms: ['PC', 'MOBILE', 'WEB'],
		});
		expect(result.success).toBe(true);
	});

	it('rejects invalid platform value', () => {
		const result = ImportProject.safeParse({
			year: 2025,
			title: 'Test',
			platforms: ['CONSOLE'],
		});
		expect(result.success).toBe(false);
	});
});

describe('ImportYear', () => {
	it('parses valid year with defaults', () => {
		const result = ImportYear.parse({ year: 2025 });
		expect(result.title).toBe('');
		expect(result.isUploadEnabled).toBe(true);
	});

	it('rejects year below 2000', () => {
		const result = ImportYear.safeParse({ year: 1999 });
		expect(result.success).toBe(false);
	});

	it('rejects year above 2100', () => {
		const result = ImportYear.safeParse({ year: 2101 });
		expect(result.success).toBe(false);
	});
});

describe('ImportMember', () => {
	it('rejects name longer than 50 characters', () => {
		const result = ImportMember.safeParse({ name: 'x'.repeat(51) });
		expect(result.success).toBe(false);
	});

	it('rejects studentId longer than 20 characters', () => {
		const result = ImportMember.safeParse({ name: 'Test', studentId: '1'.repeat(21) });
		expect(result.success).toBe(false);
	});

	it('defaults studentId to empty string', () => {
		const result = ImportMember.parse({ name: 'Test' });
		expect(result.studentId).toBe('');
	});
});
