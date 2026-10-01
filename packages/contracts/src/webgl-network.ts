import ipaddr from 'ipaddr.js';
import { z } from 'zod';

/** Exact browser connection origin; this validator never resolves DNS or fetches. */
export function validateWebglNetworkOrigin(value: string, mode: 'HTTPS' | 'WSS'): boolean {
 try {
  const url = new URL(value);
  if (value.length > 512 || url.origin !== value || url.protocol !== (mode === 'HTTPS' ? 'https:' : 'wss:')
   || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host)) {
   const address = ipaddr.parse(host);
   return address.range() === 'unicast' && (!(address instanceof ipaddr.IPv6)
    || (address.match(ipaddr.IPv6.parse('2000::'), 3) && !address.match(ipaddr.IPv6.parse('3fff::'), 20)));
  }
  return host.length <= 253 && host.split('.').every(label => label.length <= 63)
   && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)
   && !/(?:^|\.)(?:localhost|local|internal|lan|home)$/.test(host)
   && !host.endsWith('.home.arpa');
 } catch { return false; }
}

export const WebglNetworkStateSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'REVOKED']);
export const WebglNetworkModeSchema = z.enum(['HTTPS', 'WSS']);
export const CreateWebglNetworkRequestSchema = z.object({
 origin: z.string().min(1).max(512),
 purpose: z.string().trim().min(1).max(2000),
 mode: WebglNetworkModeSchema,
 cors: z.string().trim().min(1).max(2000),
}).strict().refine(value => validateWebglNetworkOrigin(value.origin, value.mode), {
 path: ['origin'], message: 'An exact public HTTPS/WSS origin matching the connection mode is required',
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
