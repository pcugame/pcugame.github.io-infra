import { OAuth2Client } from 'google-auth-library';
import { env } from '../../config/env.js';
import { unauthorized } from '../../shared/errors.js';
import { generateSessionId, sessionExpiresAt } from '../../shared/session.js';
import { logger } from '../../lib/logger.js';
import * as repo from './repository.js';

const oauthClient = new OAuth2Client();

// UCM 정책으로 이름 뒤에 학과명이 붙어 오는 경우 제거
const DEPT_SUFFIXES = /(?:소프트웨어공학부|게임공학전공|게임공학과|컴퓨터공학과|정보통신공학과|공학부|공학과|학부|학과|전공)$/;

/** Strip university department suffix from Google profile name */
function stripDeptSuffix(name: string): string {
	const stripped = name.replace(DEPT_SUFFIXES, '');
	return stripped || name;
}

/**
 * Verify a Google ID token, upsert the user, and create a session.
 * Returns the user data and session cookie info.
 */
export async function loginWithGoogle(credential: string) {
	const cfg = env();

	let payload;
	try {
		const ticket = await oauthClient.verifyIdToken({
			idToken: credential,
			audience: cfg.GOOGLE_CLIENT_IDS,
		});
		payload = ticket.getPayload();
	} catch (err) {
		logger.error({ err, configuredAudience: cfg.GOOGLE_CLIENT_IDS }, 'Google token verification failed');
		throw unauthorized('Invalid Google token');
	}

	if (!payload?.sub || !payload.email) throw unauthorized('Invalid token payload');

	logger.info({ email: payload.email, hd: payload.hd, allowedHd: cfg.ALLOWED_GOOGLE_HD }, 'Google login attempt');

	if (cfg.ALLOWED_GOOGLE_HD && payload.hd !== cfg.ALLOWED_GOOGLE_HD) {
		logger.warn({ hd: payload.hd, allowedHd: cfg.ALLOWED_GOOGLE_HD }, 'Email domain rejected');
		throw unauthorized('Email domain not allowed');
	}

	const cleanName = stripDeptSuffix(payload.name ?? '');

	const user = await repo.upsertUserByGoogleSub({
		googleSub: payload.sub,
		email: payload.email,
		name: cleanName,
		picture: payload.picture ?? '',
	});

	const sessionId = generateSessionId();
	const expiresAt = sessionExpiresAt();
	await repo.createSession({ id: sessionId, userId: user.id, expiresAt });

	return { user, sessionId, expiresAt };
}

/** Delete a session by cookie ID (logout) */
export async function logout(sessionId: string | undefined) {
	if (sessionId) {
		await repo.deleteSession(sessionId).catch(() => {});
	}
}
