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

export const CreateWebglNetworkBatchSchema = z.object({
 items: z.array(CreateWebglNetworkRequestSchema).min(1).max(16),
}).strict().superRefine(({ items }, ctx) => {
 const rules = items.map(item => { try { return ConnectionRule.parse(item.origin, item.mode); } catch { return null; } });
 rules.forEach((rule, index) => {
  if (rule && rules.some((other, i) => i !== index && other?.overlaps(rule))) {
   ctx.addIssue({ code: 'custom', path: ['items', index, 'origin'], message: '같은 신청 목록의 다른 연결과 주소 또는 범위가 겹칩니다.' });
  }
 });
});
export const WebglNetworkBatchResponseSchema = z.object({ items: z.array(WebglNetworkRequestSchema).min(1).max(16) }).strict();
export type CreateWebglNetworkBatch = z.infer<typeof CreateWebglNetworkBatchSchema>;
export type WebglNetworkBatchResponse = z.infer<typeof WebglNetworkBatchResponseSchema>;
