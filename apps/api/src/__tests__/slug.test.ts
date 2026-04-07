import { describe, it, expect } from 'vitest';
import { toSlug } from '../shared/slug.js';

describe('toSlug', () => {
	it('converts basic English to lowercase with dashes', () => {
		expect(toSlug('Hello World')).toBe('hello-world');
	});

	it('romanizes Korean Hangul characters', () => {
		expect(toSlug('게임')).toBe('geim');
	});

	it('handles mixed Korean and English', () => {
		expect(toSlug('게임 Project')).toBe('geim-project');
	});

	it('strips special characters', () => {
		expect(toSlug('Hello! @World#')).toBe('hello-world');
	});

	it('collapses multiple spaces into a single dash', () => {
		expect(toSlug('a   b')).toBe('a-b');
	});

	it('collapses multiple dashes into one', () => {
		expect(toSlug('a---b')).toBe('a-b');
	});

	it('trims leading and trailing whitespace', () => {
		expect(toSlug('  hello  ')).toBe('hello');
	});

	it('truncates to 80 characters', () => {
		const long = 'a'.repeat(100);
		expect(toSlug(long).length).toBeLessThanOrEqual(80);
	});

	it('returns "untitled" when result is empty after processing', () => {
		expect(toSlug('!!!')).toBe('untitled');
	});

	it('returns "untitled" for empty string', () => {
		expect(toSlug('')).toBe('untitled');
	});

	it('preserves numbers', () => {
		expect(toSlug('Project 2025')).toBe('project-2025');
	});

	it('romanizes complex Hangul syllables', () => {
		// 졸 = ㅈ(j) + ㅗ(o) + ㄹ(l)
		// 업 = ㅇ('') + ㅓ(eo) + ㅂ(b)
		// 작 = ㅈ(j) + ㅏ(a) + ㄱ(k)
		// 품 = ㅍ(p) + ㅜ(u) + ㅁ(m)
		expect(toSlug('졸업작품')).toBe('joleobjakpum');
	});

	it('romanizes boundary character 가 (0xAC00)', () => {
		// 가 = ㄱ(g) + ㅏ(a) + (no final)
		expect(toSlug('가')).toBe('ga');
	});

	it('strips non-Hangul CJK characters (e.g. Japanese kanji)', () => {
		// 日本 are outside Hangul range, will be stripped
		expect(toSlug('日本')).toBe('untitled');
	});

	it('handles Hangul with final consonant', () => {
		// 한 = ㅎ(h) + ㅏ(a) + ㄴ(n)
		// 글 = ㄱ(g) + ㅡ(eu) + ㄹ(l)
		expect(toSlug('한글')).toBe('hangeul');
	});
});
