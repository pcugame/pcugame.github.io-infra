import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatEnvIssues } from '../config/env.js';

/**
 * M6 — Zod env-validation error formatting.
 *
 * The priority is that no *value* from the env payload ever reaches stderr —
 * some env vars are secrets (SESSION_SECRET, S3_SECRET_ACCESS_KEY, …), and a
 * Zod default message for e.g. `invalid_enum_value` interpolates the received
 * value. So the formatter is built to use only `issue.path` and `issue.code`,
 * never `issue.message`, and these tests lock that in.
 */
describe('formatEnvIssues', () => {
	it('renders path and a code-derived hint, one line per issue', () => {
		const schema = z.object({
			DATABASE_URL: z.string().url(),
			SESSION_SECRET: z.string().min(32),
		});
		// Use sentinels that don't substring-match any word in the fixed-phrase hints
		// ("is not a valid string…", "is shorter or smaller…", etc.) so an accidental
		// leak would still be detectable in this assertion.
		const dbSentinel = 'S3NTINEL_DB_VAL';
		const sessionSentinel = 'S3NTINEL_SESSION_VAL';
		const result = schema.safeParse({
			DATABASE_URL: dbSentinel,
			SESSION_SECRET: sessionSentinel,
		});
		expect(result.success).toBe(false);
		const lines = formatEnvIssues(result.error!.issues);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/DATABASE_URL:/);
		expect(lines[1]).toMatch(/SESSION_SECRET:/);
		const joined = lines.join('\n');
		expect(joined).not.toContain(dbSentinel);
		expect(joined).not.toContain(sessionSentinel);
	});

	it('never leaks the received value, even for enum mismatches', () => {
		// invalid_enum_value is the worst offender — Zod's default message is
		// "Invalid enum value. Expected 'a' | 'b', received 'SECRET_TOKEN'".
		const schema = z.object({
			LOG_LEVEL: z.enum(['info', 'warn', 'error']),
		});
		const result = schema.safeParse({ LOG_LEVEL: 'SECRET_TOKEN' });
		expect(result.success).toBe(false);
		const lines = formatEnvIssues(result.error!.issues);
		expect(lines.join('\n')).not.toContain('SECRET_TOKEN');
		expect(lines[0]).toContain('LOG_LEVEL');
		expect(lines[0]).toContain('must be one of the allowed values');
	});

	it('falls back to a generic hint for unknown codes', () => {
		const schema = z.object({
			THING: z.string().refine(() => false, { message: 'S3NTINEL_REFINE_MSG' }),
		});
		const result = schema.safeParse({ THING: 'S3NTINEL_THING_VAL' });
		const lines = formatEnvIssues(result.error!.issues);
		expect(lines[0]).toContain('THING');
		// The "custom" code has a dedicated hint; refine-with-false lands on "custom".
		expect(lines[0]).toContain('failed a custom validation rule');
		const joined = lines.join('\n');
		expect(joined).not.toContain('S3NTINEL_REFINE_MSG');
		expect(joined).not.toContain('S3NTINEL_THING_VAL');
	});

	it('handles missing required fields without touching received values', () => {
		const schema = z.object({
			SESSION_SECRET: z.string().min(32),
		});
		const result = schema.safeParse({});
		const lines = formatEnvIssues(result.error!.issues);
		expect(lines[0]).toContain('SESSION_SECRET');
		expect(lines[0]).toContain('is missing or has the wrong type');
	});
});
