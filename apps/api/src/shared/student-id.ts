/**
 * Dummy student-ID guard — pre-migration output sanitisation.
 *
 * Known dummy values were imported from legacy 2020 data
 * (see server/legacy_example_2020_projects.json).
 *
 * This module is intentionally conservative: only the exact known
 * placeholder values are matched.  Do NOT broaden the set without
 * evidence from the actual data.
 *
 * TODO: remove after the data-cleanup migration replaces dummy values
 *       in the database itself.
 */

const DUMMY_STUDENT_IDS: ReadonlySet<string> = new Set([
	'0000001',
	'0000002',
	'0000003',
	'0000004',
	'0000005',
	'0000006',
]);

const PUBLIC_PLACEHOLDER = '?';

/** Returns `true` when the value is a known legacy placeholder. */
export function isDummyStudentId(studentId: string): boolean {
	return DUMMY_STUDENT_IDS.has(studentId);
}

/**
 * For public-facing output only.
 * Real IDs pass through unchanged; dummy IDs become `PUBLIC_PLACEHOLDER`.
 */
export function sanitizeStudentId(studentId: string): string {
	return isDummyStudentId(studentId) ? PUBLIC_PLACEHOLDER : studentId;
}
