import {
	LAB_RESEARCH_ACTION_PROMPT, LAB_RESEARCH_ANSWER_PROMPT, LAB_RESEARCH_LIMITS as limits,
	LAB_RESEARCH_PROFILE, LAB_RESEARCH_SYSTEM_PROMPT, LabOutputSchema,
	LabResearchActionSchema, LabResearchAnswerSchema, LabEvidenceCheckSchema, labNicknameInput,
	type LabResearchAction, type LabSource,
} from '@pcu/contracts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { invalidGenerateSetting, type LabConfig } from './config.js';
import type { Attempt, WorkItem } from './evaluate.js';
import { jsonHeaders, LabFailure, requestJson } from './http.js';
import type { SearchProvider } from './search.js';
import { readGenerateHealth, type ToolSupport } from './status.js';

const actionSchema = z.toJSONSchema(LabResearchActionSchema, { target: 'draft-7' });
type ShownSource = { id: string; title: string; snippet: string; evidenceKind: 'search_snippet'; originalFetched: false };
type GenerationStep = {
	kind: 'action' | 'answer'; systemPrompt: string; prompt: string; schema: unknown;
	maxOutputTokens: number; inputTokens: number; outputTokens: number | null;
	reservedOutputTokens: number; durationMs: number; seconds?: number; finishReason?: string;
	suppliedSources: ShownSource[]; action?: LabResearchAction; error?: string;
	evidenceChecks?: z.infer<typeof LabResearchAnswerSchema>['evidenceChecks'];
	answer?: z.infer<typeof LabOutputSchema>;
	interpretationStatus?: z.infer<typeof LabResearchAnswerSchema>['interpretationStatus'];
};
type SearchStep = {
	kind: 'search'; origin: 'model' | 'backend'; query: string; language: 'ko'; durationMs: number;
	sources: LabSource[]; error?: string;
};
export type ResearchTrace = {
	protocol: typeof LAB_RESEARCH_PROFILE; systemPrompt: string; systemPromptHash: string;
	model: string; searchMode: string; limits: typeof limits; identity?: unknown;
	settings: { temperature: number; maxTokens: number; seed: 42 };
	steps: (GenerationStep | SearchStep)[]; limitations: string[];
	inputTokens: number; outputTokens: number; reservedOutputTokens: number;
};

// Escape control-looking template tokens in untrusted data; keep the JSON value unchanged.
const quoted = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
const failureCode = (error: unknown) => error instanceof LabFailure ? error.code : 'RESEARCH_REQUEST_FAILED';

