import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	LAB_NICKNAME_SYSTEM_PROMPT,
	LabNicknameInputSchema,
	labNicknameInput,
	type LabNicknameInput,
} from '@pcu/contracts';
import { readLabConfig } from './config.js';
import { evaluateCase, type WorkItem } from './evaluate.js';

const nickname = '가상연구닉네임';
const output = {
	schemaVersion: '2',
	nickname,
	interpretedTerm: null,
	reason: '판단 근거 부족',
	score: null,
	confidence: 0.1,
	sourceIds: [],
	abstained: true,
};
const hidden = {
	id: 'SECRET_ID',
	reference: {
		expectedReason: 'SECRET_REASON',
		expectedScore: 79,
		sources: ['https://example.org/SECRET_REFERENCE'],
	},
	tags: ['SECRET_TAG'],
	familyId: 'SECRET_FAMILY',
	split: 'test',
};
it('rejects assigning a management record to the provider DTO at the TypeScript boundary', () => {
	const management = { nickname, ...hidden };
	// @ts-expect-error a management record lacks the model-input brand
	const input: LabNicknameInput = management;
	expect(LabNicknameInputSchema.safeParse(input).success).toBe(false);
});

afterEach(() => vi.unstubAllGlobals());

for (const provider of ['openai-compatible', 'ollama', 'transformers-generate'] as const) {
	describe(`nickname boundary: ${provider}`, () => {
		for (const mode of provider === 'transformers-generate'
			? ['no_search', 'backend_retrieval']
			: ['no_search', 'backend_retrieval', 'model_tool_call']) {
			it(`never sends management metadata or custom answers through ${mode}, including repair and schema fallback`, async () => {
				const config = readLabConfig({
					LAB_ENABLED: 'true',
					LAB_MODEL_PROVIDER: provider,
					LAB_MODEL: 'fixture',
					LAB_MODEL_URL: 'http://model.test',
					LAB_SEARXNG_URL: 'http://search.test',
				});
				// Simulate a hostile richer runtime value as well as the compile-time DTO guarantee.
				const item: WorkItem = {
					input: { ...labNicknameInput(nickname), ...hidden },
					provider,
					model: 'fixture',
					maxTokens: 256,
					temperature: 0,
					searchMode: mode,
				};
				Object.assign(item, { systemPrompt: 'SECRET_PROMPT_ANSWER' });
				let finalCalls = 0;
				let fallback = false;
				let searches = 0;
				let toolCalls = 0;
				const fetcher = vi.fn((url: string | URL, init?: RequestInit) => {
					const wire = String(url) + (init?.body ?? '');
					expect(wire).not.toMatch(/SECRET_|expectedScore|expectedReason|familyId|"split"|"tags"/);
					if (String(url).endsWith('/health'))
						return Response.json({
							ok: true,
							busy: false,
							model: 'fixture',
							max_input_tokens: 1024,
							max_output_tokens: 256,
						});
					if (String(url).startsWith('http://search.test')) {
						searches++;
						expect(new URL(url).searchParams.get('q')).toBe(nickname);
						return Response.json({
							results: [{ title: '자료', url: 'https://example.org/source', content: '수집한 발췌문' }],
						});
					}
					const body = JSON.parse(String(init?.body));
					const text = provider === 'transformers-generate' ? body.prompt : body.messages[0].content;
					expect(text).toContain(LAB_NICKNAME_SYSTEM_PROMPT);
					if (body.tools) {
						toolCalls++;
						const message = body.messages.some((m: { role: string }) => m.role === 'tool')
							? { content: 'Done' }
							: {
									content: null,
									tool_calls: [
										{
											id: 't1',
											type: 'function',
											function: { name: 'web_search', arguments: JSON.stringify({ query: nickname }) },
										},
									],
								};
						return Response.json(provider === 'ollama' ? { message } : { choices: [{ message }] });
					}
					if (provider !== 'transformers-generate') {
						expect(JSON.parse(body.messages[1].content).case).toEqual({ nickname });
						const schema = provider === 'ollama' ? body.format : body.response_format.json_schema?.schema;
						if (schema && schema !== 'json' && !fallback) {
							fallback = true;
							expect(schema.properties).not.toHaveProperty('caseId');
							return new Response(null, { status: 400 });
						}
					}
					finalCalls++;
					const content =
						finalCalls === 1
							? '{}'
							: JSON.stringify({ ...output, sourceIds: mode === 'no_search' ? [] : ['S1'] });
					return Response.json(
						provider === 'transformers-generate'
							? { text: content, input_tokens: 300, output_tokens: 100, seconds: 1 }
							: provider === 'ollama'
								? { message: { content } }
								: { choices: [{ message: { content } }] },
					);
				});
				vi.stubGlobal('fetch', fetcher);
				const result = await evaluateCase(config, item, new AbortController().signal, 'supported');
				expect(result.error).toBeNull();
				expect(result.output).toMatchObject({ schemaVersion: '2', nickname, score: null, abstained: true });
				expect(searches).toBe(mode === 'no_search' ? 0 : 1);
				if (mode === 'model_tool_call') expect(toolCalls).toBe(2);
				if (mode !== 'no_search')
					expect(result.sources[0]).toMatchObject({
						id: 'S1',
						url: 'https://example.org/source',
						title: '자료',
						snippet: '수집한 발췌문',
					});
			});
		}
	});
}

it('rejects wrong nickname, uncollected citations and scored abstention; empty search does not assign zero', async () => {
	const config = readLabConfig({
		LAB_ENABLED: 'true',
		LAB_MODEL_PROVIDER: 'ollama',
		LAB_MODEL: 'fixture',
		LAB_MODEL_URL: 'http://model.test',
	});
	const item: WorkItem = {
		input: labNicknameInput(nickname),
		provider: 'ollama',
		model: 'fixture',
		maxTokens: 256,
		temperature: 0,
		searchMode: 'backend_retrieval',
	};
	const search = { search: async () => [] };
	for (const change of [{ nickname: '다른닉네임' }, { sourceIds: ['S9'] }, { score: 0 }]) {
		vi.stubGlobal('fetch', () =>
			Response.json({ message: { content: JSON.stringify({ ...output, ...change }) } }),
		);
		expect((await evaluateCase(config, item, new AbortController().signal, 'supported', search)).error).toBe(
			'INVALID_MODEL_OUTPUT',
		);
	}
	vi.stubGlobal('fetch', () => Response.json({ message: { content: JSON.stringify(output) } }));
	expect(
		(await evaluateCase(config, item, new AbortController().signal, 'supported', search)).output,
	).toEqual(output);
});
