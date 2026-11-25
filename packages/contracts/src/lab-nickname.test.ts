import { describe, expect, it } from 'vitest';
import {
	LabNicknameInputSchema,
	labNicknameInput,
	LabCaseSchema,
	parseLabDataset,
	LabOutputSchema,
	LAB_NICKNAME_JSONL_TEMPLATE,
	LAB_NICKNAME_CSV_TEMPLATE,
	LabCreateRunSchema,
	type LabNicknameInput,
} from './lab.js';

const row = { nickname: '가상닉네임', reference: { expectedReason: '검증할 가설', expectedScore: 75 } };
const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n');
describe('nickname research import and input boundaries', () => {
	it('requires only three human fields, generates IDs, and accepts both minimal templates', () => {
		expect(parseLabDataset(jsonl(row), 'jsonl')).toEqual([
			{ ...row, id: 'nick-0001', reference: { ...row.reference, sources: [] }, tags: [] },
		]);
		for (const [content, format] of [
			[LAB_NICKNAME_JSONL_TEMPLATE, 'jsonl'],
			[LAB_NICKNAME_CSV_TEMPLATE, 'csv'],
		] as const)
			expect(parseLabDataset(content, format)).toHaveLength(1);
		expect(parseLabDataset(jsonl(row), 'jsonl', 'validation')[0]?.split).toBe('validation');
		expect(parseLabDataset(LAB_NICKNAME_CSV_TEMPLATE, 'csv', 'test')[0]?.split).toBe('test');
		expect(parseLabDataset(jsonl({ ...row, split: 'test' }), 'jsonl', 'train')[0]?.split).toBe('test');
	});
	it('reads BOM, escaped quotes, commas and multiline CSV without losing human evidence', () => {
		const csv =
			'\uFEFFnickname,expectedReason,expectedScore,scoreRange,tags,sources,split\r\n가상닉네임,"가설, ""인용""\r\n후속 검증",75,"[65,85]","[""uncertain""]","[""https://example.org/ref""]",test\r\n';
		expect(parseLabDataset(csv, 'csv')[0]).toMatchObject({
			nickname: row.nickname,
			reference: {
				expectedReason: '가설, "인용"\r\n후속 검증',
				expectedScore: 75,
				scoreRange: [65, 85],
				sources: ['https://example.org/ref'],
			},
			tags: ['uncertain'],
			split: 'test',
		});
		for (const content of [
			'nickname,expectedReason,expectedScore\nx,y,',
			'nickname,expectedReason,expectedScore\nx,"open,1',
			'nickname,nickname,expectedReason,expectedScore\nx,x,y,1',
		])
			expect(() => parseLabDataset(content, 'csv')).toThrow();
	});
	it('rejects invalid ranges, hidden fields, duplicates, invalid splits and cross-split families', () => {
		for (const changed of [
			{ context: 'hidden' },
			{ reference: { ...row.reference, expectedScore: 101 } },
			{ reference: { ...row.reference, scoreRange: [85, 65] } },
			{ reference: { expectedScore: 50 } },
			{ split: 'holdout' },
			{ nickname: 'two\nlines' },
		])
			expect(() => parseLabDataset(jsonl({ ...row, ...changed }), 'jsonl')).toThrow();
		expect(() => parseLabDataset(jsonl(row, row), 'jsonl')).toThrow(/Duplicate/);
		const first = { ...row, familyId: 'Family', split: 'train' };
		const second = { ...row, nickname: '가상변형', familyId: 'family', split: 'test' };
		expect(() => parseLabDataset(jsonl(first, second), 'jsonl')).toThrow(/Family/);
		expect(() => parseLabDataset(jsonl(first, { ...second, split: undefined }), 'jsonl')).toThrow(/Family/);
		expect(parseLabDataset(jsonl(first, { ...second, split: 'train' }), 'jsonl')).toHaveLength(2);
	});
	it('makes management metadata unassignable to provider inputs and projects only nickname', () => {
		const managed = LabCaseSchema.parse({
			id: 'HIDDEN_ID',
			...row,
			tags: ['HIDDEN_TAG'],
			familyId: 'HIDDEN_FAMILY',
			split: 'test',
		});
		// @ts-expect-error management records cannot be assigned as branded model inputs
		const unsafe: LabNicknameInput = managed;
		expect(LabNicknameInputSchema.safeParse(unsafe).success).toBe(false);
		expect(labNicknameInput(managed.nickname)).toEqual({ nickname: row.nickname });
	});
	it('allows neutral scores, uncertain judgments and custom run sizes', () => {
		const output = {
			schemaVersion: '2',
			nickname: row.nickname,
			interpretedTerm: null,
			reason: '판단 자료 부족',
			score: null,
			confidence: 0.1,
			sourceIds: [],
			abstained: true,
		};
		expect(LabOutputSchema.parse(output).score).toBeNull();
		expect(LabOutputSchema.parse({ ...output, score: 0, abstained: false }).score).toBe(0);
		expect(LabOutputSchema.safeParse({ ...output, confidence: 75 }).success).toBe(false);
		expect(
			LabCreateRunSchema.parse({
				datasetId: '51512681-b19c-4da7-8e98-955e17dd938c',
				size: 3,
				model: 'local',
				searchMode: 'no_search',
				temperature: 0,
				maxTokens: 256,
			}).size,
		).toBe(3);
	});
});
