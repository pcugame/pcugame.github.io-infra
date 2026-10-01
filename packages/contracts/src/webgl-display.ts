import { z } from 'zod';

/** CSS display pixels; independent of Unity rendering resolution. */
export const MAX_WEBGL_DISPLAY_SIZE = 8192;
export const WebglDisplayDimensionSchema = z.number().int().min(1).max(MAX_WEBGL_DISPLAY_SIZE);
export const WebglDisplaySettingsSchema = z.object({
	webglDisplayWidth: WebglDisplayDimensionSchema.nullable(),
	webglDisplayHeight: WebglDisplayDimensionSchema.nullable(),
}).strict().refine((value) => (value.webglDisplayWidth === null) === (value.webglDisplayHeight === null), {
	message: 'Width and height must be configured or cleared together',
	path: ['webglDisplayHeight'],
});
export type WebglDisplaySettings = z.infer<typeof WebglDisplaySettingsSchema>;
