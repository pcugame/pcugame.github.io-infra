import { describe, expect, it } from 'vitest';
import {
	LabCreateRunSchema,
	LabOutputSchema,
	LabUploadSchema,
	type LabRun,
	type LabResult,
} from './lab.js';
import { formatLabExport } from './lab-export.js';

const run = { id: '51512681-b19c-4da7-8e98-955e17dd938c' } as LabRun;
const result = {
	caseId: 'nick-0001',
	testCase: { nickname: '=unsafe "cell", example', tags: [], reference: { expectedReason: '기대', expectedScore: 30, sources: [] } },
  history: [], sources: [], bertScore: null,
	output: null,
	status: 'FAILED',
} as LabResult;

describe('nickname evaluation contracts', () => {
	it('rejects retired upload shapes and preserves optional prompt overrides verbatim', () => {
		expect(LabUploadSchema.safeParse({ name: 'old', jsonl: '{}' }).success).toBe(false);
		expect(
			LabUploadSchema.safeParse({ name: 'old', datasetType: 'context_terms', format: 'jsonl', content: '{}' })
				.success,
		).toBe(false);
		const request = {
			datasetId: run.id,
			size: 1,
			temperature: 0,
			maxTokens: 512,
			searchMode: 'no_search',
			model: 'local',
		};
		expect(LabCreateRunSchema.safeParse(request).success).toBe(true);
		for (const field of ['systemPrompt', 'actionPrompt', 'answerPrompt']) {
			for (const value of ['', '  한국어 지침\n두 번째 줄  '])
				expect(LabCreateRunSchema.parse({ ...request, [field]: value })).toHaveProperty(field, value);
			for (const value of [null, 'x\u0000', '\uD800', 'x'.repeat(8001)])
				expect(LabCreateRunSchema.safeParse({ ...request, [field]: value }).success).toBe(false);
		}
		for (const model of ['x\u0000', '\uD800', '\uDFFF'])
			expect(LabCreateRunSchema.safeParse({ ...request, model }).success).toBe(false);
	});
	it('allows uncertainty and rejects invalid scores, confidence and retired output fields', () => {
		const output = {
			schemaVersion: '2',
			nickname: '가상닉네임',
			interpretedTerm: null,
			reason: '판단 자료 부족',
			score: null,
			confidence: 0,
			sourceIds: [],
			abstained: true,
		};
		expect(LabOutputSchema.parse(output).score).toBeNull();
		for (const invalid of [
			{ score: 101 },
			{ score: -1 },
			{ score: 1.5 },
			{ confidence: 1.1 },
			{ originSummary: 'retired' },
			{ schemaVersion: '1' },
		])
			expect(LabOutputSchema.safeParse({ ...output, ...invalid }).success).toBe(false);
	});
	it('escapes CSV quotes and formulas and retains original nickname data in JSON and JSONL', () => {
		const csv = formatLabExport(run, [result], 'csv');
		expect(csv.filename).toMatch(/^nickname-evaluation-/);
		expect(csv.content).toContain(`"'=unsafe ""cell"", example"`);
		expect(csv.content.split('\r\n')[0]).toContain('ordinal,caseId,nickname');
		expect(csv.content.split('\r\n')[0]).not.toMatch(/term|context|language|datasetType/);
		expect(JSON.parse(formatLabExport(run, [result], 'json').content).results).toMatchObject([result]);
		expect(JSON.parse(formatLabExport(run, [result], 'jsonl').content).testCase.nickname).toBe(
			result.testCase.nickname,
		);
	});
});
