import { badRequest } from '../../../shared/errors.js';

type MetadataPart = {
	type: 'field' | 'file';
	fieldname: string;
	value?: unknown;
	file?: NodeJS.ReadableStream;
};

/**
 * Transitional transport reader for first-party FormData metadata submission.
 * It accepts one scalar `payload` field and rejects every file part before it
 * can enter any storage, archive, image, PDF, or video processing path.
 */
export async function readMetadataPayload(parts: AsyncIterable<MetadataPart>): Promise<unknown> {
	let payload: string | undefined;
	for await (const part of parts) {
		if (part.type === 'file') {
			part.file?.resume();
			throw badRequest('Project file fields must use direct upload sessions');
		}
		if (part.fieldname !== 'payload' || typeof part.value !== 'string' || payload !== undefined) {
			throw badRequest('Metadata submit accepts exactly one payload field');
		}
		payload = part.value;
	}
	if (!payload) throw badRequest('Missing payload field');
	try { return JSON.parse(payload); }
	catch { throw badRequest('Invalid payload JSON'); }
}
