import { z } from 'zod';

export const VideoRetryResponseSchema = z.object({
	assetId: z.number().int().positive(),
	playbackStatus: z.literal('PENDING'),
}).strict();
export type VideoRetryResponse = z.infer<typeof VideoRetryResponseSchema>;
