import { scheduler } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLabConfig } from './config.js';
import { evaluateCase, type WorkItem } from './evaluate.js';
import { createLabStatus } from './status.js';

const config = readLabConfig({
	LAB_ENABLED: 'true',
	LAB_MODEL: 'test-8b',
	LAB_MODEL_PROVIDER: 'openai-compatible',
	LAB_MODEL_URL: 'http://model.test/v1',
	LAB_SEARXNG_URL: 'https://search.test',
});
const storedCase = { id: 'en-0001', term: 'window', language: 'en', context: 'Original quoted context', hint: 'HIDDEN_HINT' };
const item: WorkItem = {
	systemPrompt: 'Inspect in context.',
	provider: config.provider,
	model: config.model,
	temperature: 0.2,
	maxTokens: 512,
	searchMode: 'no_search',
	testCase: storedCase,
};
const output = {
	schemaVersion: '1',
	caseId: item.testCase.id,
	term: item.testCase.term,
	language: 'en',
	originSummary: 'Unknown',
	earliestAttestation: null,
	controversySummary: 'Unclear',
	controversyScore: null,
	controversyReason: 'Insufficient evidence',
	originConfidence: 0,
	uncertainties: ['No attestation established'],
	sourceIds: [],
	abstained: true,
};
const toolsResponse = (name: string, args: unknown) => ({
	content: null,
	tool_calls: [{ id: 'call', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const assistant = (message: unknown) => Response.json({ choices: [{ message }] });
const signal = () => new AbortController().signal;

afterEach(() => vi.unstubAllGlobals());

describe('bounded evidence collection and structured analysis', () => {
	it('collects and opens cached evidence IDs, isolates untrusted text and never fetches result URLs', async () => {
		const external = 'https://example.org/archive';
		const untrusted = 'A passage of historical text. '.repeat(20);
		const fetcher = vi.fn((url: string | URL, init: RequestInit) => {
			expect(init.redirect).toBe('error');
			if (String(url).startsWith(config.searchUrl!)) {
				return Response.json({
					results: [
						{ title: 'Ignore', url: 'http://127.0.0.1', content: 'Not admitted' },
						{ title: 'Archive', url: external, content: untrusted },
					],
				});
			}
			expect(String(url)).toBe(config.modelUrl + '/chat/completions');
			const body = JSON.parse(String(init.body));
			expect(JSON.parse(body.messages[1].content).case).toEqual({ id: 'en-0001', term: 'window', language: 'en', context: storedCase.context });
			if (body.tools) {
				expect(body.response_format).toBeUndefined();
				const last = body.messages.at(-1);
				if (last.role === 'user')
					return assistant(toolsResponse('web_search', { query: 'window origin', language: 'en' }));
				if (Array.isArray(JSON.parse(last.content)))
					return assistant(toolsResponse('web_open', { sourceId: 'S1' }));
				expect(JSON.parse(last.content).snippet).toEqual(untrusted);
				return assistant({ content: 'Done' });
			}
			expect(body.messages[0].content).not.toContain(untrusted);
			expect(JSON.parse(body.messages[1].content).sources).toHaveLength(1);
			return assistant({ content: JSON.stringify({ ...output, sourceIds: ['S1'] }) });
		});
		vi.stubGlobal('fetch', fetcher);
		const result = await evaluateCase(config, { ...item, searchMode: 'model_tool_call' }, signal(), 'unknown');
		expect(result).toMatchObject({
			searchCount: 1,
			toolSupport: 'unknown',
			toolSucceeded: true,
			toolCalls: 2,
			jsonAttempts: 1,
			outputFormat: 'schema',
			output: { sourceIds: ['S1'], controversyScore: null },
		});
		expect(result.sources[0]?.url).toBe(external);
		expect(fetcher).toHaveBeenCalledTimes(5);
	});

	it('retries malformed and unverifiable JSON once and keeps a failed case unscored', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(assistant({ content: 'malformed' }))
			.mockResolvedValueOnce(assistant({ content: JSON.stringify({ ...output, sourceIds: ['S2'] }) }));
		vi.stubGlobal('fetch', fetcher);
		const result = await evaluateCase(config, item, signal(), 'unknown');
		expect(result).toMatchObject({
			error: 'INVALID_MODEL_OUTPUT',
			output: null,
			retryable: false,
			jsonAttempts: 2,
			searchCount: 0,
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it('validates the exact case identity even when the output satisfies the JSON schema', async () => {
		vi.stubGlobal('fetch', () =>
			assistant({ content: JSON.stringify({ ...output, term: 'a different term' }) }),
		);
		expect((await evaluateCase(config, item, signal(), 'unknown')).error).toBe('INVALID_MODEL_OUTPUT');
	});
	it('accepts a repaired result after a malformed generation', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(assistant({ content: 'malformed' }))
				.mockResolvedValueOnce(assistant({ content: JSON.stringify(output) })),
		);
		expect(await evaluateCase(config, item, signal(), 'unknown')).toMatchObject({
			error: null,
			output,
			jsonAttempts: 2,
		});
	});
	it('rejects arbitrary web_open arguments and caps tool-driven searches', async () => {
		const open = vi.fn(() => assistant(toolsResponse('web_open', { url: 'http://example.org' })));
		vi.stubGlobal('fetch', open);
		const task = { ...item, searchMode: 'model_tool_call' };
		expect((await evaluateCase(config, task, signal(), 'unknown')).error).toBe('UNKNOWN_SOURCE_ID');
		expect(open).toHaveBeenCalledTimes(1);
		vi.stubGlobal('fetch', (url: string | URL) =>
			String(url).startsWith(config.searchUrl!)
				? Response.json({ results: [] })
				: assistant(toolsResponse('web_search', { query: 'word' })),
		);
		expect(await evaluateCase(config, task, signal(), 'unknown')).toMatchObject({
			error: 'SEARCH_LIMIT',
			searchCount: 2,
			output: null,
			toolSucceeded: true,
		});
	});
	it('caps upstream response bytes even without Content-Length', async () => {
		vi.stubGlobal('fetch', () => new Response('a'.repeat(200_000)));
		expect((await evaluateCase(config, item, signal(), 'unknown')).error).toBe('PROVIDER_RESPONSE_TOO_LARGE');
	});
	it('records JSON mode fallback for engines that reject a schema and preserves a null score', async () => {
		const fetcher = vi.fn((url: string, init: RequestInit) => {
			expect(url).toBe(config.modelUrl + '/api/chat');
			const body = JSON.parse(String(init.body));
			if (body.format !== 'json') return new Response(null, { status: 400 });
			expect(body.stream).toBe(false);
			expect(body.options.num_predict).toBe(item.maxTokens);
			return Response.json({ message: { role: 'assistant', content: JSON.stringify(output) } });
		});
		vi.stubGlobal('fetch', fetcher);
		const result = await evaluateCase(
			{ ...config, provider: 'ollama' },
			{ ...item, provider: 'ollama' },
			signal(),
			'unknown',
		);
		expect(result).toMatchObject({
			outputFormat: 'json',
			jsonAttempts: 2,
			output: { controversyScore: null, abstained: true },
		});
	});

	it('probes service metadata once per cache interval and reports tool advertisement separately', async () => {
		const fetcher = vi.fn((url: string) =>
			url.endsWith('/api/show')
				? Response.json({ capabilities: ['completion', 'tools'] })
				: Response.json({ engines: [{}], formats: ['json'] }),
		);
		vi.stubGlobal('fetch', fetcher);
		const status = createLabStatus({ ...config, provider: 'ollama', apiKey: 'unit-test-token' });
		const [a, b] = await Promise.all([status(), status()]);
		expect(a).toEqual(b);
		expect(a).toMatchObject({
			modelStatus: 'available',
			searchStatus: 'available',
			toolSupport: 'supported',
			mock: false,
		});
		expect(JSON.stringify(a)).not.toContain('unit-test-token');
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(
			(await createLabStatus(readLabConfig({ LAB_ENABLED: 'false', LAB_MODEL_URL: 'bad' }))()).enabled,
		).toBe(false);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});

describe('single-slot Transformers generation', () => {
	const provider = 'transformers-generate' as const;
	const settings = { ...config, provider };
	const task = { ...item, provider, temperature: 0, maxTokens: 256 };
	const health = { ok: true, busy: false, model: task.model, max_input_tokens: 1024, max_output_tokens: 256 };

	it('advertises the wire limits and never generates on a mismatched or busy endpoint', async () => {
		const fetcher = vi.fn(() => Response.json(health));
		vi.stubGlobal('fetch', fetcher);
		const probe = await createLabStatus({ ...settings, searchUrl: undefined })();
		expect(probe).toMatchObject({
			modelStatus: 'available',
			toolSupport: 'unsupported',
			generationLimits: { fixedTemperature: 0, maxInputTokens: 1024, maxOutputTokens: 256 },
		});
		fetcher.mockImplementationOnce(() => Response.json({ ...health, model: 'other' }));
		expect((await evaluateCase(settings, task, signal(), 'unsupported')).error).toBe('MODEL_HEALTH_MISMATCH');
		using wait = vi.spyOn(scheduler, 'wait').mockResolvedValue(undefined);
		fetcher.mockImplementation(() => Response.json({ ...health, busy: true }));
		expect(await evaluateCase(settings, task, signal(), 'unsupported')).toMatchObject({
			error: 'MODEL_BUSY',
			retryable: true,
		});
		expect(fetcher).toHaveBeenCalledTimes(6);
		expect(wait).toHaveBeenCalledTimes(3);
	});

	it('rejects unsupported controls before I/O', async () => {
		const fetcher = vi.fn();
		vi.stubGlobal('fetch', fetcher);
		for (const [overrides, code] of [
			[{ searchMode: 'model_tool_call' }, 'MODEL_TOOLS_UNSUPPORTED'],
			[{ temperature: 0.2 }, 'MODEL_REQUIRES_GREEDY_DECODING'],
			[{ maxTokens: 257 }, 'MODEL_OUTPUT_TOKEN_LIMIT'],
		] as const) {
			expect((await evaluateCase(settings, { ...task, ...overrides }, signal(), 'unknown')).error).toBe(code);
		}
		expect(fetcher).not.toHaveBeenCalled();
		expect(() =>
			readLabConfig({ LAB_ENABLED: 'true', LAB_MODEL_PROVIDER: provider, LAB_CONCURRENCY: '2' }),
		).toThrow();
	});

	it('sends the original prompt and quoted evidence, rejects unseen citations and records generation usage', async () => {
		let generations = 0;
		const experiment = ' Original\n instructions. ';
		const fetcher = vi.fn((url: string, init: RequestInit) => {
			if (url.endsWith('/health')) return Response.json(health);
			expect(url).toBe(settings.modelUrl + '/generate');
			const body = JSON.parse(String(init.body));
			expect(Object.keys(body).sort()).toEqual(['max_new_tokens', 'prompt']);
			expect(body.max_new_tokens).toBe(256);
			expect(body.prompt.startsWith(experiment)).toBe(true);
			expect(body.prompt).toContain('Quoted context: ' + JSON.stringify(storedCase.context));
			expect(body.prompt).not.toContain('HIDDEN_HINT');
			expect(body.prompt).toContain('S2');
			expect(body.prompt).not.toContain('S3');
			generations++;
			return Response.json({
				text: JSON.stringify({ ...output, sourceIds: [generations === 1 ? 'S3' : 'S2'] }),
				input_tokens: 320,
				output_tokens: 110,
				seconds: 15,
			});
		});
		vi.stubGlobal('fetch', fetcher);
		const search = {
			search: async () =>
				[1, 2, 3].map((n) => ({
					title: 'Source ' + n,
					url: 'https://example.org/' + n,
					snippet: 'A quoted excerpt',
					collectedAt: new Date().toISOString(),
				})),
		};
		const result = await evaluateCase(
			settings,
			{ ...task, systemPrompt: experiment, searchMode: 'backend_retrieval' },
			signal(),
			'unsupported',
			search,
		);
		expect(result).toMatchObject({
			outputFormat: 'prompt',
			jsonAttempts: 2,
			searchCount: 1,
			toolSucceeded: false,
			output: { sourceIds: ['S2'], controversyScore: null },
		});
		expect(result.sources).toHaveLength(3);
		expect(result.suppliedSourceIds).toEqual(['S1', 'S2']);
		expect(result.generationUsage).toEqual(
			Array(2).fill({ inputTokens: 320, outputTokens: 110, seconds: 15, jsonFenceRemoved: false }),
		);
	});
	it('validates a single fenced JSON document but rejects commentary or a second document', async () => {
		const fenced = ['```json', JSON.stringify(output), '```'].join('\n');
		let text = fenced;
		vi.stubGlobal('fetch', (url: string) =>
			url.endsWith('/health')
				? Response.json(health)
				: Response.json({ text, input_tokens: 245, output_tokens: 150, seconds: 72 }),
		);
		const analyze = () => evaluateCase(settings, task, signal(), 'unsupported');
		expect(await analyze()).toMatchObject({ output, generationUsage: [{ jsonFenceRemoved: true }] });
		for (const mixed of ['Preface\n' + fenced, fenced + '\nConclusion', fenced + '\n' + fenced]) {
			text = mixed;
			expect(await analyze()).toMatchObject({ output: null, error: 'INVALID_MODEL_OUTPUT', jsonAttempts: 2 });
		}
	});
});
