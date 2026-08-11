import { describe, expect, it } from 'vitest';
import { normalizeWebglRequestPath, parseSingleByteRange } from '../modules/public/webgl.service.js';

describe('WebGL request path and range parsing', () => {
	it('rejects traversal and backslash traversal after URL decoding', () => {
		expect(() => normalizeWebglRequestPath('../source.zip')).toThrow('Invalid WebGL asset path');
		expect(() => normalizeWebglRequestPath('Build\\..\\source.zip')).toThrow('Invalid WebGL asset path');
	});

	it('supports open and suffix byte ranges', () => {
		expect(parseSingleByteRange('bytes=4-', 10)).toEqual({ start: 4, end: 9 });
		expect(parseSingleByteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
		expect(parseSingleByteRange('bytes=10-', 10)).toBe('invalid');
	});
});
