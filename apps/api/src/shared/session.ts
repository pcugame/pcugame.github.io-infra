import crypto from 'node:crypto';
import { env } from '../config/env.js';

export function generateSessionId(): string {
	return crypto.randomBytes(32).toString('hex');
}

/** Absolute cutoff written to AuthSession.expiresAt — no amount of activity extends past this. */
export function absoluteSessionExpiresAt(from: Date = new Date()): Date {
	return new Date(from.getTime() + env().SESSION_ABSOLUTE_MS);
}

/**
 * Cookie `expires` the browser should see right now.
 * min(idle window from now, absolute cutoff) — so idle expiry is always enforceable even
 * if the client never sends another request.
 */
export function cookieExpiresAt(session: { expiresAt: Date }, now: Date = new Date()): Date {
	const idleEnd = new Date(now.getTime() + env().SESSION_IDLE_MS);
	return idleEnd < session.expiresAt ? idleEnd : session.expiresAt;
}

/** True when the session has been idle longer than SESSION_IDLE_MS. */
export function isIdleExpired(lastSeenAt: Date, now: Date = new Date()): boolean {
	return now.getTime() - lastSeenAt.getTime() > env().SESSION_IDLE_MS;
}
