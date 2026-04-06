import { describe, it, expect } from 'vitest';
import {
	CreateExhibitionSchema,
	UpdateExhibitionSchema,
	UpdateProjectFormSchema,
	SubmitProjectPayloadSchema,
	AddMemberSchema,
	ProjectMemberInputSchema,
} from '../contracts/schemas';

// ── Exhibition schemas ──────────────────────────────────────

describe('CreateExhibitionSchema', () => {
	it('accepts valid input', () => {
		const result = CreateExhibitionSchema.parse({ year: 2025 });
		expect(result.year).toBe(2025);
	});

	it('rejects year below 2021', () => {
		expect(() => CreateExhibitionSchema.parse({ year: 2020 })).toThrow();
	});

	it('rejects year above 2100', () => {
		expect(() => CreateExhibitionSchema.parse({ year: 2101 })).toThrow();
	});

	it('rejects missing year', () => {
		expect(() => CreateExhibitionSchema.parse({})).toThrow();
	});
});

describe('UpdateExhibitionSchema', () => {
	it('accepts empty object', () => {
		expect(() => UpdateExhibitionSchema.parse({})).not.toThrow();
	});

	it('accepts partial update', () => {
		const result = UpdateExhibitionSchema.parse({ title: '수정됨' });
		expect(result.title).toBe('수정됨');
	});
});

// ── Project form schemas ─────────────────────────────────────

describe('UpdateProjectFormSchema', () => {
	it('accepts valid status values', () => {
		for (const s of ['DRAFT', 'PUBLISHED', 'ARCHIVED']) {
			const result = UpdateProjectFormSchema.parse({
				title: 'Test',
				status: s,
			});
			expect(result.status).toBe(s);
		}
	});

	it('rejects invalid status', () => {
		expect(() =>
			UpdateProjectFormSchema.parse({ title: 'Test', status: 'DELETED' }),
		).toThrow();
	});

	it('rejects title over 120 chars', () => {
		expect(() =>
			UpdateProjectFormSchema.parse({ title: 'x'.repeat(121) }),
		).toThrow();
	});

	it('rejects empty title', () => {
		expect(() =>
			UpdateProjectFormSchema.parse({ title: '' }),
		).toThrow();
	});
});

// ── Submit project payload ───────────────────────────────────

describe('SubmitProjectPayloadSchema', () => {
	const valid = {
		exhibitionId: 1,
		title: 'Game Title',
		members: [{ name: '홍길동', studentId: '2021001' }],
	};

	it('accepts minimal valid payload', () => {
		const result = SubmitProjectPayloadSchema.parse(valid);
		expect(result.exhibitionId).toBe(1);
		expect(result.members).toHaveLength(1);
	});

	it('rejects empty members', () => {
		expect(() =>
			SubmitProjectPayloadSchema.parse({ ...valid, members: [] }),
		).toThrow();
	});

	it('rejects missing title', () => {
		expect(() =>
			SubmitProjectPayloadSchema.parse({ ...valid, title: undefined }),
		).toThrow();
	});
});

// ── Member schemas ───────────────────────────────────────────

describe('AddMemberSchema', () => {
	it('accepts valid member', () => {
		const result = AddMemberSchema.parse({ name: '김철수', studentId: '2022001' });
		expect(result.name).toBe('김철수');
	});

	it('rejects empty name', () => {
		expect(() => AddMemberSchema.parse({ name: '', studentId: '123' })).toThrow();
	});

	it('rejects empty studentId', () => {
		expect(() => AddMemberSchema.parse({ name: 'Test', studentId: '' })).toThrow();
	});

	it('rejects name over 50 chars', () => {
		expect(() =>
			AddMemberSchema.parse({ name: 'a'.repeat(51), studentId: '123' }),
		).toThrow();
	});
});

describe('ProjectMemberInputSchema', () => {
	it('accepts valid input', () => {
		const result = ProjectMemberInputSchema.parse({
			name: '이영희',
			studentId: '2023002',
		});
		expect(result.name).toBe('이영희');
	});

	it('rejects missing fields', () => {
		expect(() => ProjectMemberInputSchema.parse({})).toThrow();
	});
});
