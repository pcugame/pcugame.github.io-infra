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
const item: WorkItem = {
	systemPrompt: 'Inspect in context.',
	provider: config.provider,
	model: config.model,
	temperature: 0.2,
	maxTokens: 512,
	searchMode: 'no_search',
	testCase: { id: 'en-0001', term: 'window', language: 'en', context: 'She opened the window.' },
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
