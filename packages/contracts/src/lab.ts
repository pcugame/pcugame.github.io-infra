import { z } from 'zod';

// PostgreSQL text and jsonb accept Unicode scalar values except U+0000.
const pgText = (max: number) =>
	z
		.string()
		.max(max)
		.regex(/^[^\u0000\uD800-\uDFFF]*$/u);
const bounded = (max: number) => pgText(max).min(1);
const score = z.number().int().min(0).max(100).nullable();
const caseId = bounded(80).regex(/^[a-zA-Z0-9_-]+$/);
const language = bounded(35).regex(/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/);
const webUrl = pgText(2048).pipe(z.url({ protocol: /^https?$/ }));
export const LabCategorySchema = z.enum([
	'derogatory',
	'historical_conflict',
	'semantic_shift',
	'neutral',
	'uncertain',
]);
const legacyCase = z.strictObject({
	id: caseId,
	term: bounded(300),
	language,
	context: bounded(4000),
	category: LabCategorySchema,
	tags: z.array(bounded(80)).max(20),
	expectedBehavior: z.enum([
		'EVIDENCE_REQUIRED',
		'CONTEXT_SENSITIVE',
		'NEUTRAL_EXPECTED',
		'ABSTAIN_IF_UNSUPPORTED',
	]),
	reference: z
		.strictObject({
			proposedScore: score,
			verifiedScore: score,
			verification: z.enum(['UNVERIFIED', 'VERIFIED']),
			originNote: bounded(2000).nullable(),
			sources: z.array(webUrl).max(12),
		})
		.refine(
			(r) => (r.verification === 'VERIFIED' ? r.sources.length > 0 : r.verifiedScore === null),
			'Verified references require sources; unverified references cannot carry a verified score.',
		),
});
const nicknameCase = z.strictObject({
	id: caseId,
	nickname: bounded(300).refine((s) => s.trim().length > 0 && !/[\r\n\u2028\u2029]/u.test(s)),
});
export const LabCaseSchema = z.union([nicknameCase, legacyCase]);
export type LabCase = z.infer<typeof LabCaseSchema>;
// Existing snapshots and CSV consumers use these column names.
export function labCaseFields(row: LabCase) {
	return 'nickname' in row
		? { term: row.nickname, language: 'ko', context: '' }
		: { term: row.term, language: row.language, context: row.context };
}

export const LAB_JSONL_MAX_BYTES = 4 * 1024 * 1024;
export const LabUploadSchema = z.strictObject({ name: bounded(120), jsonl: bounded(LAB_JSONL_MAX_BYTES) });

/** Shared by the API and browser mock. Row order determines default benchmark selection. */
export function parseLabJsonl(raw: string): LabCase[] {
	if (new TextEncoder().encode(raw).length > LAB_JSONL_MAX_BYTES) throw new Error('JSONL exceeds 4 MiB');
	const lines = raw
		.replace(/^\uFEFF/, '')
		.trimEnd()
		.split(/\r?\n/);
	if (lines.length !== 500) throw new Error('Exactly 500 JSONL rows are required');
	const ids = new Set<string>();
	const examples = new Set<string>();
	const categories = { derogatory: 0, historical_conflict: 0, semantic_shift: 0, neutral: 0, uncertain: 0 };
	const languages = { ko: 0, en: 0, ja: 0, other: 0 };
	let nicknameCount = 0;
	const rows = lines.map((line, index) => {
		let row: LabCase;
		try {
			row = LabCaseSchema.parse(JSON.parse(line));
		} catch {
			throw new Error(`Invalid JSONL case on line ${index + 1}`);
		}
		const norm = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
		const key = 'nickname' in row ? norm(row.nickname) : JSON.stringify([norm(row.term), norm(row.context)]);
		if (ids.has(row.id) || examples.has(key)) throw new Error(`Duplicate ID or example on line ${index + 1}`);
		ids.add(row.id);
		examples.add(key);
		if ('nickname' in row) {
			nicknameCount++;
			return row;
		}
		categories[row.category]++;
		const lang = row.language.split('-')[0];
		languages[lang === 'ko' || lang === 'en' || lang === 'ja' ? lang : 'other']++;
		return row;
	});
	if (nicknameCount === rows.length) return rows;
	if (nicknameCount) throw new Error('Cannot mix nickname and legacy context cases');
	if (
		categories.derogatory !== 120 ||
		categories.historical_conflict !== 100 ||
		categories.semantic_shift !== 100 ||
		categories.neutral !== 100 ||
		categories.uncertain !== 80 ||
		languages.ko !== 300 ||
		languages.en !== 100 ||
		languages.ja !== 50 ||
		languages.other !== 50
	) {
		throw new Error('Invalid legacy dataset category or language distribution');
	}
	return rows;
}

