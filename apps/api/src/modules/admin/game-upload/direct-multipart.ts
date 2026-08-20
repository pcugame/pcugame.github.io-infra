import type {
	GameUploadCompletePart,
	GameUploadTransport,
	GameUploadUploadedPart,
} from '@pcu/contracts';
import { AppError, badRequest, conflict } from '../../../shared/errors.js';
import type { GameUploadStoredPartRecord } from './ports.js';

export const MAX_MULTIPART_PARTS = 10_000;

export function assertMultipartPartCount(totalParts: number): void {
	if (!Number.isSafeInteger(totalParts) || totalParts < 1 || totalParts > MAX_MULTIPART_PARTS) {
		throw new AppError(
			400,
			`Multipart upload requires between 1 and ${MAX_MULTIPART_PARTS} parts`,
			'MULTIPART_PART_LIMIT',
		);
	}
}

export function resolvedUploadTransport(
	record: { transport: GameUploadTransport },
): GameUploadTransport {
	return record.transport;
}

function normalizeEtag(etag: string): string {
	return etag.trim().replace(/^"|"$/g, '');
}

function expectedPartSize(
	partNumber: number,
	totalBytes: bigint,
	chunkSizeBytes: number,
	totalChunks: number,
): number {
	return partNumber === totalChunks
		? Number(totalBytes) - (partNumber - 1) * chunkSizeBytes
		: chunkSizeBytes;
}

function assertPartShape(
	part: { partNumber: number; etag: string; sizeBytes?: number },
	totalChunks: number,
): void {
	if (!Number.isSafeInteger(part.partNumber)
		|| part.partNumber < 1
		|| part.partNumber > totalChunks) {
		throw badRequest(`Part number must be between 1 and ${totalChunks}`);
	}
	if (!part.etag || normalizeEtag(part.etag).length === 0) {
		throw badRequest(`Part ${part.partNumber} is missing an ETag`);
	}
	if (part.sizeBytes !== undefined
		&& (!Number.isSafeInteger(part.sizeBytes) || part.sizeBytes <= 0)) {
		throw badRequest(`Part ${part.partNumber} has an invalid size`);
	}
}

function sortedUnique<T extends { partNumber: number }>(parts: T[]): T[] {
	const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
	for (let index = 1; index < sorted.length; index += 1) {
		if (sorted[index]?.partNumber === sorted[index - 1]?.partNumber) {
			throw badRequest(`Duplicate part number: ${sorted[index]?.partNumber}`);
		}
	}
	return sorted;
}

export function validateSubmittedCompletionParts(
	parts: GameUploadCompletePart[],
	totalChunks: number,
): GameUploadCompletePart[] {
	if (parts.length !== totalChunks) {
		throw badRequest(`Expected ${totalChunks} completed parts, got ${parts.length}`);
	}
	for (const part of parts) assertPartShape(part, totalChunks);
	const sorted = sortedUnique(parts);
	for (let index = 0; index < sorted.length; index += 1) {
		if (sorted[index]?.partNumber !== index + 1) {
			throw badRequest(`Missing multipart part ${index + 1}`);
		}
	}
	return sorted;
}

export function validateStoredParts(input: {
	parts: GameUploadStoredPartRecord[];
	totalBytes: bigint;
	chunkSizeBytes: number;
	totalChunks: number;
	requireComplete: boolean;
}): GameUploadUploadedPart[] {
	for (const part of input.parts) assertPartShape(part, input.totalChunks);
	const sorted = sortedUnique(input.parts);
	if (input.requireComplete && sorted.length !== input.totalChunks) {
		throw conflict(`Garage contains ${sorted.length} of ${input.totalChunks} required parts`);
	}
	for (const part of sorted) {
		if (part.sizeBytes === undefined) {
			throw new AppError(
				500,
				'Object storage did not return multipart part sizes',
				'INTERNAL_ERROR',
			);
		}
		const expected = expectedPartSize(
			part.partNumber,
			input.totalBytes,
			input.chunkSizeBytes,
			input.totalChunks,
		);
		if (part.sizeBytes !== expected) {
			throw conflict(
				`Stored multipart part ${part.partNumber} size mismatch: expected ${expected}, got ${part.sizeBytes}`,
			);
		}
	}
	return sorted.map((part) => ({
		partNumber: part.partNumber,
		etag: part.etag,
		sizeBytes: part.sizeBytes!,
	}));
}

export function crossCheckSubmittedAndStoredParts(
	submitted: GameUploadCompletePart[],
	stored: GameUploadUploadedPart[],
): void {
	if (submitted.length !== stored.length) {
		throw conflict('Submitted multipart manifest does not match Garage ListParts');
	}
	for (let index = 0; index < submitted.length; index += 1) {
		const clientPart = submitted[index]!;
		const garagePart = stored[index]!;
		if (clientPart.partNumber !== garagePart.partNumber
			|| clientPart.sizeBytes !== garagePart.sizeBytes
			|| normalizeEtag(clientPart.etag) !== normalizeEtag(garagePart.etag)) {
			throw conflict(`Submitted multipart part ${clientPart.partNumber} does not match Garage ListParts`);
		}
	}
}
