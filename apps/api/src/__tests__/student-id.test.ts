import { describe, it, expect } from 'vitest';
import { isDummyStudentId, sanitizeStudentId } from '../shared/student-id.js';

describe('isDummyStudentId', () => {
	it('detects known dummy IDs', () => {
		expect(isDummyStudentId('0000001')).toBe(true);
		expect(isDummyStudentId('0000002')).toBe(true);
		expect(isDummyStudentId('0000003')).toBe(true);
		expect(isDummyStudentId('0000004')).toBe(true);
		expect(isDummyStudentId('0000005')).toBe(true);
		expect(isDummyStudentId('0000006')).toBe(true);
	});

	it('does not flag real student IDs', () => {
		expect(isDummyStudentId('1588001')).toBe(false);
		expect(isDummyStudentId('1288001')).toBe(false);
		expect(isDummyStudentId('1488003')).toBe(false);
		expect(isDummyStudentId('1400000')).toBe(false);
	});

	it('does not flag empty or arbitrary strings', () => {
		expect(isDummyStudentId('')).toBe(false);
		expect(isDummyStudentId('0')).toBe(false);
		expect(isDummyStudentId('0000000')).toBe(false);
		expect(isDummyStudentId('0000007')).toBe(false);
	});
});

describe('sanitizeStudentId', () => {
	it('replaces dummy IDs with placeholder', () => {
		expect(sanitizeStudentId('0000001')).toBe('?');
		expect(sanitizeStudentId('0000006')).toBe('?');
	});

	it('passes real IDs through unchanged', () => {
		expect(sanitizeStudentId('1588001')).toBe('1588001');
		expect(sanitizeStudentId('1400000')).toBe('1400000');
	});
});
