import type { Prisma } from '../../generated/prisma/client.js';
import { conflict } from '../../shared/errors.js';

export const MATERIAL_MAX_COUNT = 5;
export const MATERIAL_MAX_BYTES = 50 * 1024 * 1024;
export function isMaterialKind(kind: string): kind is 'DOCUMENT' | 'ATTACHMENT' {
	return kind === 'DOCUMENT' || kind === 'ATTACHMENT';
}

/** Project row must be locked by the caller; an in-flight session reserves one slot. */
export async function assertMaterialCapacity(tx: Prisma.TransactionClient, projectId: number, excludeSessionId?: string) {
	const ready = await tx.asset.count({ where: { projectId, kind: { in: ['DOCUMENT', 'ATTACHMENT'] }, status: 'READY' } });
	const reserved = await tx.assetUploadSession.count({ where: {
		projectId, kind: { in: ['DOCUMENT', 'ATTACHMENT'] }, resultAssetId: null,
		state: { in: ['ALLOCATING', 'UPLOADING', 'COMPLETING', 'VERIFYING'] },
		...(excludeSessionId ? { id: { not: excludeSessionId } } : {}),
	} });
	if (ready + reserved >= MATERIAL_MAX_COUNT) throw conflict('A project supports at most 5 documents and attachments combined');
}

