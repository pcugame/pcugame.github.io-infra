import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('google-auth-library', () => ({
	OAuth2Client: vi.fn(function OAuth2Client() {
		return {
			verifyIdToken: mocks.verifyIdToken,
		};
	}),
}));

vi.mock('../config/env.js', () => ({
	env: () => mocks.testEnv,
	loadEnv: () => mocks.testEnv,
}));

vi.mock('../lib/logger.js', () => ({
	logger: () => ({
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	}),
}));

vi.mock('../modules/auth/repository.js', () => ({
	upsertUserByGoogleSub: mocks.upsertUserByGoogleSub,
	createSession: mocks.createSession,
	deleteSession: mocks.deleteSession,
}));

describe('auth Google hosted domain handling', () => {
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
		mocks.verifyIdToken.mockRejectedValue(new Error('bad token'));
		const { loginWithGoogle } = await import('../modules/auth/service.js');

		await expect(loginWithGoogle('bad-token')).rejects.toMatchObject({
			statusCode: 401,
			code: 'UNAUTHORIZED',
			message: 'Invalid Google token',
		});
		expect(mocks.upsertUserByGoogleSub).not.toHaveBeenCalled();
		expect(mocks.createSession).not.toHaveBeenCalled();
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
		const { loginWithGoogle } = await import('../modules/auth/service.js');

		await expect(loginWithGoogle('valid-token-wrong-domain')).rejects.toMatchObject({
			statusCode: 403,
			code: 'EMAIL_DOMAIN_NOT_ALLOWED',
			message: 'Email domain not allowed',
		});
		expect(mocks.upsertUserByGoogleSub).not.toHaveBeenCalled();
		expect(mocks.createSession).not.toHaveBeenCalled();
	});
});
