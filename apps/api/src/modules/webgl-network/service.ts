import { CreateWebglNetworkRequestSchema, ReviewWebglNetworkRequestSchema } from '@pcu/contracts';
import type { Actor } from '../../application/http-input.js';
import type { Env } from '../../config/env.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { parseBody } from '../../shared/validation.js';
import type { WebglNetworkRepository } from './repository.js';

/** Same host is privileged even when a request changes transport or port. */
export function isPrivilegedNetworkOrigin(value: string, config: Env): boolean {
 const host = new URL(value).hostname;
 return privilegedHosts(config).includes(host);
}
function privilegedHosts(config: Env): string[] {
 return [config.API_PUBLIC_URL, config.WEB_PUBLIC_URL, ...config.CORS_ALLOWED_ORIGINS, config.PUBLIC_ASSET_ORIGIN,
  config.S3_ENDPOINT, config.S3_PUBLIC_SIGNING_ENDPOINT, config.S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT]
  .filter((origin): origin is string => Boolean(origin)).map(origin => new URL(origin).hostname);
}
export function createWebglNetworkService(repository: WebglNetworkRepository, config: Env, now = () => new Date()) {
 function enabled() { if (!config.WEBGL_EXTERNAL_CONNECTIONS_ENABLED) throw notFound(); }
 const gameOrigin = config.PUBLIC_ASSET_ORIGIN ?? '';
 return {
  async listOwner(actor: Actor, projectId: number) { enabled(); return { ...await repository.listOwner(actor, projectId), gameOrigin }; },
  async listAdmin(actor: Actor) { enabled(); return { ...await repository.listAdmin(actor), gameOrigin }; },
  async create(actor: Actor, projectId: number, body: unknown) {
   enabled();
   const input = parseBody(CreateWebglNetworkRequestSchema, body);
   if (isPrivilegedNetworkOrigin(input.origin, config)) throw badRequest('Site and storage origins cannot be approved as external connections', 'VALIDATION_ERROR');
   return repository.create(actor, projectId, input);
  },
  async review(actor: Actor, id: string, action: 'approve' | 'reject' | 'revoke', body: unknown) {
   // Revocation remains usable while disabled so administrators can remove grants.
   if (action !== 'revoke') enabled();
   return repository.review(actor, id, action, parseBody(ReviewWebglNetworkRequestSchema, body).reason, now(), privilegedHosts(config));
  },
 };
}
