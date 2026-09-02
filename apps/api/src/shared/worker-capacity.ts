const MEBIBYTE = 1024 * 1024;

export interface DirectArchiveCapacityConfig {
	UPLOAD_USER_GAME_MAX_MB: number;
	UPLOAD_PRIVILEGED_GAME_MAX_MB: number;
	DIRECT_UPLOAD_WORKER_TEMP_MAX_MB: number;
	EXPORT_WORKER_MAX_OBJECT_BYTES: number;
}

function safeBytesFromMebibytes(value: number, label: string): number {
	const bytes = value * MEBIBYTE;
	if (!Number.isSafeInteger(bytes) || bytes < 1) {
		throw new Error(`${label} must resolve to a positive safe integer byte count`);
	}
	return bytes;
}

/** Largest GAME/WEBGL archive the control plane can accept for any role. */
export function maximumAcceptedDirectArchiveBytes(
	config: Pick<DirectArchiveCapacityConfig, 'UPLOAD_USER_GAME_MAX_MB' | 'UPLOAD_PRIVILEGED_GAME_MAX_MB'>,
): number {
	return Math.max(
		safeBytesFromMebibytes(config.UPLOAD_USER_GAME_MAX_MB, 'UPLOAD_USER_GAME_MAX_MB'),
		safeBytesFromMebibytes(config.UPLOAD_PRIVILEGED_GAME_MAX_MB, 'UPLOAD_PRIVILEGED_GAME_MAX_MB'),
	);
}

/**
 * Fail closed before a worker opens DB/S3 resources if its configured local
 * archive budget cannot process a byte size already accepted by the API.
 * WebGL decode/publish is streamed; decoded entries do not share this temp
 * filesystem budget.
 */
export function assertDirectArchiveWorkerCapacity(
	config: Pick<DirectArchiveCapacityConfig,
		'UPLOAD_USER_GAME_MAX_MB' | 'UPLOAD_PRIVILEGED_GAME_MAX_MB' | 'DIRECT_UPLOAD_WORKER_TEMP_MAX_MB'>,
	worker: 'GAME' | 'WEBGL',
): { acceptedArchiveBytes: number; tempBudgetBytes: number } {
	const acceptedArchiveBytes = maximumAcceptedDirectArchiveBytes(config);
	const tempBudgetBytes = safeBytesFromMebibytes(
		config.DIRECT_UPLOAD_WORKER_TEMP_MAX_MB,
		'DIRECT_UPLOAD_WORKER_TEMP_MAX_MB',
	);
	if (tempBudgetBytes < acceptedArchiveBytes) {
		throw new Error(`${worker} worker temp budget must cover the maximum accepted direct archive`);
	}
	return { acceptedArchiveBytes, tempBudgetBytes };
}

/** Every accepted original must remain exportable after the direct cutover. */
export function assertExportWorkerCapacity(
	config: Pick<DirectArchiveCapacityConfig,
		'UPLOAD_USER_GAME_MAX_MB' | 'UPLOAD_PRIVILEGED_GAME_MAX_MB' | 'EXPORT_WORKER_MAX_OBJECT_BYTES'>,
): { acceptedArchiveBytes: number; maxObjectBytes: number } {
	const acceptedArchiveBytes = maximumAcceptedDirectArchiveBytes(config);
	if (!Number.isSafeInteger(config.EXPORT_WORKER_MAX_OBJECT_BYTES)
		|| config.EXPORT_WORKER_MAX_OBJECT_BYTES < acceptedArchiveBytes) {
		throw new Error('Export worker object limit must cover the maximum accepted direct archive');
	}
	return { acceptedArchiveBytes, maxObjectBytes: config.EXPORT_WORKER_MAX_OBJECT_BYTES };
}

export const WEBGL_MAX_DECODED_BYTES = 10 * 1024 * 1024 * 1024;