export async function evaluateResearch(
	config: LabConfig, item: WorkItem, parentSignal: AbortSignal, toolSupport: ToolSupport, search: SearchProvider,
): Promise<Attempt> {
	const start = performance.now();
	const deadline = AbortSignal.timeout(limits.timeoutMs);
	const signal = AbortSignal.any([parentSignal, deadline]);
	const trace: ResearchTrace = {
		protocol: LAB_RESEARCH_PROFILE, model: item.model, searchMode: item.searchMode,
		systemPrompt: LAB_RESEARCH_SYSTEM_PROMPT,
		systemPromptHash: createHash('sha256').update(LAB_RESEARCH_SYSTEM_PROMPT).digest('hex'),
		limits, settings: { temperature: item.temperature, maxTokens: item.maxTokens, seed: 42 },
		steps: [], limitations: ['SEARCH_SNIPPETS_ONLY_ORIGINAL_PAGES_NOT_FETCHED'],
		inputTokens: 0, outputTokens: 0, reservedOutputTokens: 0,
	};
	const attempt: Attempt = {
		sources: [], searchCount: 0, toolSucceeded: false, toolSupport, toolCalls: 0,
		jsonAttempts: 0, outputFormat: 'schema', durationMs: 0, output: null, error: null,
		retryable: false, research: trace, generationUsage: [],
	};
	const modelCase = labNicknameInput(item.input.nickname);
	let hypotheses: LabResearchAction['hypotheses'] = [];
	let generations = 0;
	const queries = new Set<string>();
	const outcomes: { query: string; sourceIds: string[]; error?: string }[] = [];
	let pinnedIdentity: { weights_sha256: string; chat_template_sha256: string } | undefined;

	async function provider(path: string, body: object) {
		signal.throwIfAborted();
		return requestJson(config.modelUrl + path, {
			method: 'POST', headers: jsonHeaders(config.apiKey), body: JSON.stringify({ ...body, ...pinnedIdentity }),
			signal: AbortSignal.any([signal, AbortSignal.timeout(path === '/tokenize' ? 5000 : 92_000)]),
		}, 128_000);
	}
	async function generate(kind: 'action' | 'answer', repair = false) {
		const began = performance.now();
		signal.throwIfAborted();
		if (generations >= limits.maxGenerations) throw new LabFailure('GENERATION_LIMIT');
		const maxTokens = kind === 'action' ? Math.min(limits.actionTokens, item.maxTokens) : item.maxTokens;
		if (trace.reservedOutputTokens + maxTokens > limits.totalOutputTokens) throw new LabFailure('TOTAL_OUTPUT_TOKEN_LIMIT');
		const systemPrompt = LAB_RESEARCH_SYSTEM_PROMPT + '\n' +
			(kind === 'action' ? LAB_RESEARCH_ACTION_PROMPT : LAB_RESEARCH_ANSWER_PROMPT) +
			(repair ? '\nPrevious JSON was invalid. Regenerate a complete object, exact nickname, valid citations and quotes.' : '');
		// Retain both rounds: a broad second query must not silently erase the useful first-round definition.
		// Exact counted prompts, not character estimates, determine admission.
		let shown: ShownSource[] = attempt.sources.map(s => ({
			id: s.id, title: Array.from(s.title).slice(0, 100).join(''),
			snippet: Array.from(s.snippet).slice(0, 300).join(''),
			evidenceKind: 'search_snippet', originalFetched: false,
		}));
		let prompt = '';
		let inputTokens = 0;
		const inputAllowance = Math.min(limits.maxInputTokens, limits.totalInputTokens - trace.inputTokens);
		if (inputAllowance <= 0) throw new LabFailure('TOTAL_INPUT_TOKEN_LIMIT');
		for (let compression = 0; compression < 7; compression++) {
			prompt = quoted({ case: modelCase, normalizationHypothesis: modelCase.nickname.normalize('NFKC'),
				hypotheses, searchOutcomes: outcomes, searchesRemaining: limits.maxSearches - attempt.searchCount,
				sources: shown, allowedSourceIds: shown.map(s => s.id), originalPagesFetched: false });
			const raw = await provider('/tokenize', { profile: LAB_RESEARCH_PROFILE, prompt, system_prompt: systemPrompt });
			const count = z.object({ input_tokens: z.number().int().positive() }).safeParse(raw);
			if (!count.success) throw new LabFailure('MODEL_INVALID_TOKEN_COUNT');
			inputTokens = count.data.input_tokens;
			if (inputTokens <= inputAllowance) break;
			if (compression < 2) shown = shown.map(s => ({ ...s, snippet: Array.from(s.snippet).slice(0, compression ? 100 : 180).join('') }));
			else shown = shown.slice(1);
		}
		if (inputTokens > inputAllowance) throw new LabFailure('MODEL_INPUT_TOKEN_LIMIT');
		const allowedId = shown.length ? z.enum(shown.map(s => s.id)) : z.string();
		const schema = kind === 'action' ? actionSchema : z.toJSONSchema(LabResearchAnswerSchema.extend({
			nickname: z.literal(modelCase.nickname),
			sourceIds: z.array(allowedId).max(shown.length ? 2 : 0),
			evidenceChecks: z.array(LabEvidenceCheckSchema.extend({ sourceId: allowedId })).max(shown.length ? 2 : 0),
		}), { target: 'draft-7' });
		const step: GenerationStep = {
			kind, systemPrompt, prompt, schema, maxOutputTokens: maxTokens, inputTokens,
			outputTokens: null, reservedOutputTokens: maxTokens, durationMs: 0, suppliedSources: shown,
		};
		trace.steps.push(step);
		generations++;
		trace.inputTokens += inputTokens;
		trace.reservedOutputTokens += maxTokens; // A failed/aborted request may still consume its whole reservation.
		try {
			const raw = await provider('/generate', {
				profile: LAB_RESEARCH_PROFILE, prompt, system_prompt: systemPrompt, json_schema: schema,
				max_new_tokens: maxTokens, max_input_tokens: inputAllowance,
				timeout_ms: Math.max(1, Math.min(90000, Math.floor(limits.timeoutMs - (performance.now() - start) - 1000))),
			});
			const reply = z.object({
				text: z.string().max(16000), input_tokens: z.literal(inputTokens),
				output_tokens: z.number().int().min(0).max(maxTokens), seconds: z.number().nonnegative(),
				finish_reason: z.string(),
			}).safeParse(raw);
			if (!reply.success) throw new LabFailure('MODEL_INVALID_ENVELOPE');
			step.outputTokens = reply.data.output_tokens;
			step.seconds = reply.data.seconds;
			step.finishReason = reply.data.finish_reason;
			trace.outputTokens += reply.data.output_tokens;
			trace.reservedOutputTokens += reply.data.output_tokens - maxTokens;
			attempt.generationUsage!.push({ inputTokens, outputTokens: reply.data.output_tokens,
				seconds: reply.data.seconds, jsonFenceRemoved: false });
			if (reply.data.finish_reason !== 'stop') throw new LabFailure('MODEL_OUTPUT_TRUNCATED');
			let value: unknown;
			try { value = JSON.parse(reply.data.text); }
			catch { throw new LabFailure('INVALID_MODEL_JSON'); }
			return { value, step };
		} catch (error) {
			step.error = failureCode(error);
			throw error;
		} finally { step.durationMs = Math.round(performance.now() - began); }
	}
	async function retrieve(query: string, origin: SearchStep['origin']) {
		if (attempt.searchCount >= limits.maxSearches) throw new LabFailure('SEARCH_LIMIT');
		const key = query.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
		if (queries.has(key)) {
			trace.limitations.push('REPEATED_QUERY_SKIPPED');
			return;
		}
		queries.add(key);
		attempt.searchCount++;
		const step: SearchStep = { kind: 'search', origin, query, language: 'ko', durationMs: 0, sources: [] };
		trace.steps.push(step);
		const began = performance.now();
		try {
			const results = await search.search(query, 'ko', AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
			for (const result of results.slice(0, 4)) {
				const existing = attempt.sources.find(s => s.url === result.url);
				const source = existing ?? { ...result, id: `S${attempt.sources.length + 1}` };
				if (!existing) attempt.sources.push(source);
				step.sources.push(source);
			}
			if (origin === 'model') attempt.toolSucceeded = true;
			outcomes.push({ query, sourceIds: step.sources.map(s => s.id) });
		} catch (error) {
			if (signal.aborted) throw error;
			step.error = failureCode(error);
			trace.limitations.push('SEARCH_FAILED');
			outcomes.push({ query, sourceIds: [], error: step.error });
		} finally { step.durationMs = Math.round(performance.now() - began); }
	}
	try {
		if (config.model !== item.model || config.provider !== item.provider || config.provider !== 'transformers-generate')
			throw new LabFailure('RUN_PROVIDER_CONFIGURATION_CHANGED');
		const problem = invalidGenerateSetting(item, config.generateProfile);
		if (problem) throw new LabFailure(problem);
		const health = await readGenerateHealth(config, AbortSignal.any([signal, AbortSignal.timeout(5000)]));
		if (!health.identity) throw new LabFailure('RESEARCH_HEALTH_MISMATCH');
		trace.identity = health.identity;
		pinnedIdentity = { weights_sha256: health.identity.weights_sha256, chat_template_sha256: health.identity.chat_template_sha256 };
		if (health.busy) throw new LabFailure('MODEL_BUSY');
		if (item.searchMode === 'backend_retrieval') await retrieve(modelCase.nickname, 'backend');
		else if (item.searchMode === 'agentic_retrieval') {
			for (let round = 0; round < 3; round++) {
				// Always reserve one final answer. JSON repairs consume these same bounded slots.
				if (trace.reservedOutputTokens + Math.min(limits.actionTokens, item.maxTokens) + item.maxTokens > limits.totalOutputTokens ||
					trace.inputTokens + 2 * limits.maxInputTokens > limits.totalInputTokens) break;
				let generated: Awaited<ReturnType<typeof generate>>;
				try { generated = await generate('action', round > 0 && !hypotheses.length); }
				catch (error) {
					if (['INVALID_MODEL_JSON', 'MODEL_OUTPUT_TRUNCATED'].includes(failureCode(error))) continue;
					throw error;
				}
				const action = LabResearchActionSchema.safeParse(generated.value);
				if (!action.success || (action.data.action === 'search' ? !action.data.query?.trim() : action.data.query !== null)) {
					generated.step.error = 'INVALID_RESEARCH_ACTION';
					continue;
				}
				generated.step.action = action.data;
				hypotheses = action.data.hypotheses;
				if (action.data.action === 'finish') break;
				if (attempt.searchCount === limits.maxSearches) { trace.limitations.push('SEARCH_LIMIT_REACHED'); break; }
				attempt.toolCalls++;
				await retrieve(action.data.query!, 'model');
			}
		} else if (item.searchMode !== 'no_search') throw new LabFailure('UNKNOWN_SEARCH_MODE');
		for (let repair = 0; repair < 2; repair++) {
			attempt.jsonAttempts++;
			try {
				const { value, step } = await generate('answer', repair > 0);
				attempt.suppliedSourceIds = step.suppliedSources.map(s => s.id);
				const parsed = LabResearchAnswerSchema.safeParse(value);
				if (parsed.success) {
					step.evidenceChecks = parsed.data.evidenceChecks;
					const { evidenceChecks, interpretationStatus, ...output } = parsed.data;
					step.interpretationStatus = interpretationStatus;
					step.answer = output;
					const validEvidence = evidenceChecks.every(e => {
						const source = step.suppliedSources.find(s => s.id === e.sourceId);
						return !!source && !!e.quote.trim() && source.snippet.includes(e.quote);
					});
					const verifiedInterpretation = interpretationStatus === 'unverified_hypothesis'
						? output.abstained && output.score === null
						: interpretationStatus !== 'supported_hypothesis' || output.sourceIds.length > 0;
					if (validEvidence && verifiedInterpretation && output.nickname === modelCase.nickname && (!output.abstained || output.score === null) &&
						output.sourceIds.every(id => evidenceChecks.some(e => e.sourceId === id && e.relation !== 'unrelated'))) {
						attempt.output = LabOutputSchema.parse(output);
						return attempt;
					}
				}
				step.error = 'INVALID_MODEL_OUTPUT';
			} catch (error) {
				if (!['INVALID_MODEL_JSON', 'MODEL_OUTPUT_TRUNCATED'].includes(failureCode(error))) throw error;
			}
		}
		throw new LabFailure('INVALID_MODEL_OUTPUT');
	} catch (error) {
		attempt.error = deadline.aborted ? 'CASE_TIMEOUT' : parentSignal.aborted ? 'CASE_ABORTED' : failureCode(error);
		// Research never automatically multiplies a case's resource budget by re-running the whole loop.
		return attempt;
	} finally { attempt.durationMs = Math.round(performance.now() - start); }
}
