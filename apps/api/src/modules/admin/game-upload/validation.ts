import { z } from 'zod';

const PositiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const GameUploadPartUrlsBody = z.object({
	generation: PositiveSafeInteger,
	partNumbers: z.array(PositiveSafeInteger),
}).strict();

export const GameUploadCompleteBody = z.object({
	generation: PositiveSafeInteger,
	parts: z.array(z.object({
		partNumber: PositiveSafeInteger,
		etag: z.string().min(1).max(1024),
		sizeBytes: PositiveSafeInteger,
	}).strict()),
}).strict();
