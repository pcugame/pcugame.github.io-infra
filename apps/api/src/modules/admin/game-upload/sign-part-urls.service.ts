import type {
	GameUploadPartUrlsRequest,
	GameUploadPartUrlsResponse,
	UserRole,
} from '@pcu/contracts';
import {
	AppError,
	badRequest,
	conflict,
	forbidden,
	notFound,
} from '../../../shared/errors.js';
import type { GameUploadPartSigningDependencies } from './ports.js';
import { recordGameUploadEvent } from './observability.js';

export async function signPartUrls(
	deps: GameUploadPartSigningDependencies,
	sessionId: string,
	actor: { id: number; role: UserRole },
	body: GameUploadPartUrlsRequest,
): Promise<GameUploadPartUrlsResponse> {
	const session = await deps.repository.findSessionById(sessionId);
	if (!session) throw notFound('Upload session not found');
	const isPrivileged = actor.role === 'ADMIN' || actor.role === 'OPERATOR';
	if (!isPrivileged && session.userId !== actor.id) {
		throw forbidden('Not your upload session');
	}
	await deps.authorizeProjectWrite(actor, session.projectId);
	if (session.transport !== 'DIRECT_MULTIPART') {
		throw badRequest('Part URLs are unavailable for an API chunk proxy session');
	}
	if (session.status !== 'PENDING') {
		throw badRequest(`Cannot issue part URLs: session is ${session.status}`);
	}
	if (session.expiresAt <= deps.clock.now()) {
		// Signing is fail-closed only. Expiration state transitions and durable
		// multipart-abort cleanup are maintenance-worker responsibilities.
		throw badRequest('Upload session has expired');
	}
	const generation = session.multipartGeneration ?? 1;
	if (body.generation !== generation) {
		throw conflict('Upload generation is stale');
	}
	if (!await deps.repository.isSessionActive(session.id)) {
		throw conflict('Upload session has been replaced');
	}
	if (!session.s3Key || !session.s3UploadId) {
		throw new AppError(500, 'Session is missing S3 multipart info', 'INTERNAL_ERROR');
	}
	if (body.partNumbers.length === 0
		|| body.partNumbers.length > deps.config.uploadPartUrlBatchMax) {
		throw badRequest(
			`partNumbers must contain 1..${deps.config.uploadPartUrlBatchMax} entries`,
		);
	}
	const unique = new Set<number>();
	for (const partNumber of body.partNumbers) {
		if (!Number.isSafeInteger(partNumber)
			|| partNumber < 1
			|| partNumber > session.totalChunks) {
			throw badRequest(`Part number must be between 1 and ${session.totalChunks}`);
		}
		if (unique.has(partNumber)) throw badRequest(`Duplicate part number: ${partNumber}`);
		unique.add(partNumber);
	}
	const remainingSeconds = Math.floor(
		(session.expiresAt.getTime() - deps.clock.now().getTime()) / 1000,
	);
	const expiresInSeconds = Math.min(deps.config.uploadPartUrlTtlSeconds, remainingSeconds);
	if (expiresInSeconds <= 0) throw badRequest('Upload session has expired');
	const expiresAt = new Date(deps.clock.now().getTime() + expiresInSeconds * 1000);
	const parts = [];
	for (const partNumber of [...unique].sort((a, b) => a - b)) {
		parts.push({
			partNumber,
			url: await deps.partSigner.presignUploadPart(
				session.s3Key,
				session.s3UploadId,
				partNumber,
				expiresInSeconds,
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
	return { generation, expiresAt: expiresAt.toISOString(), parts };
}
