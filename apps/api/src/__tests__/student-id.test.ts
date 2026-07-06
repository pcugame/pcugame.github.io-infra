import { describe, expect, it } from 'vitest';
import { extractStudentIdFromEmail } from '../modules/auth/student-id.js';

describe('extractStudentIdFromEmail', () => {
	it('extracts numeric student ids from the email local part', () => {
		expect(extractStudentIdFromEmail('20260001@pcu.ac.kr')).toBe('20260001');
	});

	it('trims the local part before validation', () => {
		expect(extractStudentIdFromEmail(' 20260001 @pcu.ac.kr')).toBe('20260001');
	});

	it.each([
		'student@pcu.ac.kr',
		'12345@pcu.ac.kr',
		'123456789012345678901@pcu.ac.kr',
		'2026-0001@pcu.ac.kr',
		'@pcu.ac.kr',
	])('returns undefined for non-student-id email %s', (email) => {
		expect(extractStudentIdFromEmail(email)).toBeUndefined();
	});
});
