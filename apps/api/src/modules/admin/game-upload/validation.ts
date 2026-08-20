import { z } from 'zod';

const PositiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const GameUploadPartUrlsBody = z.object({
	generation: PositiveSafeInteger,
	parts: z.array(z.object({
		partNumber: PositiveSafeInteger,
		checksumSha256: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
	}).strict()),
}).strict();

export const GameUploadCompleteBody = z.object({
	generation: PositiveSafeInteger,
	parts: z.array(z.object({
		partNumber: PositiveSafeInteger,
		etag: z.string().min(1).max(1024),
		sizeBytes: PositiveSafeInteger,
	}).strict()),
}).strict();
