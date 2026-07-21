import crypto from 'node:crypto';

export function generateSessionId(): string {
	return crypto.randomBytes(32).toString('hex');
}

/** Absolute cutoff written to AuthSession.expiresAt — no amount of activity extends past this. */
export function absoluteSessionExpiresAt(
	from: Date,
	absoluteMs: number,
): Date {
	return new Date(from.getTime() + absoluteMs);
}

/**
 * Cookie `expires` the browser should see right now.
 * min(idle window from now, absolute cutoff) — so idle expiry is always enforceable even
 * if the client never sends another request.
 */
export function cookieExpiresAt(
	session: { expiresAt: Date },
	now: Date,
	idleMs: number,
): Date {
	const idleEnd = new Date(now.getTime() + idleMs);
	return idleEnd < session.expiresAt ? idleEnd : session.expiresAt;
}

/** True when the session has been idle longer than SESSION_IDLE_MS. */
export function isIdleExpired(
	lastSeenAt: Date,
	now: Date,
	idleMs: number,
): boolean {
	return now.getTime() - lastSeenAt.getTime() > idleMs;
}
