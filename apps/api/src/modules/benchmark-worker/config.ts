export interface LabConfig {
	enabled: boolean;
	provider: 'ollama' | 'openai-compatible' | 'transformers-generate';
	model: string;
	modelUrl?: string;
	apiKey?: string;
	searchUrl?: string;
	concurrency: number;
}

type LabEnvironment = Partial<
	Record<
		| 'LAB_ENABLED'
		| 'LAB_MODEL_PROVIDER'
		| 'LAB_MODEL'
		| 'LAB_MODEL_URL'
		| 'LAB_MODEL_API_KEY'
		| 'LAB_SEARXNG_URL'
		| 'LAB_CONCURRENCY',
		string
	>
>;

// Enabled during explicit lab activation. Unused settings cannot block site startup.
export function readLabConfig(env: LabEnvironment = process.env): LabConfig {
	const disabled: LabConfig = { enabled: false, provider: 'ollama', model: '', concurrency: 1 };
	if (env.LAB_ENABLED !== 'true') return disabled;

	const provider = env.LAB_MODEL_PROVIDER || 'ollama';
	if (provider !== 'ollama' && provider !== 'openai-compatible' && provider !== 'transformers-generate')
		throw new Error('Invalid LAB_MODEL_PROVIDER');
	const concurrency = Number(env.LAB_CONCURRENCY ?? 1);
	if (
		!Number.isInteger(concurrency) ||
		concurrency < 1 ||
		concurrency > (provider === 'transformers-generate' ? 1 : 4)
	)
		throw new Error('Invalid LAB_CONCURRENCY');
	const model = env.LAB_MODEL?.trim() ?? '';
	if (model.length > 200) throw new Error('Invalid LAB_MODEL');
	return {
		enabled: true,
		provider,
		model,
		concurrency,
		modelUrl: endpoint(env.LAB_MODEL_URL),
		apiKey: env.LAB_MODEL_API_KEY,
		searchUrl: endpoint(env.LAB_SEARXNG_URL),
	};
}

function endpoint(value?: string) {
	if (!value) return undefined;
	const url = URL.parse(value);
	if (
		!url ||
		!['http:', 'https:'].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error('Lab endpoints require an HTTP(S) base URL without credentials, query or fragment');
	}
	return url.href.replace(/\/+$/, '');
}

// Wire profile of the archive's single-slot Transformers /generate service.
export const generateLimits = { fixedTemperature: 0, maxInputTokens: 1024, maxOutputTokens: 256 } as const;

export function invalidGenerateSetting(settings: {
	temperature: number;
	maxTokens: number;
	searchMode: string;
}) {
	if (settings.searchMode === 'model_tool_call') return 'MODEL_TOOLS_UNSUPPORTED';
	if (settings.temperature !== generateLimits.fixedTemperature) return 'MODEL_REQUIRES_GREEDY_DECODING';
	if (settings.maxTokens > generateLimits.maxOutputTokens) return 'MODEL_OUTPUT_TOKEN_LIMIT';
	return null;
}
