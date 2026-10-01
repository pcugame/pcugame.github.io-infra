import { attachmentContentDisposition, buildGameDownloadFilename } from '@pcu/contracts';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { VisibilityActor as Actor } from '../../shared/visibility.js';
export interface FileAccessRequest {currentUser?: NonNullable<Actor>; cookies: Record<string,string|undefined>; ip?:string; downloadAlreadyChecked?:boolean}
import type { Env } from '../../config/env.js';
import { canReadProject, canReadVisibility, type VisibilityActor } from '../../shared/visibility.js';
import { authorizeAssetDelivery } from '../assets/delivery-policy.js';
import { forbidden, notFound } from '../../shared/errors.js';
import type { FileAccessRepository } from './repository.js';

export function safeObjectPath(value: string): string {
 if (!value || /[\\\u0000-\u001f]/.test(value)) throw notFound();
 let decoded: string;
 try { decoded = decodeURIComponent(value); } catch { throw notFound(); }
 if (decoded.split('/').some(part => part === '.' || part === '..') || decoded.includes('\\')) throw notFound();
 return decoded.replace(/^\//, '');
}
export function manifestIncludes(manifest: unknown, key: string): boolean {
 if (!manifest || typeof manifest !== 'object' || !('objects' in manifest)) return false;
 const objects = manifest.objects;
 return Array.isArray(objects) && objects.some(item => item && typeof item === 'object' && 'objectKey' in item && item.objectKey === key);
}
export type RuntimeResolver = (raw: string, headers: Record<string,string|string[]|undefined>) => Promise<{path:string;host:string;csp:string}>;
export function createFileAccessService(repository: FileAccessRepository, config: Env, now = () => new Date(), presign?: (bucket:string,key:string,options?:{method?:'GET'|'HEAD';responseContentDisposition?:string})=>Promise<string>, checkDownload?: (assetId:number,variant:'original'|'playback',ip:string,actor:NonNullable<Actor>|undefined)=>Promise<unknown>, runtimeResolver?: RuntimeResolver) {
 const publicOrigin = config.PUBLIC_ASSET_ORIGIN ?? config.API_PUBLIC_URL;
 const protectedOrigin = config.S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT ?? config.API_PUBLIC_URL;
 function parseUrl(value: string) {
  let url: URL; try {url = new URL(value);} catch {throw notFound();}
  if (url.username || url.password || url.hash) throw notFound();
  const bucket = url.origin === publicOrigin ? config.S3_BUCKET_PUBLIC : url.origin === protectedOrigin ? config.S3_BUCKET_PROTECTED : null;
  if (!bucket) throw notFound();
  const key = safeObjectPath(url.pathname);
  const objectKey = bucket === config.S3_BUCKET_PROTECTED ? (key.startsWith('file/') || key.startsWith('play/')) ? key : key.startsWith(bucket + '/') ? key.slice(bucket.length+1) : '' : key;
  if (!objectKey) throw notFound();
  return {url, bucket, objectKey};
 }
 async function actorForSession(id: string): Promise<VisibilityActor> {
  const session = await repository.session(id);
  if (!session || session.expiresAt <= now() || now().getTime()-session.lastSeenAt.getTime() >= config.SESSION_IDLE_MS) throw forbidden();
  return session.user;
 }
 async function authorize(bucket: string, key: string, actor: VisibilityActor, deploymentId?: string|null) {
  const deployment = deploymentId ? await repository.deployment(deploymentId) : await repository.findDeployment(bucket,key);
  if (deployment && deployment.state === 'READY') {
   const staged = deployment.stagingBucket !== null;
   const identityMatches = staged ? deployment.stagingBucket === bucket && manifestIncludes(deployment.stagingObjectManifest,key) : deployment.project.currentWebglDeploymentId === deployment.id && deployment.publicBucket === bucket && manifestIncludes(deployment.objectManifest,key);
   const allowed = staged ? authorizeAssetDelivery({action:'DOWNLOAD_ORIGINAL',asset:{kind:'WEBGL',project:deployment.project},actor:actor??undefined}) : canReadProject(actor,deployment.project);
   if(identityMatches && allowed) return deployment;
   if(deploymentId) throw forbidden();
  }
  if (deploymentId) throw forbidden();
  const representation = await repository.findRepresentation(bucket,key);
  const asset = representation?.asset;
  if (!asset || asset.status !== 'READY') throw forbidden();
  if (asset.project) {
   const p = asset.project;
   if (p.status === 'PUBLISHED' || p.status === 'ARCHIVED') {
    if (!canReadProject(actor,p)) throw forbidden();
   } else if (!authorizeAssetDelivery({action:'DOWNLOAD_ORIGINAL', asset:{kind:asset.kind,project:p},actor:actor??undefined})) throw forbidden();
  } else if (!asset.exhibition || !canReadVisibility(actor,asset.exhibition.visibility)) throw forbidden();
  return null;
 }
 async function issue(value: string, request: FileAccessRequest) {
  let input=value;
  let parsed:URL;try{parsed=new URL(value);}catch{throw notFound();}
  if(parsed.origin===new URL(config.API_PUBLIC_URL).origin){
   const match=/^\/api\/assets\/(\d+)\/download$/.exec(parsed.pathname);
   if(!match || !presign) throw notFound();
   const asset=await repository.asset(Number(match[1]));
   const role=asset?.kind==='WEBGL'?'WEBGL_SOURCE':parsed.searchParams.get('variant')==='playback'?'PLAYBACK':'ORIGINAL';
   const representation=asset?.representations.find(r=>r.role===role && r.state==='READY');
   if(!representation || asset?.status!=='READY') throw notFound();
   input=representation.bucket===config.S3_BUCKET_PUBLIC ? publicOrigin+'/'+representation.objectKey.split('/').map(encodeURIComponent).join('/') : await presign(representation.bucket,representation.objectKey);
  }
  const target = parseUrl(input);
  const sid=request.currentUser?request.cookies[config.SESSION_COOKIE_NAME]:undefined;
  const actor = sid ? await actorForSession(sid) : null;
  const deployment = await authorize(target.bucket,target.objectKey,actor);
  if(target.bucket===config.S3_BUCKET_PROTECTED && checkDownload && !request.downloadAlreadyChecked){
   const representation=await repository.findRepresentation(target.bucket,target.objectKey);
   if(!representation && !deployment) throw forbidden();
   const assetId=representation?.asset.id??deployment?.sourceRepresentation.assetId;
   if(!assetId) throw forbidden();
   await checkDownload(assetId,representation?.role==='PLAYBACK'?'playback':'original',request.ip??'',actor??undefined);
  }
  let publicAccess = false;
  try {await authorize(target.bucket,target.objectKey,null);publicAccess=true;} catch { /* a session-bound capability is required */ }
  if (publicAccess && !deployment && target.bucket !== config.S3_BUCKET_PROTECTED) return {url:target.url.toString(),token:null,expiresAt:null};
  const sessionId = actor ? request.cookies[config.SESSION_COOKIE_NAME] : null;
  if (!publicAccess && !sessionId) throw forbidden();
  if (sessionId) await actorForSession(sessionId);
  await repository.purgeExpired(now());
  const reused=await repository.reusable(sessionId??null,target.bucket,target.objectKey,deployment?.id??null,now());
  if(!reused && await repository.activeCount(sessionId??null,now()) >= (sessionId?256:4096)) throw forbidden();
  const token = reused?.id ?? randomBytes(32).toString('hex');
  const expiresAt = new Date(now().getTime()+60_000);
  if(reused) await repository.renew(token,expiresAt);
  else await repository.createToken({id:token,sessionId:sessionId??null,bucket:target.bucket,objectKey:target.objectKey,deploymentId:deployment?.id??null,expiresAt});
  if (deployment) target.url.pathname = '/play/'+token+'/'+target.objectKey.slice((deployment.stagingPrefix??deployment.publicPrefix).replace(/\/$/,'').length+1).split('/').map(encodeURIComponent).join('/');
  else if(target.bucket === config.S3_BUCKET_PROTECTED){target.url.pathname='/file/'+token;target.url.search='';}
  else target.url.searchParams.set('pcu_token',token);
  return {url:target.url.toString(),token,expiresAt:expiresAt.toISOString()};
 }
 return {issue, async renew(tokenId: string, request: FileAccessRequest) {
   const token = await repository.token(tokenId);
   if (!token || token.expiresAt <= now()) throw forbidden();
   const sessionId = request.cookies[config.SESSION_COOKIE_NAME];
   if (token.sessionId && (!request.currentUser || token.sessionId !== sessionId)) throw forbidden();
   const actor = token.sessionId ? await actorForSession(token.sessionId) : null;
   await authorize(token.bucket,token.objectKey,actor,token.deploymentId);
   const expiresAt = new Date(now().getTime()+60_000);
   await repository.renew(token.id,expiresAt);
   return {ok:true,data:{token:token.id,expiresAt:expiresAt.toISOString()}};
 }, async check(headers: Record<string,string|string[]|undefined>) {
   const supplied=headers['x-pcu-gateway-secret'];
   const expected=config.FILE_GATEWAY_SECRET;
   if (typeof supplied !== 'string' || !expected || Buffer.byteLength(supplied)!==Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied),Buffer.from(expected))) throw forbidden();
   const raw=headers['x-pcu-file-uri'];
   const kind=headers['x-pcu-file-kind'];
   if (typeof raw!=='string' || (kind!=='public' && kind!=='protected')) throw forbidden();
   if (raw.startsWith('/runtime/')) {
    if (kind !== 'public' || !runtimeResolver) throw forbidden();
    return runtimeResolver(raw,headers);
   }
   const target=parseUrl((kind==='public'?publicOrigin:protectedOrigin)+raw);
   let key=target.objectKey;
   let tokenId=target.url.searchParams.get('pcu_token');
   const file=/^file\/([a-f0-9]{64})$/.exec(key);
   if(file) tokenId=file[1]!;
   const play=/^play\/([a-f0-9]{64})\/(.+)$/.exec(key);
   if (play) tokenId=play[1]!;
   if (tokenId) {
    const token=await repository.token(tokenId);
    if (!token || token.expiresAt<=now() || token.bucket!==target.bucket) throw forbidden();
    const actor=token.sessionId?await actorForSession(token.sessionId):null;
    if (play) {
     if (!token.deploymentId) throw forbidden();
     const deployment=await repository.deployment(token.deploymentId);
     if (!deployment) throw forbidden();
     key=(deployment.stagingPrefix??deployment.publicPrefix).replace(/\/$/,'')+'/'+play[2]!;
    } else if(file) key=token.objectKey;
    else if (token.objectKey!==key) throw forbidden();
    await authorize(target.bucket,key,actor,token.deploymentId);
   } else await authorize(target.bucket,key,null);

 if(kind==='protected'){
    if(!presign) throw forbidden();
    const representation=await repository.findRepresentation(target.bucket,key);
    const asset=representation?.asset;
    const disposition=asset?.kind==='GAME' && asset.project ? attachmentContentDisposition(buildGameDownloadFilename(asset.project.title,asset.project.members).filename) : asset && (asset.kind==='DOCUMENT' || asset.kind==='ATTACHMENT') ? attachmentContentDisposition(asset.originalName || `material-${asset.id}`) : undefined;
    const method=headers['x-pcu-file-method']==='HEAD'?'HEAD':'GET';
    const signed=new URL(await presign(target.bucket,key,{method,responseContentDisposition:disposition}));
    return {path:signed.pathname+signed.search,host:signed.host};
   }
   return {path:'/'+key.split('/').map(encodeURIComponent).join('/'),host:''};
 }};
}
