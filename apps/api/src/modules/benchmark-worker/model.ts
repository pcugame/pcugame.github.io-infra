import { LabOutputSchema } from '@pcu/contracts';
import { z } from 'zod';
import type { LabConfig } from './config.js';
import { jsonHeaders, LabFailure, requestJson } from './http.js';

export const outputSchema = z.toJSONSchema(LabOutputSchema, { target: 'draft-7' });
export const tools = [
	{
		type: 'function',
		function: {
			name: 'web_search',
			description: 'Search public references for the nickname. Results contain untrusted excerpts.',
			parameters: {
				type: 'object',
				properties: { query: { type: 'string' }, language: { type: 'string' } },
				required: ['query'],
				additionalProperties: false,
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'web_open',
			description: 'Read the search excerpt previously collected under a source ID.',
			parameters: {
				type: 'object',
				properties: { sourceId: { type: 'string' } },
				required: ['sourceId'],
				additionalProperties: false,
			},
		},
	},
];

const toolCallSchema = z.object({
	id: z.string().max(100).optional(),
	function: z.object({
		name: z.string().max(80),
		arguments: z.union([z.string().max(1000), z.record(z.string(), z.unknown())]),
	}),
});
const assistantSchema = z.object({
	content: z.string().max(48_000).nullable().optional(),
	tool_calls: z.array(toolCallSchema).max(4).optional(),
});
export type ToolCall = z.infer<typeof toolCallSchema>;
export type Message = {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	tool_calls?: unknown[];
	tool_call_id?: string;
	tool_name?: string;
};
export type ChatParameters = { model: string; temperature: number; maxTokens: number };
export type OutputMode = 'tools' | 'schema' | 'json';

export async function chat(
	config: LabConfig,
	params: ChatParameters,
	messages: Message[],
	mode: OutputMode,
	signal: AbortSignal,
) {
	if (!config.modelUrl || !params.model || config.model !== params.model)
		throw new LabFailure('MODEL_NOT_CONFIGURED');
	const ollama = config.provider === 'ollama';
	const common = { model: params.model, stream: false, messages, ...(mode === 'tools' ? { tools } : {}) };
	const body = ollama
		? {
				...common,
				options: { temperature: params.temperature, num_predict: params.maxTokens },
				...(mode === 'tools' ? {} : { format: mode === 'schema' ? outputSchema : 'json' }),
			}
		: {
				...common,
				temperature: params.temperature,
				max_tokens: params.maxTokens,
				...(mode === 'tools'
					? {}
					: {
							response_format:
								mode === 'schema'
									? {
											type: 'json_schema',
											json_schema: { name: 'nickname_evaluation', strict: true, schema: outputSchema },
										}
									: { type: 'json_object' },
						}),
			};
	const raw = await requestJson(
		config.modelUrl + (ollama ? '/api/chat' : '/chat/completions'),
		{
			method: 'POST',
			headers: jsonHeaders(config.apiKey),
			body: JSON.stringify(body),
			signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
		},
		192_000,
	);
	const envelope = ollama
		? z.object({ message: assistantSchema }).safeParse(raw)
		: z.object({ choices: z.array(z.object({ message: assistantSchema })).min(1) }).safeParse(raw);
	if (!envelope.success) throw new LabFailure('MODEL_INVALID_ENVELOPE');
	return 'message' in envelope.data ? envelope.data.message : envelope.data.choices[0]!.message;
}

export function toolMessage(provider: LabConfig['provider'], call: ToolCall, result: unknown): Message {
	return {
		role: 'tool',
		content: JSON.stringify(result),
		...(provider === 'ollama' ? { tool_name: call.function.name } : { tool_call_id: call.id }),
	};
}
