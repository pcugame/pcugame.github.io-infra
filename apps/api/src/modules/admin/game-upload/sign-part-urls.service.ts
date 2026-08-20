import type {
	GameUploadPartUrlsRequest,
	GameUploadPartUrlsResponse,
	UserRole,
} from '@pcu/contracts';
import {
	AppError,
	badRequest,
} from '../../../shared/errors.js';
import {
	DirectUploadQuotaExceededError,
	type GameUploadPartSigningDependencies,
} from './ports.js';
import { recordGameUploadEvent } from './observability.js';

export async function signPartUrls(
	deps: GameUploadPartSigningDependencies,
	sessionId: string,
	actor: { id: number; role: UserRole },
	body: GameUploadPartUrlsRequest,
): Promise<GameUploadPartUrlsResponse> {
	if (body.parts.length === 0
		|| body.parts.length > deps.config.uploadPartUrlBatchMax) {
		throw badRequest(
			`parts must contain 1..${deps.config.uploadPartUrlBatchMax} entries`,
		);
	}
	const unique = new Map<number, string>();
	for (const part of body.parts) {
		const { partNumber, checksumSha256 } = part;
		if (!Number.isSafeInteger(partNumber) || partNumber < 1) {
			throw badRequest('Part number must be a positive safe integer');
		}
		if (!/^[A-Za-z0-9+/]{43}=$/.test(checksumSha256)) {
			throw badRequest(`Part ${partNumber} checksum must be base64 SHA-256`);
		}
		if (unique.has(partNumber)) throw badRequest(`Duplicate part number: ${partNumber}`);
		unique.set(partNumber, checksumSha256);
	}
	let reserved: Awaited<ReturnType<typeof deps.repository.reservePartCapabilities>>;
	try {
		reserved = await deps.repository.reservePartCapabilities({
			sessionId,
			actor,
			generation: body.generation,
			partNumbers: [...unique.keys()],
			maxIssuesPerWindow: deps.config.uploadPartUrlRefreshMax,
			issueWindowMs: deps.config.uploadPartUrlRefreshWindowMs,
			quota: deps.config.directUploadQuota,
		});
	} catch (err) {
		if (err instanceof DirectUploadQuotaExceededError) {
			recordGameUploadEvent(deps, 'quota_rejected', {
				actorId: actor.id,
				sessionId,
				quota: err.quota,
				result: 'rejected',
			});
			throw new AppError(429, 'Direct upload capability quota exceeded', 'RATE_LIMITED');
		}
		if (err instanceof AppError && err.statusCode === 409
			&& err.message.toLowerCase().includes('generation')) {
			recordGameUploadEvent(deps, 'stale_generation_rejected', {
				actorId: actor.id,
				sessionId,
				generation: body.generation,
				result: 'rejected',
			});
		}
		throw err;
	}
	const { session } = reserved;
	const generation = session.multipartGeneration ?? 1;
	if (!session.s3Key || !session.s3UploadId) {
		throw new AppError(500, 'Session is missing S3 multipart info', 'INTERNAL_ERROR');
	}
	const remainingSeconds = Math.floor(
		(session.expiresAt.getTime() - deps.clock.now().getTime()) / 1000,
	);
	const expiresInSeconds = Math.min(deps.config.uploadPartUrlTtlSeconds, remainingSeconds);
	if (expiresInSeconds <= 0) throw badRequest('Upload session has expired');
	const expiresAt = new Date(deps.clock.now().getTime() + expiresInSeconds * 1000);
	const parts = [];
	for (const partNumber of [...unique.keys()].sort((a, b) => a - b)) {
		parts.push({
			partNumber,
			url: await deps.partSigner.presignUploadPart(
				session.s3Key,
				session.s3UploadId,
				partNumber,
				expiresInSeconds,
				unique.get(partNumber)!,
			),
			requiredHeaders: { 'content-type': 'application/octet-stream' },
		});
	}
	recordGameUploadEvent(deps, 'upload_part_urls_issued', {
		actorId: actor.id,
		projectId: session.projectId,
		sessionId: session.id,
		generation,
		partCount: parts.length,
		result: 'issued',
	});
	if (reserved.isRefresh) {
		recordGameUploadEvent(deps, 'upload_part_url_refreshed', {
			actorId: actor.id,
			projectId: session.projectId,
			sessionId: session.id,
			generation,
			partCount: parts.length,
			result: 'refreshed',
		});
	}
	return { generation, expiresAt: expiresAt.toISOString(), parts };
}
