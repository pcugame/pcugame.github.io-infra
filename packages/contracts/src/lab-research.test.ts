import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LabResearchActionSchema, LabResearchAnswerSchema } from './lab-research.js';

describe('research wire grammar and persistence validation', () => {
	it('retains scalar validation without lowering the PostgreSQL string regex into a permissive GBNF class', () => {
		const wire = z.toJSONSchema(LabResearchAnswerSchema, { target: 'draft-7' });
		expect(JSON.stringify(wire.properties?.interpretedTerm)).not.toContain('pattern');
		expect(JSON.stringify(wire.properties?.reason)).not.toContain('pattern');
		for (const unsafe of ['bad\u0000text', 'bad\ud800text']) {
			expect(LabResearchActionSchema.safeParse({ action: 'search', query: unsafe, hypotheses: [] }).success).toBe(false);
			expect(LabResearchAnswerSchema.safeParse({ evidenceChecks: [], schemaVersion: '2', nickname: '가상',
				interpretationStatus: 'unverified_hypothesis', interpretedTerm: unsafe, reason: '자료 부족', score: null, confidence: 0, sourceIds: [], abstained: true }).success).toBe(false);
		}
	});
	it('accepts ordinary mixed scripts and records them as hypotheses without assigning risk', () => {
		expect(LabResearchActionSchema.parse({ action: 'search', query: '달빛山책 의미',
			hypotheses: [{ term: '달빛 산책', basis: '한자는 산이라는 독법의 가설이며 위험 신호가 아니다' }] }).action).toBe('search');
		expect(LabResearchActionSchema.safeParse({ action: 'fetch', query: 'http://localhost', hypotheses: [] }).success).toBe(false);
	});
});
