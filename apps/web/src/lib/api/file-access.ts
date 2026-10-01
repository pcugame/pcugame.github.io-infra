import { api } from './client';

export interface FileAccessResponse {
 url: string;
 token: string | null;
 expiresAt: string | null;
}
const mediaKeys = new Set(['url', 'webglUrl', 'gameDownloadUrl', 'downloadUrl', 'thumbnailUrl', 'posterUrl', 'originalDownloadUrl', 'playbackUrl', 'previewUrl']);
const externalLinkKeys = new Set(['externalLinks', 'githubUrl']);

/** Resolve only serialized media, never upload capabilities or external project links. */
export async function hydrateFileUrls<T>(value: T): Promise<T> {
 const requests = new Map<string, Promise<string>>();
 async function walk(node: unknown, key = ''): Promise<unknown> {
  if (externalLinkKeys.has(key)) return node;
  if (typeof node === 'string' && mediaKeys.has(key) && /^https?:\/\//.test(node)) {
   let pending = requests.get(node);
   if (!pending) {
    pending = api.post<FileAccessResponse>('/api/file-access', { url: node }).then((result) => result.url);
    requests.set(node, pending);
   }
   return pending;
  }
  if (Array.isArray(node)) return Promise.all(node.map((item) => walk(item)));
  if (node && typeof node === 'object') {
   const entries = await Promise.all(Object.entries(node).map(async ([name, item]) => [name, await walk(item, name)] as const));
   return Object.fromEntries(entries);
  }
  return node;
 }
 return await walk(value) as T;
}

export function collectFileTokens(value: unknown): Set<string> {
 const tokens = new Set<string>();
 function walk(node: unknown, key = '') {
  if (externalLinkKeys.has(key)) return;
  if (typeof node === 'string' && /^https?:\/\//.test(node)) {
   const url = new URL(node);
   const token = url.searchParams.get('pcu_token') ?? url.pathname.match(/^\/(?:play|file)\/([^/]+)(?:\/|$)/)?.[1];
   if (token) tokens.add(token);
  } else if (Array.isArray(node)) node.forEach((item) => walk(item));
  else if (node && typeof node === 'object') Object.entries(node).forEach(([name, item]) => walk(item, name));
 }
 walk(value);
 return tokens;
}
