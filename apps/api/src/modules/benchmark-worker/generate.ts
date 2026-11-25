import {
	labNicknameInput,
	type LabNicknameInput,
	type LabSource,
} from '@pcu/contracts';
import { scheduler } from 'node:timers/promises';
import { z } from 'zod';
import type { LabConfig } from './config.js';
import { jsonHeaders, LabFailure, requestJson } from './http.js';
import { readGenerateHealth } from './status.js';

// Keep the exact prompt and case intact. Bound quoted evidence to leave room in the 1,024-token context.
export function generateEvidence(sources: LabSource[]) {
	const evidence: LabSource[] = [];
	let bytes = 0;
	for (const source of sources) {
		const excerpt = {
			...source,
			title: Array.from(source.title).slice(0, 80).join(''),
			snippet: Array.from(source.snippet).slice(0, 180).join(''),
		};
		const size = Buffer.byteLength(JSON.stringify(excerpt));
		if (bytes + size > 1300) continue;
		evidence.push(excerpt);
		bytes += size;
		if (evidence.length === 2) break;
	}
	return evidence;
}

export function generateNicknamePrompt(input: LabNicknameInput, sources: LabSource[]) {
	return JSON.stringify({ case: labNicknameInput(input.nickname), sources });
}

export async function generateText(
	config: LabConfig,
	systemPrompt: string,
	prompt: string,
	maxTokens: number,
	signal: AbortSignal,
) {
	if (!config.modelUrl) throw new LabFailure('MODEL_NOT_CONFIGURED');
	// /generate cannot select a model. Check the identity before every inference.
	for (let poll = 0; ; poll++) {
		signal.throwIfAborted();
		const health = await readGenerateHealth(config, AbortSignal.any([signal, AbortSignal.timeout(2500)]));
		if (!health.busy) break;
		if (poll === 3) throw new LabFailure('MODEL_BUSY', true);
		await scheduler.wait(10_000, { signal });
	}
	const body = JSON.stringify({ prompt, system_prompt: systemPrompt, max_new_tokens: maxTokens });
	if (Buffer.byteLength(body) > 32768) throw new LabFailure('MODEL_INPUT_TOO_LARGE');
	const raw = await requestJson(
		config.modelUrl + '/generate',
		{
			method: 'POST',
			headers: jsonHeaders(config.apiKey),
			body,
			signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
		},
		192000,
	);
	const parsed = z
		.object({
			text: z.string().max(48000),
      finish_reason: z.string().optional(),
			input_tokens: z.number().int().positive(),
			output_tokens: z.number().int().nonnegative(),
			seconds: z.number().nonnegative(),
		})
		.safeParse(raw);
	if (!parsed.success) throw new LabFailure('MODEL_INVALID_ENVELOPE');
	const { text, input_tokens: inputTokens, output_tokens: outputTokens, seconds } = parsed.data;
	// Some unconstrained servers wrap a complete JSON document in one Markdown block.
	// Keep raw-format fidelity observable; the caller validates the entire enclosed value.
	const fence = /^```json[ \t]*\r?\n([\s\S]+?)\r?\n```$/i.exec(text.trim());
	return {
		content: fence ? fence[1]! : text,
    rawContent: text,
    finishReason: parsed.data.finish_reason ?? (outputTokens >= maxTokens ? 'length' : 'unknown'),
		usage: { inputTokens, outputTokens, seconds, jsonFenceRemoved: !!fence },
		tool_calls: undefined,
	};
}