const sourceId = z.string().regex(/^S[1-9][0-9]{0,2}$/);
export const LabSourceSchema = z.strictObject({
	id: sourceId,
	title: bounded(500),
	url: webUrl,
	snippet: pgText(4000),
	suppliedSnippet: pgText(4000).optional(),
	collectedAt: z.iso.datetime(),
});
export const LabOutputSchema = z.strictObject({
	schemaVersion: z.literal('1'),
	caseId,
	term: bounded(300),
	language,
	originSummary: bounded(4000),
	earliestAttestation: bounded(500).nullable(),
	controversySummary: bounded(4000),
	controversyScore: score,
	controversyReason: bounded(2000),
	originConfidence: z.number().min(0).max(1),
	sourceIds: z.array(sourceId).max(16),
	uncertainties: z.array(bounded(1000)).max(16),
	abstained: z.boolean(),
});
export const LabSearchModeSchema = z.enum(['no_search', 'backend_retrieval', 'model_tool_call']);
export const LAB_DIRECT_VERSION = 'direct-1';
const runSettings = {
	systemPrompt: bounded(16000).refine((value) => !!value.trim()),
	model: bounded(200),
	searchMode: LabSearchModeSchema.default('backend_retrieval'),
	temperature: z.number().min(0).max(2),
	maxTokens: z.number().int().min(128).max(4096),
};
const datasetRun = z
	.strictObject({
		...runSettings,
		datasetId: z.uuid(),
		size: z.union([z.literal(1), z.literal(10), z.literal(50), z.literal(500)]),
		caseIds: z.array(caseId).min(1).max(500).optional(),
	})
	.refine(
		(r) => !r.caseIds || (r.caseIds.length === r.size && new Set(r.caseIds).size === r.size),
		'Select one distinct case ID per requested evaluation',
	);
