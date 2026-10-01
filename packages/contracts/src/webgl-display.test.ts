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

import { inferWebglDisplayMode, resolveWebglDisplay, WebglDisplayAnalysisSchema } from './webgl-display.js';
describe('WebGL display resolution', () => {
	const fixed = { version: 1, kind: 'fixed', width: 960, height: 600, reason: null };
	const settings = { webglDisplayWidth: 1280, webglDisplayHeight: 720 };
	it('keeps old payload behavior and resolves manual before automatic analysis', () => {
		expect(inferWebglDisplayMode(settings)).toBe('manual');
		expect(inferWebglDisplayMode({ webglDisplayWidth: null, webglDisplayHeight: null })).toBe('legacy');
		expect(resolveWebglDisplay({ ...settings, webglDisplayMode: 'manual', analysis: fixed })).toEqual({ kind: 'fixed', width: 1280, height: 720 });
		expect(resolveWebglDisplay({ ...settings, webglDisplayMode: 'auto', analysis: fixed })).toEqual({ kind: 'fixed', width: 960, height: 600 });
	});
	it('resolves responsive, unknown, missing and invalid analyses conservatively', () => {
		expect(resolveWebglDisplay({ webglDisplayMode: 'auto', analysis: { version: 1, kind: 'responsive', width: null, height: null, reason: null } })).toEqual({ kind: 'responsive', width: null, height: null });
		for (const analysis of [null, { version: 1, kind: 'unknown', width: null, height: null, reason: 'Ambiguous template' }, { ...fixed, width: 9000 }])
			expect(resolveWebglDisplay({ webglDisplayMode: 'auto', analysis })).toEqual({ kind: 'legacy', width: null, height: null });
		expect(resolveWebglDisplay({ ...settings, webglDisplayMode: 'legacy', analysis: fixed })).toEqual({ kind: 'legacy', width: null, height: null });
		expect(WebglDisplayAnalysisSchema.safeParse({ ...fixed, height: null }).success).toBe(false);
	});
	it('requires manual dimensions while allowing retained dimensions in auto and legacy', () => {
		expect(WebglDisplaySettingsSchema.safeParse({ webglDisplayMode: 'manual', webglDisplayWidth: null, webglDisplayHeight: null }).success).toBe(false);
		for (const webglDisplayMode of ['auto', 'legacy']) expect(WebglDisplaySettingsSchema.safeParse({ ...settings, webglDisplayMode }).success).toBe(true);
	});
});
