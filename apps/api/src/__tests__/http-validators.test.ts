import { describe, expect, it } from 'vitest';
import { matchesIfModifiedSince, parseHttpDate } from '../shared/http-validators.js';

describe('HTTP-date parsing', () => {
	const receivedAt = new Date('2026-08-14T12:00:00.000Z');

	it.each([
		['IMF-fixdate', 'Wed, 12 Aug 2026 01:02:03 GMT'],
		['RFC 850', 'Wednesday, 12-Aug-26 01:02:03 GMT'],
		['ANSI C asctime', 'Wed Aug 12 01:02:03 2026'],
	] as const)('strictly parses %s', (_format, value) => {
		expect(parseHttpDate(value, receivedAt)).toEqual(new Date('2026-08-12T01:02:03.000Z'));
	});

	it('accepts the required leading day padding in an asctime date', () => {
		expect(parseHttpDate('Thu Aug  6 01:02:03 2026', receivedAt))
			.toEqual(new Date('2026-08-06T01:02:03.000Z'));
	});

	it.each([
		'Wed, 31 Feb 2026 01:02:03 GMT',
		'Wednesday, 31-Feb-26 01:02:03 GMT',
		'Wed Feb 31 01:02:03 2026',
		'Wed, 12 Aug 2026 24:00:00 GMT',
		'Wednesday, 12-Aug-26 01:60:03 GMT',
		'Wed Aug 12 01:02:60 2026',
	])('rejects an invalid calendar or time value: %s', (value) => {
		expect(parseHttpDate(value, receivedAt)).toBeUndefined();
	});

	it.each([
		'Thu, 12 Aug 2026 01:02:03 GMT',
		'Thursday, 12-Aug-26 01:02:03 GMT',
		'Thu Aug 12 01:02:03 2026',
	])('rejects a mismatching weekday: %s', (value) => {
		expect(parseHttpDate(value, receivedAt)).toBeUndefined();
	});

	it.each([
		'Wed, 12 Aug 2026 01:02:03 GMT trailing',
		'Wednesday, 12-Aug-26 01:02:03 GMT ',
		'Wed  Aug 12 01:02:03 2026',
		'Wed Aug  12 01:02:03 2026',
		'Wed Aug 6 01:02:03 2026',
	])('rejects trailing characters or nonconforming spaces: %s', (value) => {
		expect(parseHttpDate(value, receivedAt)).toBeUndefined();
	});

	it('keeps an RFC 850 timestamp exactly 50 years ahead in the future century', () => {
		expect(parseHttpDate('Friday, 14-Aug-76 12:00:00 GMT', receivedAt))
			.toEqual(new Date('2076-08-14T12:00:00.000Z'));
	});

	it('maps an RFC 850 timestamp over 50 years ahead to the latest matching past year', () => {
		expect(parseHttpDate('Sunday, 15-Aug-76 12:00:00 GMT', receivedAt))
			.toEqual(new Date('1976-08-15T12:00:00.000Z'));
	});

	it('lets existing conditional-date matching consume an obsolete date unchanged', () => {
		expect(matchesIfModifiedSince(
			'Wed Aug 12 01:02:03 2026',
			new Date('2026-08-12T01:02:03.999Z'),
		)).toBe(true);
	});
});
