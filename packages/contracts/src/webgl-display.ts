import { z } from 'zod';

/** CSS display pixels; independent of Unity rendering resolution. */
export const MAX_WEBGL_DISPLAY_SIZE = 8192;
export const WebglDisplayDimensionSchema = z.number().int().min(1).max(MAX_WEBGL_DISPLAY_SIZE);
export const WebglDisplayModeSchema = z.enum(['auto', 'manual', 'legacy']);
export const WebglDisplayKindSchema = z.enum(['fixed', 'responsive', 'legacy']);
export const WebglDisplayAnalysisSchema = z.object({
	version: z.literal(1),
	kind: z.enum(['fixed', 'responsive', 'unknown']),
	width: WebglDisplayDimensionSchema.nullable(),
	height: WebglDisplayDimensionSchema.nullable(),
	reason: z.string().nullable(),
}).strict().refine((value) => value.kind === 'fixed'
	? value.width !== null && value.height !== null
	: value.width === null && value.height === null, { message: 'Only fixed analysis may contain dimensions' });
export type WebglDisplayAnalysis = z.infer<typeof WebglDisplayAnalysisSchema>;
export type WebglDisplayMode = z.infer<typeof WebglDisplayModeSchema>;
export const WebglEffectiveDisplaySchema = z.object({
	kind: WebglDisplayKindSchema,
	width: WebglDisplayDimensionSchema.nullable(),
	height: WebglDisplayDimensionSchema.nullable(),
}).strict().refine((value) => value.kind === 'fixed'
	? value.width !== null && value.height !== null
	: value.width === null && value.height === null, { message: 'Only fixed display may contain dimensions' });
export type WebglEffectiveDisplay = z.infer<typeof WebglEffectiveDisplaySchema>;
export const WebglDisplaySettingsSchema = z.object({
	webglDisplayMode: WebglDisplayModeSchema.optional(),
	webglDisplayWidth: WebglDisplayDimensionSchema.nullable(),
	webglDisplayHeight: WebglDisplayDimensionSchema.nullable(),
}).strict().refine((value) => (value.webglDisplayWidth === null) === (value.webglDisplayHeight === null), {
	message: 'Width and height must be configured or cleared together', path: ['webglDisplayHeight'],
}).refine((value) => value.webglDisplayMode !== 'manual' || value.webglDisplayWidth !== null, {
	message: 'Manual display requires width and height', path: ['webglDisplayWidth'],
});
export type WebglDisplaySettings = z.infer<typeof WebglDisplaySettingsSchema>;
export const WebglDisplaySettingsResponseSchema = z.object({
	webglDisplayMode: WebglDisplayModeSchema,
	webglDisplayWidth: WebglDisplayDimensionSchema.nullable(),
	webglDisplayHeight: WebglDisplayDimensionSchema.nullable(),
	analysis: WebglDisplayAnalysisSchema.nullable(),
	effective: WebglEffectiveDisplaySchema,
}).strict();
export type WebglDisplaySettingsResponse = z.infer<typeof WebglDisplaySettingsResponseSchema>;
export function inferWebglDisplayMode(settings: WebglDisplaySettings): WebglDisplayMode {
	return settings.webglDisplayMode ?? (settings.webglDisplayWidth !== null && settings.webglDisplayHeight !== null ? 'manual' : 'legacy');
}
/** Accept unknown persisted JSON defensively; null means no analysis has been stored. */
export function parseWebglDisplayAnalysis(analysis: unknown): WebglDisplayAnalysis | null {
	const parsed = WebglDisplayAnalysisSchema.safeParse(analysis);
	return parsed.success ? parsed.data : null;
}
export function resolveWebglDisplay(settings: {
	webglDisplayMode?: WebglDisplayMode;
	webglDisplayWidth?: number | null;
	webglDisplayHeight?: number | null;
	analysis?: unknown;
}): WebglEffectiveDisplay {
	const width = settings.webglDisplayWidth ?? null, height = settings.webglDisplayHeight ?? null;
	const mode = inferWebglDisplayMode({ ...settings, webglDisplayWidth: width, webglDisplayHeight: height });
	if (mode === 'manual' && WebglDisplayDimensionSchema.safeParse(width).success && WebglDisplayDimensionSchema.safeParse(height).success)
		return { kind: 'fixed', width, height };
	if (mode === 'auto') {
		const analysis = parseWebglDisplayAnalysis(settings.analysis);
		if (analysis?.kind === 'fixed') return { kind: 'fixed', width: analysis.width, height: analysis.height };
		if (analysis?.kind === 'responsive') return { kind: 'responsive', width: null, height: null };
	}
	return { kind: 'legacy', width: null, height: null };
}
