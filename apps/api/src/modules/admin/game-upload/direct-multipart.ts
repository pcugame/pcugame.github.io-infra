import type {
	DirectGameUploadCompleteRequest,
	DirectGameUploadPart,
} from '@pcu/contracts';
import { AppError, badRequest, conflict } from '../../../shared/errors.js';

/** S3's protocol limit.  Enforce before allocating either storage or DB work. */
export const MAX_MULTIPART_PARTS = 10_000;

export function assertMultipartPartCount(totalParts: number): void {
	if (!Number.isSafeInteger(totalParts) || totalParts < 1 || totalParts > MAX_MULTIPART_PARTS) {
		throw new AppError(400, `Multipart upload requires between 1 and ${MAX_MULTIPART_PARTS} parts`, 'VALIDATION_ERROR');
	}
}

export function normalizeMultipartEtag(etag: string): string {
	return etag.trim().replace(/^"|"$/g, '');
}

function assertPart(part: DirectGameUploadPart, totalParts: number): void {
	if (!Number.isSafeInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > totalParts) {
		throw badRequest(`Part number must be between 1 and ${totalParts}`);
	}
	if (!part.etag || !normalizeMultipartEtag(part.etag)) throw badRequest(`Part ${part.partNumber} is missing an ETag`);
	if (!Number.isSafeInteger(part.sizeBytes) || part.sizeBytes <= 0) throw badRequest(`Part ${part.partNumber} has an invalid size`);
}

function sortedUnique(parts: DirectGameUploadPart[]): DirectGameUploadPart[] {
	const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
	for (let index = 1; index < sorted.length; index += 1) {
		if (sorted[index]?.partNumber === sorted[index - 1]?.partNumber) {
			throw badRequest(`Duplicate part number: ${sorted[index]?.partNumber}`);
		}
	}
	return sorted;
}

function expectedPartSize(partNumber: number, totalBytes: bigint, partSizeBytes: number, totalParts: number): number {
	return partNumber === totalParts
		? Number(totalBytes) - ((partNumber - 1) * partSizeBytes)
		: partSizeBytes;
}

/** Validate the client manifest's shape only; ListParts remains authoritative. */
export function validateSubmittedCompletionParts(
	request: DirectGameUploadCompleteRequest,
	totalParts: number,
): DirectGameUploadPart[] {
	if (request.parts.length !== totalParts) throw badRequest(`Expected ${totalParts} completed parts, got ${request.parts.length}`);
	for (const part of request.parts) assertPart(part, totalParts);
	const parts = sortedUnique(request.parts);
	for (let index = 0; index < parts.length; index += 1) {
		if (parts[index]?.partNumber !== index + 1) throw badRequest(`Missing multipart part ${index + 1}`);
	}
	return parts;
}

/**
 * Validate Garage's ListParts response. The supplied manifest never grants
 * completion authority: it must exactly match this result.
 */
export function validateStoredMultipartParts(input: {
	parts: DirectGameUploadPart[];
	totalBytes: bigint;
	partSizeBytes: number;
	totalParts: number;
}): DirectGameUploadPart[] {
	for (const part of input.parts) assertPart(part, input.totalParts);
	const parts = sortedUnique(input.parts);
	if (parts.length !== input.totalParts) throw conflict(`Garage contains ${parts.length} of ${input.totalParts} required parts`);
	for (const part of parts) {
		const expected = expectedPartSize(part.partNumber, input.totalBytes, input.partSizeBytes, input.totalParts);
		if (part.sizeBytes !== expected) throw conflict(`Stored multipart part ${part.partNumber} size mismatch: expected ${expected}, got ${part.sizeBytes}`);
	}
	return parts;
}

export function assertCompletionManifestMatchesGarage(
	submitted: DirectGameUploadPart[],
	stored: DirectGameUploadPart[],
): void {
	if (submitted.length !== stored.length) throw conflict('Submitted multipart manifest does not match Garage ListParts');
	for (let index = 0; index < submitted.length; index += 1) {
		const clientPart = submitted[index]!;
		const garagePart = stored[index]!;
		if (clientPart.partNumber !== garagePart.partNumber
			|| clientPart.sizeBytes !== garagePart.sizeBytes
			|| normalizeMultipartEtag(clientPart.etag) !== normalizeMultipartEtag(garagePart.etag)) {
			throw conflict(`Submitted multipart part ${clientPart.partNumber} does not match Garage ListParts`);
		}
	}
}
