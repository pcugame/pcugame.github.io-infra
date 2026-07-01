import type { UserRole } from './enums.js';

/** POST /api/auth/google - request */
export type GoogleAuthRequest = {
	credential: string;
};

/** Authenticated user */
export type AuthUser = {
	id: number;
	email: string;
	name: string;
	role: UserRole;
	studentId?: string;
};

/** POST /api/auth/google - response (data envelope stripped) */
export type GoogleAuthResponse = {
	user: AuthUser;
};

export type DevAuthLoginRequest = {
	role: UserRole;
};

export type DevAuthErrorScenario =
	| 'domain-not-allowed'
	| 'google-api-unavailable'
	| 'invalid-google-token'
	| 'missing-google-payload'
	| 'api-server-error';

export type DevAuthLoginErrorRequest = {
	scenario: DevAuthErrorScenario;
};

export type ApiErrorCode =
	| 'ERROR'
	| 'VALIDATION_ERROR'
	| 'UNAUTHORIZED'
	| 'EMAIL_DOMAIN_NOT_ALLOWED'
	| 'GOOGLE_API_UNAVAILABLE'
	| 'FORBIDDEN'
	| 'NOT_FOUND'
	| 'CONFLICT'
	| 'PAYLOAD_TOO_LARGE'
	| 'UNSUPPORTED_MEDIA_TYPE'
	| 'RATE_LIMITED'
	| 'TOO_MANY_UPLOADS'
	| 'USER_SUBMIT_FORBIDDEN_FIELD'
	| 'DRAINING'
	| 'INTERNAL_ERROR'
	| 'SIZE_MISMATCH';

/** POST /api/auth/logout - response */
export type LogoutResponse = { message: string };

/** GET /api/me - response */
export type MeResponse =
	| { authenticated: false }
	| { authenticated: true; user: AuthUser };
