import { describe, expect, it } from 'vitest';
import { LabResultSchema, LabRunSchema } from './lab.js';
import { labPromptSettings, labPromptSnapshot, parseLabPromptFile, LAB_PROMPT_FILE_MAX_BYTES } from './lab-prompts.js';
import { formatLabExport, type LabExportReview } from './lab-export.js';
import { labBertScoreSummary } from './lab-bertscore.js';
import { labDefaultReview } from './lab-curation.js';
import { labReviewResult } from './lab-human.js';

const bytes = (text: string) => new TextEncoder().encode(text);
const id = '51512681-b19c-4da7-8e98-955e17dd938c';
const timestamp = '2026-11-25T00:00:00.000Z';
function result(caseId = 'one') {
  return LabResultSchema.parse({ caseId, testCase: { id: caseId, nickname: '=수식', tags: ['한글'],
    reference: { expectedReason: '기대 "근거"\n다음 줄', expectedScore: 70, scoreRange: [65, 75] } },
    status: 'SUCCEEDED', output: { schemaVersion: '2', nickname: '=수식', interpretedTerm: null,
      reason: '실제, "근거"\n다음 줄', score: 60, confidence: 0.7, abstained: false, sourceIds: [] },
    sources: [], durationMs: 15, searchCount: 0, jsonValid: true, error: null, attempts: 1, toolSucceeded: false,
    toolSupport: 'unsupported', history: [{ event: 'finished', searchDurationMs: 0, generationDurationMs: 15 }], bertScore: null });
}
function run() {
  return LabRunSchema.parse({ id, datasetId: id, datasetHash: 'd'.repeat(64), datasetVersion: '3', schemaVersion: '3',
    evaluationProtocol: 'nickname-risk-v1', ...labPromptSettings(), promptHash: 'p'.repeat(64), model: 'test', provider: 'test',
    searchMode: 'no_search', temperature: 0, maxTokens: 256, size: 2, status: 'RUNNING', createdAt: timestamp,
    startedAt: timestamp, completedAt: null, success: 1, failed: 0, cancelled: 0, stats: { meanScore: 60, scored: 1, abstained: 0 },
    bertScore: labBertScoreSummary([{}, {}]) });
}
// Independent CSV decoder covers multiline quoted cells and BOM, not just substring matching.
function csv(text: string) {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (i === 0 && c === '\uFEFF') continue;
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === ',' || c === '\r')) {
      row.push(cell); cell = '';
      if (c === '\r') { expect(text[++i]).toBe('\n'); rows.push(row); row = []; }
    } else cell += c;
  }
  const [header, ...records] = rows;
  return records.map(r => { expect(r.length).toBe(header.length); return Object.fromEntries(header.map((key, i) => [key, r[i]])); });
}

describe('instruction files', () => {
  it('round trips Korean, blank, whitespace and newline instructions without normalization', () => {
    const settings = { systemPrompt: ' 한글\r\n두 줄  ', actionPrompt: '', answerPrompt: ' \n ' };
    expect(parseLabPromptFile(bytes(labPromptSnapshot(settings)))).toEqual(settings);
    expect(parseLabPromptFile(bytes('\uFEFF{"systemPrompt":""}'), true)).toEqual({ ...labPromptSettings({}, true), systemPrompt: '' });
    expect(parseLabPromptFile(bytes('{}'), false, true)).toEqual(labPromptSettings({}, false, true));
  });
  it('rejects invalid UTF-8/JSON, excess bytes/chars, nonobjects, null and unknown keys', () => {
    for (const input of ['{', '[]', 'null', '{"systemPrompt":null}', '{"unknown":"x"}',
      JSON.stringify({ answerPrompt: 'a'.repeat(8001) }), '{"systemPrompt":"\\u0000"}', '{"systemPrompt":"\\ud800"}'])
      expect(() => parseLabPromptFile(bytes(input))).toThrow();
    expect(() => parseLabPromptFile(new Uint8Array([0xff]))).toThrow();
    expect(() => parseLabPromptFile(new Uint8Array(LAB_PROMPT_FILE_MAX_BYTES + 1))).toThrow();
  });
});

describe('full run downloads', () => {
  it('keeps order, settings, errors, thresholds and review validity consistent across all formats', () => {
    const first = result('z-last-alphabetically');
    const second = { ...result('a-first-alphabetically'), status: 'PENDING' as const, output: null, jsonValid: false };
    const history: LabExportReview[] = [1, 2].map(revision => ({ id, runId: id, caseId: first.caseId, revision, actorId: 7,
      createdAt: timestamp, resultHash: 'a'.repeat(64), body: { ...labDefaultReview(first), verdict: 'correct', cohort: 'normal' },
      valid: revision === 2, resultSnapshot: labReviewResult(first) }));
    const options = { generatedAt: timestamp, threshold: 55, reviews: history };
    const json = JSON.parse(formatLabExport(run(), [first, second], 'json', options).content);
    const lines = formatLabExport(run(), [first, second], 'jsonl', options).content.trim().split('\n').map(s => JSON.parse(s));
    const file = formatLabExport(run(), [first, second], 'csv', options);
    const rows = csv(file.content);
    expect(file.content.startsWith('\uFEFF')).toBe(true);
    expect(file.content).not.toContain('resultJson');
    expect(json).toMatchObject({ formatVersion: 'nickname-evaluation-v2', generatedAt: timestamp, riskThreshold: 55,
      run: { status: 'RUNNING', completedAt: null }, metrics: { reviewed: 1, staleReviews: 0, riskThreshold: 55 }, bertScore: { measured: 0, missing: 2 } });
    expect(json.results.map((r: { caseId: string }) => r.caseId)).toEqual([first.caseId, second.caseId]);
    for (let i = 0; i < 2; i++) {
      expect(lines[i]).toMatchObject(json.results[i]);
      expect(lines[i].run).toEqual(json.run);
      expect(lines[i].metrics).toEqual(json.metrics);
      expect(rows[i].caseId).toBe(json.results[i].caseId);
      expect(rows[i].expectedReason).toBe(json.results[i].testCase.reference.expectedReason);
      expect(rows[i].systemPrompt).toBe(json.run.systemPrompt);
    }
    expect(rows[0]).toMatchObject({ nickname: "'=수식", reason: first.output!.reason, score: '60', scoreError: '-10', absoluteError: '10',
      highRisk: 'true', withinRange: 'false', reviewValid: 'true', reviewVerdict: 'correct', reviewRevision: '2' });
    expect(rows[1]).toMatchObject({ score: '', scoreError: '', highRisk: '', reviewValid: '' });
    expect(json.results[0].review.history).toHaveLength(2);
    const staleOptions = { ...options, reviews: history.map(r => ({ ...r, valid: false })) };
    const stale = JSON.parse(formatLabExport(run(), [first], 'json', staleOptions).content);
    expect(stale.metrics).toMatchObject({ reviewed: 0, staleReviews: 1 });
    expect(csv(formatLabExport(run(), [first], 'csv', staleOptions).content)[0].reviewVerdict).toBe('');
  });
  it('excludes derived scoring from the human review snapshot while preserving generation edits', () => {
    const initial = result();
    const updated = { ...initial, bertScore: { status: 'SKIPPED' as const, precision: null, recall: null, f1: null,
      reason: 'TOKEN_LIMIT', inputHash: '', identity: null, attempts: 1, completedAt: timestamp } };
    expect(labReviewResult(updated)).toEqual(labReviewResult(initial));
    expect(labReviewResult({ ...updated, output: { ...updated.output!, reason: 'changed' } })).not.toEqual(labReviewResult(initial));
  });
});
