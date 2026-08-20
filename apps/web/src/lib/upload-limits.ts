/**
 * Client-side upload limit constants (mirrors server defaults).
 *
 * These are UX hints — the server is the source of truth.
 * If server env vars override these defaults, the server will
 * reject files that exceed the actual limit regardless.
 */

export interface ClientUploadLimits {
	imageMaxMb: number;
	imagePdfMaxMb: number;
	posterMaxMb: number;
	posterPdfMaxMb: number;
	gameMaxMb: number;
	requestMaxMb: number;
	maxFiles: number;
}

const USER_LIMITS: ClientUploadLimits = {
	imageMaxMb: 10,
	imagePdfMaxMb: 16,
	posterMaxMb: 10,
	posterPdfMaxMb: 16,
	gameMaxMb: 5120,
	requestMaxMb: 16,
	maxFiles: 10,
};

const PRIVILEGED_LIMITS: ClientUploadLimits = {
	imageMaxMb: 15,
	imagePdfMaxMb: 16,
	posterMaxMb: 15,
	posterPdfMaxMb: 16,
	gameMaxMb: 5120,
	requestMaxMb: 16,
	maxFiles: 20,
};

export function getClientUploadLimits(role: string): ClientUploadLimits {
	if (role === 'ADMIN' || role === 'OPERATOR') return PRIVILEGED_LIMITS;
	return USER_LIMITS;
}
