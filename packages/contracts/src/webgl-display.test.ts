import { describe, expect, it } from 'vitest';
import { MAX_WEBGL_DISPLAY_SIZE, WebglDisplaySettingsSchema } from './webgl-display.js';

describe('WebGL CSS display pair', () => {
	it('accepts clearing and positive integer boundaries', () => {
		for (const value of [null, 1, 1280, MAX_WEBGL_DISPLAY_SIZE]) {
			expect(WebglDisplaySettingsSchema.safeParse({ webglDisplayWidth: value, webglDisplayHeight: value }).success).toBe(true);
		}
	});
	it('rejects missing and mixed dimensions, coercion and invalid bounds', () => {
		for (const value of [undefined, 0, -1, 0.5, 8193, '800', Infinity, NaN]) {
			expect(WebglDisplaySettingsSchema.safeParse({ webglDisplayWidth: value, webglDisplayHeight: 600 }).success).toBe(false);
			expect(WebglDisplaySettingsSchema.safeParse({ webglDisplayWidth: 800, webglDisplayHeight: value }).success).toBe(false);
		}
		expect(WebglDisplaySettingsSchema.safeParse({ webglDisplayWidth: null, webglDisplayHeight: 600 }).success).toBe(false);
		expect(WebglDisplaySettingsSchema.safeParse({ webglDisplayWidth: 800, webglDisplayHeight: null }).success).toBe(false);
	});
});
