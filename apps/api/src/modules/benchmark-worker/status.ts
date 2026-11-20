import { z } from 'zod';
import { generateLimits, type LabConfig } from './config.js';
import { jsonHeaders, LabFailure, requestJson } from './http.js';

export type ToolSupport = 'supported' | 'unsupported' | 'unknown';
type Availability = 'available' | 'unavailable' | 'unknown';

export async function readGenerateHealth(config: LabConfig, signal: AbortSignal) {
	const raw = await requestJson(
		`${config.modelUrl}/health`,
		{ headers: jsonHeaders(config.apiKey), signal },
		8192,
	);
	const health = z
		.object({
			ok: z.literal(true),
			model: z.literal(config.model),
			busy: z.boolean(),
			max_input_tokens: z.number().int().min(generateLimits.maxInputTokens),
			max_output_tokens: z.number().int().min(generateLimits.maxOutputTokens),
		})
		.safeParse(raw);
	if (!health.success) throw new LabFailure('MODEL_HEALTH_MISMATCH');
	return health.data;
}

async function modelStatus(
	config: LabConfig,
): Promise<{ modelStatus: Availability; toolSupport: ToolSupport }> {
	const unknown: { modelStatus: Availability; toolSupport: ToolSupport } = {
		modelStatus: 'unavailable',
		toolSupport: config.provider === 'transformers-generate' ? 'unsupported' : 'unknown',
	};
	if (!config.modelUrl || !config.model) return unknown;
	const options = { headers: jsonHeaders(config.apiKey), signal: AbortSignal.timeout(2500) };
	try {
		if (config.provider === 'transformers-generate') {
			await readGenerateHealth(config, options.signal);
			return { modelStatus: 'available', toolSupport: 'unsupported' };
		}
		if (config.provider === 'ollama') {
			const raw = await requestJson(
				`${config.modelUrl}/api/show`,
				{
					...options,
					method: 'POST',
					body: JSON.stringify({ model: config.model }),
				},
				512_000,
			);
			const { capabilities } = z.object({ capabilities: z.array(z.string()).optional() }).parse(raw);
			return {
				modelStatus: 'available',
				toolSupport: capabilities ? (capabilities.includes('tools') ? 'supported' : 'unsupported') : 'unknown',
			};
		}
		const raw = await requestJson(`${config.modelUrl}/models`, options, 128_000);
		const models = z.object({ data: z.array(z.object({ id: z.string() })) }).parse(raw);
		return {
			modelStatus: models.data.some(({ id }) => id === config.model) ? 'available' : 'unavailable',
			toolSupport: 'unknown',
		};
	} catch {
		return unknown;
	}
}

async function searchStatus(config: LabConfig): Promise<Availability> {
	if (!config.searchUrl) return 'unavailable';
	try {
		// Read instance metadata without submitting a search or requiring any query text.
		const info = await requestJson(
			`${config.searchUrl}/config`,
			{ signal: AbortSignal.timeout(2500) },
			256_000,
		);
		const result = z
			.object({ engines: z.array(z.unknown()), formats: z.array(z.string()).optional() })
			.parse(info);
		return result.formats && !result.formats.includes('json') ? 'unavailable' : 'available';
	} catch {
		return 'unavailable';
	}
}

export function createLabStatus(config: LabConfig) {
	async function probe() {
		const base = {
			enabled: config.enabled,
			provider: config.provider,
			model: config.model,
			mock: false as const,
			...(config.provider === 'transformers-generate' ? { generationLimits: generateLimits } : {}),
		};
		if (!config.enabled)
			return {
				...base,
				modelStatus: 'unknown' as const,
				searchStatus: 'unknown' as const,
				toolSupport: 'unknown' as const,
			};
		const [model, search] = await Promise.all([modelStatus(config), searchStatus(config)]);
		return { ...base, ...model, searchStatus: search };
	}
	let expiresAt = 0;
	let cached: ReturnType<typeof probe> | undefined;
	return () => {
		if (!cached || Date.now() >= expiresAt) {
			expiresAt = Date.now() + 30_000;
			cached = probe();
		}
		return cached;
	};
}
