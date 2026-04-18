/**
 * Client-side upload limit constants (mirrors server defaults).
 *
 * These are UX hints — the server is the source of truth.
 * If server env vars override these defaults, the server will
 * reject files that exceed the actual limit regardless.
 */

export interface ClientUploadLimits {
	imageMaxMb: number;
	posterMaxMb: number;
	gameMaxMb: number;
	videoMaxMb: number;
	requestMaxMb: number;
	maxFiles: number;
}

const USER_LIMITS: ClientUploadLimits = {
	imageMaxMb: 10,
	posterMaxMb: 10,
	gameMaxMb: 200,
	videoMaxMb: 200,
	requestMaxMb: 250,
	maxFiles: 10,
};

const PRIVILEGED_LIMITS: ClientUploadLimits = {
	imageMaxMb: 15,
	posterMaxMb: 15,
	gameMaxMb: 1024,
	videoMaxMb: 1024,
	requestMaxMb: 1200,
	maxFiles: 20,
};

export function getClientUploadLimits(role: string): ClientUploadLimits {
	if (role === 'ADMIN' || role === 'OPERATOR') return PRIVILEGED_LIMITS;
	return USER_LIMITS;
}
