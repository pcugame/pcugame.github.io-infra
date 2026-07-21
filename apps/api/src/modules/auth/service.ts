import type { UserRole } from '@pcu/contracts';
import type { Clock, GoogleTokenVerifier } from '../../application/ports.js';
import { API_ERROR_CODES, forbidden, unauthorized } from '../../shared/errors.js';
import { extractStudentIdFromEmail } from './student-id.js';

export interface AuthUserRecord {
	id: number;
	email: string;
	name: string;
	role: UserRole;
	studentId: string | null;
}

export interface AuthRepository {
	upsertUserByGoogleSub(data: {
		googleSub: string;
		email: string;
		name: string;
		picture: string;
		studentId?: string;
	}): Promise<AuthUserRecord>;
	upsertDevUser(data: {
		googleSub: string;
		email: string;
		name: string;
		role: UserRole;
		studentId?: string | null;
	}): Promise<AuthUserRecord>;
	createSession(data: { id: string; userId: number; expiresAt: Date }): Promise<unknown>;
	deleteSession(id: string): Promise<unknown>;
}

export interface AuthServiceLogger {
	info(context: Record<string, unknown>, message: string): void;
	warn(context: Record<string, unknown>, message: string): void;
	error(context: Record<string, unknown>, message: string): void;
}

const DEV_AUTH_USERS: Record<UserRole, {
	googleSub: string;
	email: string;
	name: string;
	studentId?: string;
}> = {
	USER: {
		googleSub: 'dev-auth-user',
		email: 'student@test.pcu.ac.kr',
		name: 'Integration Student',
		studentId: '20260001',
	},
	OPERATOR: {
		googleSub: 'dev-auth-operator',
		email: 'operator@test.pcu.ac.kr',
		name: 'Integration Operator',
	},
	ADMIN: {
		googleSub: 'dev-auth-admin',
		email: 'admin@test.pcu.ac.kr',
		name: 'Integration Admin',
	},
};

const DEPT_SUFFIXES = /(?:소프트웨어공학부|게임공학전공|게임공학과|컴퓨터공학과|정보통신공학과|공학부|공학과|학부|학과|전공)$/;

export function stripDeptSuffix(name: string): string {
	const stripped = name.replace(DEPT_SUFFIXES, '');
	return stripped || name;
}

export function createAuthService(deps: {
	repository: AuthRepository;
	googleTokens: GoogleTokenVerifier;
	clock: Clock;
	generateSessionId: () => string;
	sessionAbsoluteMs: number;
	googleClientIds: string[];
	allowedGoogleHostedDomain: string;
	logger: AuthServiceLogger;
}) {
	async function createSessionForUser(userId: number) {
		const sessionId = deps.generateSessionId();
		const expiresAt = new Date(deps.clock.now().getTime() + deps.sessionAbsoluteMs);
		await deps.repository.createSession({ id: sessionId, userId, expiresAt });
		return { sessionId, expiresAt };
	}

	return {
		async loginWithGoogle(credential: string) {
			let payload;
			try {
				payload = await deps.googleTokens.verify(credential, deps.googleClientIds);
			} catch (err) {
				// OAuth library errors can embed request metadata. Keep credentials and
				// configured client identifiers out of logs while retaining diagnostics.
				deps.logger.error(
					{ errorType: err instanceof Error ? err.name : 'unknown', audienceCount: deps.googleClientIds.length },
					'Google token verification failed',
				);
				throw unauthorized('Invalid Google token');
			}

			if (!payload?.sub || !payload.email) throw unauthorized('Invalid token payload');

			deps.logger.info(
				{
					hasHostedDomain: Boolean(payload.hd),
					hostedDomainAccepted: !deps.allowedGoogleHostedDomain
						|| payload.hd === deps.allowedGoogleHostedDomain,
				},
				'Google login attempt',
			);

			if (deps.allowedGoogleHostedDomain && payload.hd !== deps.allowedGoogleHostedDomain) {
				deps.logger.warn(
					{ hasHostedDomain: Boolean(payload.hd) },
					'Email domain rejected',
				);
				throw forbidden('Email domain not allowed', API_ERROR_CODES.EMAIL_DOMAIN_NOT_ALLOWED);
			}

			const user = await deps.repository.upsertUserByGoogleSub({
				googleSub: payload.sub,
				email: payload.email,
				name: stripDeptSuffix(payload.name ?? ''),
				picture: payload.picture ?? '',
				studentId: extractStudentIdFromEmail(payload.email),
			});
			return { user, ...(await createSessionForUser(user.id)) };
		},

		async loginForDevRole(role: UserRole) {
			const profile = DEV_AUTH_USERS[role];
			const user = await deps.repository.upsertDevUser({ ...profile, role });
			return { user, ...(await createSessionForUser(user.id)) };
		},

		async logout(sessionId: string | undefined): Promise<void> {
			if (sessionId) {
				await deps.repository.deleteSession(sessionId).catch((err) => {
					deps.logger.warn(
						{ errorType: err instanceof Error ? err.name : 'unknown' },
						'Failed to delete logout session',
					);
				});
			}
		},
	};
}
