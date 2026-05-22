import { describe, expect, it } from 'vitest';
import { matchesSearch } from '../lib/utils';

describe('matchesSearch', () => {
	it('matches while ignoring spaces', () => {
		expect(matchesSearch(['스마트 전시 플랫폼'], '스마트전시')).toBe(true);
	});

	it('matches partial student ids', () => {
		expect(matchesSearch(['홍길동', '2024014'], '014')).toBe(true);
	});

	it('matches tokens across project fields', () => {
		expect(matchesSearch(['공간 시뮬레이터', '김민수', '2024014'], '김민 014')).toBe(true);
	});
});
