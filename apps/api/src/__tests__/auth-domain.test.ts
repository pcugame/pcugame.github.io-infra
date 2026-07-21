import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthService } from '../modules/auth/service.js';

const mocks = vi.hoisted(() => ({
	verifyIdToken: vi.fn(),
	upsertUserByGoogleSub: vi.fn(),
	createSession: vi.fn(),
	deleteSession: vi.fn(),
	testEnv: {
		GOOGLE_CLIENT_IDS: ['test-client-id'],
		ALLOWED_GOOGLE_HD: 'g.pcu.ac.kr',
		SESSION_ABSOLUTE_MS: 1_209_600_000,
	},
}));

describe('auth Google hosted domain handling', () => {
	function service(logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }) {
		return createAuthService({
			repository: {
				upsertUserByGoogleSub: mocks.upsertUserByGoogleSub,
				upsertDevUser: vi.fn(),
				createSession: mocks.createSession,
				deleteSession: mocks.deleteSession,
			},
			googleTokens: {
				verify: async (credential, audiences) => {
					const ticket = await mocks.verifyIdToken({ idToken: credential, audience: audiences });
					return ticket?.getPayload();
				},
			},
			clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
			generateSessionId: () => 'session-id',
			sessionAbsoluteMs: mocks.testEnv.SESSION_ABSOLUTE_MS,
			googleClientIds: mocks.testEnv.GOOGLE_CLIENT_IDS,
			allowedGoogleHostedDomain: mocks.testEnv.ALLOWED_GOOGLE_HD,
			logger,
		});
	}

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.testEnv.ALLOWED_GOOGLE_HD = 'g.pcu.ac.kr';
		mocks.upsertUserByGoogleSub.mockResolvedValue({
			id: 1,
			email: 'student@g.pcu.ac.kr',
			name: 'Student',
			role: 'USER',
			studentId: 'student',
		});
		mocks.createSession.mockResolvedValue({});
		mocks.deleteSession.mockResolvedValue({});
	});

	it('keeps invalid Google ID tokens as 401 UNAUTHORIZED', async () => {
		const authLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		mocks.verifyIdToken.mockRejectedValue(new Error('bad token'));
		await expect(service(authLogger).loginWithGoogle('bad-token')).rejects.toMatchObject({
			statusCode: 401,
			code: 'UNAUTHORIZED',
			message: 'Invalid Google token',
		});
		expect(mocks.upsertUserByGoogleSub).not.toHaveBeenCalled();
		expect(mocks.createSession).not.toHaveBeenCalled();
		expect(JSON.stringify(authLogger.error.mock.calls)).not.toContain('bad-token');
		expect(JSON.stringify(authLogger.error.mock.calls)).not.toContain('test-client-id');
	});

	it('returns 403 EMAIL_DOMAIN_NOT_ALLOWED for hosted domain mismatch', async () => {
		mocks.verifyIdToken.mockResolvedValue({
			getPayload: () => ({
				sub: 'google-sub',
				email: 'student@example.com',
				hd: 'example.com',
				name: 'Student',
				picture: '',
			}),
		});
		await expect(service().loginWithGoogle('valid-token-wrong-domain')).rejects.toMatchObject({
			statusCode: 403,
			code: 'EMAIL_DOMAIN_NOT_ALLOWED',
			message: 'Email domain not allowed',
		});
		expect(mocks.upsertUserByGoogleSub).not.toHaveBeenCalled();
		expect(mocks.createSession).not.toHaveBeenCalled();
	});

	it('does not write Google account identifiers to authentication logs', async () => {
		const authLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		mocks.verifyIdToken.mockResolvedValue({
			getPayload: () => ({
				sub: 'private-google-subject',
				email: 'student@g.pcu.ac.kr',
				hd: 'g.pcu.ac.kr',
				name: 'Student',
				picture: '',
			}),
		});

		await service(authLogger).loginWithGoogle('private-credential');

		const logs = JSON.stringify([
			...authLogger.info.mock.calls,
			...authLogger.warn.mock.calls,
			...authLogger.error.mock.calls,
		]);
		expect(logs).not.toContain('student@g.pcu.ac.kr');
		expect(logs).not.toContain('private-google-subject');
		expect(logs).not.toContain('private-credential');
	});
});