export const LabCreateRunSchema = z.union([
	datasetRun,
	z.strictObject({ ...runSettings, nickname: nicknameCase.shape.nickname }),
]);
export const LabResultStatusSchema = z.enum(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']);
export const LabRunStatusSchema = z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'CANCELLED']);
export const LabToolSupportSchema = z.enum(['supported', 'unsupported', 'unknown']);
const health = z.enum(['available', 'unavailable', 'unknown']);
export const LabStatusSchema = z.object({
	enabled: z.boolean(),
	provider: z.string(),
	model: z.string(),
	modelStatus: health,
	systemPromptSupported: z.boolean().optional(),
	searchStatus: health,
	toolSupport: LabToolSupportSchema,
	generationLimits: z
		.object({
			fixedTemperature: z.number(),
			maxInputTokens: z.number().int().positive(),
			maxOutputTokens: z.number().int().positive(),
		})
		.optional(),
	mock: z.boolean(),
});
export const LabDatasetSchema = z.object({
	id: z.uuid(),
	name: z.string(),
	version: z.string(),
	hash: z.string(),
	count: z.number(),
	createdAt: z.iso.datetime(),
});
export const LabRunSchema = z.object({
	id: z.uuid(),
	datasetId: z.uuid(),
	datasetHash: z.string(),
	datasetVersion: z.string().optional(),
	nickname: z.string().optional(),
	systemPrompt: z.string(),
	promptHash: z.string(),
	model: z.string(),
	provider: z.string(),
	searchMode: LabSearchModeSchema,
	temperature: z.number(),
	maxTokens: z.number(),
	size: z.number(),
	status: LabRunStatusSchema,
	createdAt: z.iso.datetime(),
	startedAt: z.iso.datetime().nullable(),
	completedAt: z.iso.datetime().nullable(),
	success: z.number(),
	failed: z.number(),
	cancelled: z.number(),
	stats: z.object({ meanScore: z.number().nullable(), scored: z.number(), abstained: z.number() }),
});
export const LabResultSchema = z.object({
	caseId,
	testCase: LabCaseSchema,
	status: LabResultStatusSchema,
	output: LabOutputSchema.nullable(),
	sources: z.array(LabSourceSchema),
	durationMs: z.number().nullable(),
	searchCount: z.number(),
	jsonValid: z.boolean(),
	error: z.string().nullable(),
	attempts: z.number(),
	toolSucceeded: z.boolean(),
	toolSupport: LabToolSupportSchema,
	history: z.array(z.unknown()),
});
export type LabDataset = z.infer<typeof LabDatasetSchema>;
export type LabRun = z.infer<typeof LabRunSchema>;
export type LabResult = z.infer<typeof LabResultSchema>;
export type LabOutput = z.infer<typeof LabOutputSchema>;
export type LabSource = z.infer<typeof LabSourceSchema>;
export type LabStatus = z.infer<typeof LabStatusSchema>;
export type LabCreateRun = z.infer<typeof LabCreateRunSchema>;
export type LabSearchMode = z.infer<typeof LabSearchModeSchema>;

export const LabPageQuerySchema = z.strictObject({
	page: z.coerce.number().int().min(1).max(100000).default(1),
	q: pgText(160).default(''),
});
export const LabResultsQuerySchema = LabPageQuerySchema.extend({ status: LabResultStatusSchema.optional() });
export const LabCompareQuerySchema = LabPageQuerySchema.extend({ left: z.uuid(), right: z.uuid() });
export const LabExportFormatSchema = z.enum(['json', 'jsonl', 'csv']);
export const LabRoleChangeSchema = z.strictObject({ role: z.enum(['USER', 'BETA_TESTER']) });
export const LabBetaUserSchema = z.object({
	id: z.number().int(),
	name: z.string(),
	email: z.string(),
	role: LabRoleChangeSchema.shape.role,
});
export const LAB_PAGE_SIZE = 25;
export const LAB_ACTIVE_RUN_LIMIT = 3;
export const LAB_CASE_ATTEMPT_LIMIT = 12;

export function formatLabExport(
	run: LabRun,
	results: LabResult[],
	format: z.infer<typeof LabExportFormatSchema>,
) {
	const filename = `term-origins-${run.id}.${format}`;
	if (format === 'json') return { filename, content: JSON.stringify({ run, results }, null, 2) };
	if (format === 'jsonl')
		return {
			filename,
			content: results.map((result) => JSON.stringify({ runId: run.id, ...result })).join('\n') + '\n',
		};
	const columns = [
		'runId',
		'caseId',
		'term',
		'language',
		'context',
		'status',
		'score',
		'confidence',
		'durationMs',
		'searchCount',
		'attempts',
		'resultJson',
	];
	function cell(value: string | number | null | undefined) {
		const str = String(value ?? '');
		const safe = /^[\t\r\n]|^\s*[=+@-]/.test(str) ? "'" + str : str;
		return '"' + safe.replaceAll('"', '""') + '"';
	}
	const rows = results.map((r) => {
		const { term, language, context } = labCaseFields(r.testCase);
		return [
			run.id,
			r.caseId,
			term,
			language,
			context,
			r.status,
			r.output?.controversyScore,
			r.output?.originConfidence,
			r.durationMs,
			r.searchCount,
			r.attempts,
			JSON.stringify(r),
		]
			.map(cell)
			.join(',');
	});
	return { filename, content: [columns.join(','), ...rows].join('\r\n') + '\r\n' };
}
