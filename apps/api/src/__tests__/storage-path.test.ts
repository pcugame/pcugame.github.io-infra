import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { generateStorageKey, buildStoragePath } from '../shared/storage-path.js';

describe('generateStorageKey', () => {
	it('returns UUID.ext format for a normal extension', () => {
		const key = generateStorageKey('png');
		expect(key).toMatch(/^[0-9a-f-]{36}\.png$/);
	});

	it('strips non-alphanumeric characters from extension', () => {
		const key = generateStorageKey('.p.n"g');
		// Only alphanumeric chars remain
		expect(key).toMatch(/^[0-9a-f-]{36}\.png$/);
	});

	it('sanitizes path traversal attempts in extension', () => {
		const key = generateStorageKey('../../etc/passwd');
		// Only 'etcpasswd' survives the sanitization
		expect(key).toMatch(/^[0-9a-f-]{36}\.etcpasswd$/);
		expect(key).not.toContain('..');
		expect(key).not.toContain('/');
	});

	it('handles empty extension', () => {
		const key = generateStorageKey('');
		expect(key).toMatch(/^[0-9a-f-]{36}\.$/);
	});

	it('produces unique keys on successive calls', () => {
		const a = generateStorageKey('png');
		const b = generateStorageKey('png');
		expect(a).not.toBe(b);
	});
});

describe('buildStoragePath', () => {
	it('uses first 2 chars of storageKey as subdirectory', () => {
		const result = buildStoragePath('/data', 'ab123.png');
		expect(result).toBe(path.resolve('/data', 'ab', 'ab123.png'));
	});

	it('resolves to an absolute path under root', () => {
		const result = buildStoragePath('/data', 'xy999.jpg');
		expect(result.startsWith(path.resolve('/data'))).toBe(true);
	});

	it('throws on path traversal with ../', () => {
		expect(() => buildStoragePath('/data', '../etc/passwd')).toThrow('Path traversal detected');
	});

	it('handles storageKey with slash by resolving within root', () => {
		// 'aa/../../etc/passwd' on Windows resolves to root's sibling — guard catches it
		// On some OS the resolve stays within root. Test the actual guard logic:
		const result = buildStoragePath('/data', 'aa/bb.png');
		expect(result.startsWith(path.resolve('/data'))).toBe(true);
	});
});
