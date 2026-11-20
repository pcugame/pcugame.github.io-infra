import { describe, expect, it } from 'vitest';
import { LabCreateRunSchema, LabOutputSchema, formatLabExport, type LabRun, type LabResult } from './lab.js';

const run = { id: '51512681-b19c-4da7-8e98-955e17dd938c' } as LabRun;
const item = { term: '=unsafe cell', context: 'say "hi", then leave', language: 'en' };
const result = { caseId: 'en-0001', testCase: item, output: null, status: 'FAILED' } as LabResult;

describe('lab evaluation boundaries', () => {
	it('rejects invalid SQL text and UTF-16 without changing valid user prompt bytes', () => {
		const request = {
			datasetId: run.id,
			size: 1,
			temperature: 0,
			maxTokens: 512,
			searchMode: 'no_search',
			model: 'local',
		};
		for (const systemPrompt of ['x\u0000', '\uD800', '\uDFFF', '  ']) {
			expect(LabCreateRunSchema.safeParse({ ...request, systemPrompt }).success).toBe(false);
		}
		const systemPrompt = '  history\r\n🚀  ';
		expect(LabCreateRunSchema.parse({ ...request, systemPrompt }).systemPrompt).toBe(systemPrompt);
	});
	it('allows uncertainty but rejects out-of-range scores and confidence', () => {
		const output = {
			schemaVersion: '1',
			caseId: 'en-0001',
			language: 'en',
			term: 'x',
			originSummary: 'unclear',
			earliestAttestation: null,
			controversySummary: 'context dependent',
			controversyScore: null,
			controversyReason: 'unknown',
			originConfidence: 0,
			sourceIds: [],
			uncertainties: [],
			abstained: true,
		};
		expect(LabOutputSchema.parse(output).controversyScore).toBeNull();
		for (const invalid of [
			{ controversyScore: 101 },
			{ controversyScore: -1 },
			{ controversyScore: 1.5 },
			{ originConfidence: 1.1 },
		])
			expect(LabOutputSchema.safeParse({ ...output, ...invalid }).success).toBe(false);
	});
	it('escapes CSV quotes and formula cells, preserves original data in JSON and JSONL', () => {
		expect(formatLabExport(run, [result], 'csv').content).toContain(
			`"'=unsafe cell","en","say ""hi"", then leave"`,
		);
		expect(JSON.parse(formatLabExport(run, [result], 'json').content).results).toEqual([result]);
		expect(JSON.parse(formatLabExport(run, [result], 'jsonl').content).testCase.term).toBe(item.term);
	});
});
