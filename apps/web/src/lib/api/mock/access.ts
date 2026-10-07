import { ExternalLinkSchema, detectExternalLinkService } from '@pcu/contracts';
import { UNHANDLED, type MockContext, type MockRequestOptions } from './context';
import { canReadPublicProject, canReadVisibility, isRelated, isStaff } from './policy';
import { allowMethod, bodyObject, forbidden, missing, parseInput } from './common';

interface FileToken { token: string; url: string; userId: number | null; expiresAt: string; projectId: number | null; exhibitionId: number | null }
function locate(ctx: MockContext, value: string) {
  const normalize = (value: string) => { const url = new URL(value, 'http://mock.local'); url.searchParams.delete('pcu_token'); return url.toString(); };
  const clean = normalize(value);
  for (const project of Object.values(ctx.state.projects)) {
    const urls = [project.webglUrl, project.webglDeployment?.url, project.poster?.original.url,
      ...project.assets.flatMap(a => 'image' in a ? [a.image.original.url, ...a.image.renditions.map(r => r.url)] : 'url' in a ? [a.url, a.playbackUrl, a.originalDownloadUrl] : [a.downloadUrl])];
    if (urls.some(url => url !== undefined && normalize(url) === clean)) return { projectId: project.id, exhibitionId: null };
  }
  const exhibition = ctx.state.exhibitions.find(e => [e.poster?.original.url, ...e.poster?.renditions.map(r => r.url) ?? []].some(url => url !== undefined && normalize(url) === clean));
  return exhibition ? { projectId: null, exhibitionId: exhibition.id } : null;
}
function authorize(ctx: MockContext, owner: { projectId: number | null; exhibitionId: number | null }) {
  if (owner.projectId !== null) {
    const project = ctx.state.projects[owner.projectId] ?? missing();
    let related = isRelated(ctx, project);
    if (project.isChangeRequestDraft) {
      const request = Object.values(ctx.state.changeRequests).find(r => r.stagingProjectId === project.id && ['DRAFT','PENDING','APPLYING','FAILED'].includes(r.state));
      const source = request?.projectId === null ? undefined : ctx.state.projects[request?.projectId ?? 0];
      related = !!source && isRelated(ctx, source);
    }
    if (project.status === 'DRAFT' ? !(related || isStaff(ctx)) : !canReadPublicProject(ctx, project)) forbidden();
  } else {
    const exhibition = ctx.state.exhibitions.find(e => e.id === owner.exhibitionId) ?? missing();
    if (!canReadVisibility(ctx, exhibition.visibility)) forbidden();
  }
}
export function handleAccess(ctx: MockContext, pathname: string, method: string, options: MockRequestOptions): unknown {
  if (pathname === '/api/me/external-links/resolve') {
    allowMethod(method, 'POST'); ctx.requireUser();
    const { url } = parseInput(ExternalLinkSchema.pick({ url: true }).strict(), bodyObject(options));
    return { service: detectExternalLinkService(url) };
  }
  const renew = /^\/api\/file-access\/([a-f0-9]{64})\/renew$/.exec(pathname);
  if (renew) {
    allowMethod(method, 'POST');
    const token = (ctx.state.fileTokens as Record<string, FileToken>)[renew[1]] ?? forbidden('File token not found');
    if (new Date(token.expiresAt).getTime() <= Date.now() || token.userId !== null && ctx.user?.id !== token.userId) forbidden('File token expired or session changed');
    authorize(ctx, token); token.expiresAt = new Date(Date.now() + 60_000).toISOString();
    return { token: token.token, expiresAt: token.expiresAt };
  }
  if (pathname !== '/api/file-access') return UNHANDLED;
  allowMethod(method, 'POST');
  const value = bodyObject(options).url;
  if (typeof value !== 'string') missing('Invalid file URL');
  const owner = locate(ctx, value) ?? missing('Unknown mock media URL');
  authorize(ctx, owner);
  const publicCtx = { ...ctx, user: null } as MockContext;
  let publiclyReadable = true;
  try { authorize(publicCtx, owner); } catch { publiclyReadable = false; }
  if (publiclyReadable) return { url: value, token: null, expiresAt: null };
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map(v => v.toString(16).padStart(2,'0')).join('');
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  (ctx.state.fileTokens as Record<string, FileToken>)[token] = { ...owner, token, url: value, userId: ctx.user?.id ?? null, expiresAt };
  return { url: `${value}${value.includes('?') ? '&' : '?'}pcu_token=${token}`, token, expiresAt };
}
