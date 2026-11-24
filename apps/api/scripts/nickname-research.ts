import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { LAB_RESEARCH_PROFILE, labNicknameInput, parseLabDataset, type LabCase } from '@pcu/contracts';
import { readLabConfig } from '../src/modules/benchmark-worker/config.js';
import { evaluateCase, type Attempt } from '../src/modules/benchmark-worker/evaluate.js';

const { values } = parseArgs({ options: {
	nickname: { type: 'string' }, dataset: { type: 'string' }, output: { type: 'string' },
	mode: { type: 'string', default: 'all' }, limit: { type: 'string', default: '1' },
} });
if (!!values.nickname === !!values.dataset) throw new Error('Provide exactly one --nickname or --dataset (JSONL)');
const config = readLabConfig();
if (!config.enabled || config.generateProfile !== LAB_RESEARCH_PROFILE)
	throw new Error('Enable LAB_GENERATE_PROFILE=nickname-research-v1 with the configured 4B /generate endpoint');
const modes = values.mode === 'all' ? ['no_search', 'backend_retrieval', 'agentic_retrieval'] : [values.mode!];
if (modes.some(m => !['no_search', 'backend_retrieval', 'agentic_retrieval'].includes(m))) throw new Error('Invalid --mode');
if (modes.some(m => m !== 'no_search') && !config.searchUrl) throw new Error('LAB_SEARXNG_URL is required for search comparisons');
const count = Number(values.limit);
if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error('--limit must be 1..50 per invocation');
const dataset = values.dataset ? parseLabDataset(await readFile(values.dataset, 'utf8'), 'jsonl') : undefined;
const rows: { id: string; nickname: string; reference?: LabCase['reference'] }[] = dataset
	? dataset.slice(0, count) : [{ id: 'single', nickname: values.nickname! }];
const results: (Attempt & { caseId: string; nickname: string; searchMode: string; reference?: LabCase['reference'] })[] = [];
let identity: string | undefined;
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
for (const row of rows) {
	for (const searchMode of modes) {
		abort.signal.throwIfAborted();
		const result = await evaluateCase(config, {
			provider: config.provider, model: config.model, temperature: 0, maxTokens: 768,
			searchMode, input: labNicknameInput(row.nickname),
		}, abort.signal, 'unsupported');
		const nextIdentity = JSON.stringify(result.research?.identity);
		if (identity && nextIdentity && identity !== nextIdentity) throw new Error('Model identity changed during comparison');
		identity ??= nextIdentity;
		results.push({ caseId: row.id, nickname: row.nickname, searchMode, reference: row.reference, ...result });
		// Keep resumable per-case observations even if a later mode fails or the operator interrupts.
		if (values.output) await save();
	}
}
async function save() {
	const metrics = modes.map(searchMode => {
		const selected = results.filter(r => r.searchMode === searchMode);
		const scored = selected.filter(r => r.output?.score != null);
		const referenced = scored.filter(r => r.reference);
		const ranged = referenced.filter(r => r.reference!.scoreRange);
		return { searchMode, cases: selected.length,
			failed: selected.filter(r => r.error).length, maeCases: referenced.length, rangeCases: ranged.length,
			jsonValid: selected.filter(r => r.output).length, scored: scored.length,
			abstained: selected.filter(r => r.output?.abstained).length,
			mae: referenced.length ? referenced.reduce((s, r) => s + Math.abs(r.output!.score! - r.reference!.expectedScore), 0) / referenced.length : null,
			inScoreRange: ranged.length ? ranged.filter(r => r.output!.score! >= r.reference!.scoreRange![0] && r.output!.score! <= r.reference!.scoreRange![1]).length / ranged.length : null,
			meanDurationMs: selected.reduce((s, r) => s + r.durationMs, 0) / (selected.length || 1),
			inputTokens: selected.reduce((s, r) => s + (r.research?.inputTokens ?? 0), 0),
			outputTokens: selected.reduce((s, r) => s + (r.research?.outputTokens ?? 0), 0),
		};
	});
	const report = { verification: 'live-provider', createdAt: new Date().toISOString(),
		datasetHash: createHash('sha256').update(JSON.stringify(dataset ?? rows)).digest('hex'),
		selectedCaseIds: rows.map(r => r.id), model: config.model, profile: config.generateProfile, metrics, results };
	const text = JSON.stringify(report, null, 2) + '\n';
	if (values.output) await writeFile(values.output, text, { mode: 0o600 });
	else process.stdout.write(text);
}
await save();
if (results.some(r => r.error)) process.exitCode = 1;
