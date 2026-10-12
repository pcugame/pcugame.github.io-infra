import { z } from 'zod';

export { ConnectionRule, ProjectConnectionPolicy } from './connection-rule.js';
import { ConnectionRule } from './connection-rule.js';

export function validateWebglNetworkOrigin(value: string, mode: 'HTTPS' | 'WSS'): boolean {
 try { ConnectionRule.parse(value, mode); return true; } catch { return false; }
}

export const WebglNetworkStateSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'REVOKED']);
export const WebglNetworkModeSchema = z.enum(['HTTPS', 'WSS']);
export const CreateWebglNetworkRequestSchema = z.object({
 origin: z.string().min(1).max(512),
 purpose: z.string().trim().min(1).max(2000),
 mode: WebglNetworkModeSchema,
 cors: z.string().trim().min(1).max(2000),
}).strict().refine(value => validateWebglNetworkOrigin(value.origin, value.mode), {
 path: ['origin'], message: 'A canonical public HTTPS/WSS origin or subdomain rule matching the connection mode is required',
});
export const ReviewWebglNetworkRequestSchema = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();
const Id = z.number().int().positive();
const Time = z.string().datetime();
export const WebglNetworkReviewEventSchema = z.object({
 id: z.string().uuid(), action: z.enum(['APPROVE', 'REJECT', 'REVOKE']), actorId: Id,
 reason: z.string(), policyVersion: z.number().int().nonnegative().nullable(), createdAt: Time,
}).strict();
export const WebglNetworkRequestSchema = z.object({
 id: z.string().uuid(), projectId: Id.nullable(), originalProjectId: Id, projectTitle: z.string(),
 requesterId: Id, origin: z.string(), purpose: z.string(), mode: WebglNetworkModeSchema, cors: z.string(),
 state: WebglNetworkStateSchema, reviewerId: Id.nullable(), reviewReason: z.string().nullable(),
 createdAt: Time, reviewedAt: Time.nullable(), revokedAt: Time.nullable(),
 policyVersion: z.number().int().nonnegative().nullable(), events: z.array(WebglNetworkReviewEventSchema),
}).strict();
export const WebglNetworkRequestListSchema = z.object({
 items: z.array(WebglNetworkRequestSchema), gameOrigin: z.string(), policyVersion: z.number().int().nonnegative().nullable(),
}).strict();
export type CreateWebglNetworkRequest = z.infer<typeof CreateWebglNetworkRequestSchema>;
export type WebglNetworkRequest = z.infer<typeof WebglNetworkRequestSchema>;
export type WebglNetworkRequestList = z.infer<typeof WebglNetworkRequestListSchema>;
export type WebglNetworkList = WebglNetworkRequestList;
export type WebglNetworkCreateBody = CreateWebglNetworkRequest;
