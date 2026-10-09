import {
 resolveWebglDisplay, AddMemberSchema, UpdateMemberBaseSchema, SwapProjectMembersSchema, UpdateProjectBaseSchema,
 CreateExhibitionBaseSchema, UpdateExhibitionBaseSchema, BulkUpdateProjectStatusSchema,
 BulkDeleteProjectsSchema, SetProjectPosterSchema, SetProjectVideoOrderSchema, AdminProjectListQueryBaseSchema,
} from '@pcu/contracts';
import type { ProjectRequiredAssets } from '@pcu/contracts';
import type { AdminProjectDetail, PublicProjectDetailResponse } from '../../../contracts';
import { MOCK_USERS, MockHttpError, UNHANDLED } from './context';
import type { MockContext, MockProject, MockRequestOptions } from './context';
import { assertProjectRead, assertProjectWrite, bumpProjectVersion, canReadPublicProject, canReadVisibility, getProject, isRelated, isStaff, projectCapabilities, projectExhibition, removeAsset, removeProject, mockWebglAnalysis } from './policy';
import type { z } from 'zod';

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
 let value=body;
 if(typeof body==='string') { try { value=JSON.parse(body); } catch { throw new MockHttpError(400,'VALIDATION_ERROR','Invalid JSON'); } }
 const result=schema.safeParse(value);
 if(!result.success) throw new MockHttpError(400,'VALIDATION_ERROR',result.error.issues.map(i=>i.message).join('; '));
 return result.data;
}
function methodAllowed(method:string, allowed:string[]) { if(!allowed.includes(method)) throw new MockHttpError(404,'NOT_FOUND','Method not allowed'); }
function orderedProjects(ctx:MockContext) { return Object.values(ctx.state.projects).sort((a,b)=>a.sortOrder-b.sortOrder||a.id-b.id); }
function requiredAssets(ctx: MockContext, p: MockProject): ProjectRequiredAssets {
 const sessions = Object.values(ctx.state.sessions).filter(session => session.owner.type === 'PROJECT' && session.owner.id === p.id).reverse();
 const activeKinds = new Set(sessions.filter(session => ['ALLOCATING', 'UPLOADING', 'COMPLETING', 'VERIFYING'].includes(session.state)).map(session => session.kind));
 const latest = new Map<string, string>();
 for (const session of sessions) if (!latest.has(session.kind)) latest.set(session.kind, session.state);
 const failedKinds = new Set([...latest].filter(([, state]) => state === 'REJECTED').map(([kind]) => kind));
 const submission = Object.values(ctx.state.submissions).find(item => item.projectId === p.id);
 if (submission && ['PENDING', 'PROCESSING'].includes(submission.publicationState ?? '')) {
  for (const item of submission.items) if (item.state === 'READY') activeKinds.add(item.kind);
 }
 if (submission?.publicationState === 'FAILED') for (const item of submission.items) if (item.state === 'READY') failedKinds.add(item.kind);
 const nativeBuild = { ready: p.assets.some(asset => asset.kind === 'GAME'), processing: activeKinds.has('GAME'), failed: failedKinds.has('GAME') };
 const webBuild = { ready: !!p.webglDeployment, processing: activeKinds.has('WEBGL'), failed: failedKinds.has('WEBGL') };
 const video = { ready: p.videos.some(video => video.playbackStatus === 'READY'), processing: activeKinds.has('VIDEO') || p.videos.some(video => video.playbackStatus === 'PENDING'), failed: failedKinds.has('VIDEO') || p.videos.some(video => video.playbackStatus === 'FAILED') };
 const poster = { ready: !!p.poster, processing: activeKinds.has('POSTER'), failed: failedKinds.has('POSTER') };
 // URL-only preview: no fixture, upload session, or persisted data is changed.
 if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('mockAssetStates') === '1') {
  const newest = Object.values(ctx.state.projects).filter(project => !project.isChangeRequestDraft).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)[0];
  if (p.id === newest?.id) {
   Object.assign(webBuild, { ready: false, processing: true, failed: false });
   Object.assign(video, { ready: false, processing: false, failed: true });
  }
 }
 const readyCount = [nativeBuild, webBuild, video, poster].filter(item => item.ready).length;
 return { nativeBuild, webBuild, video, poster, readyCount, totalCount: 4, complete: readyCount === 4 };
}
export function adminProjectDetail(ctx:MockContext,p:MockProject): AdminProjectDetail {
 const exhibition=projectExhibition(ctx,p);
 const {createdByUserId: _owner, participantUserIds: _participants, exhibitionId: _exhibition, createdAt: _created, updatedAt: _updated, version: _version,webglNetworkPolicyVersion:_network,isChangeRequestDraft:_stage,...detail}=p;
 void [_owner,_participants,_exhibition,_created,_updated,_version,_network,_stage];
 return {...detail,requiredAssets:requiredAssets(ctx,p),hardwareRequirements: detail.hardwareRequirements ?? '',year:exhibition.year,exhibitionVisibility:exhibition.visibility,...projectCapabilities(ctx,p),members:[...p.members].sort((a,b)=>a.sortOrder-b.sortOrder||a.id-b.id)};
}
function listCapabilities(ctx:MockContext,p:MockProject) { const {canEditWebglDisplay:_display,...capabilities}=projectCapabilities(ctx,p);void _display;return capabilities; }
function publicCard(ctx:MockContext,p:MockProject) {
 const e=projectExhibition(ctx,p);
 return {id:p.id,slug:p.slug,title:p.title,summary:p.summary,poster:p.poster,visibility:p.visibility,exhibitionVisibility:e.visibility,canChangeVisibility:projectCapabilities(ctx,p).canChangeVisibility,members:[...p.members].sort((a,b)=>a.sortOrder-b.sortOrder).map(m=>({name:m.name,studentId:m.studentId})),exhibitionId:e.id,exhibitionTitle:e.title||`${e.year} 전시`};
}
export function publicProjectDetail(ctx:MockContext,p:MockProject):PublicProjectDetailResponse {
 const display = resolveWebglDisplay({...p,analysis:mockWebglAnalysis(p)});
 const { exhibitionId: _id, exhibitionTitle: _title, ...card } = publicCard(ctx,p); void [_id,_title];
 return {...card,year:projectExhibition(ctx,p).year,description:p.description,externalLinks:p.externalLinks,githubUrl:p.githubUrl,platforms:p.platforms,hardwareRequirements:p.hardwareRequirements ?? '',isIncomplete:p.isIncomplete,status:p.status as 'PUBLISHED'|'ARCHIVED',video:p.video,videos:p.videos,members:p.members.map(m=>({id:m.id,name:m.name,studentId:m.studentId})),images:p.assets.flatMap(a=>(a.kind==='IMAGE'||a.kind==='POSTER')?[{id:a.id,kind:a.kind,image:a.image}]:[]),attachments:p.attachments??[],gameDownloadUrl:p.assets.flatMap(a=>a.kind==='GAME'&&'url' in a?[a.url]:[])[0],webglUrl:p.webglUrl,webglDisplayKind:display.kind,webglDisplayWidth:display.width,webglDisplayHeight:display.height};
}
export function handleProjects(ctx:MockContext,pathname:string,method:string,options:MockRequestOptions,originalPath:string):unknown {
 const query=new URLSearchParams(originalPath.split('?')[1]??'');
 if(pathname==='/api/public/years') {
  methodAllowed(method,['GET']);
  return {items:ctx.state.exhibitions.filter(e=>canReadVisibility(ctx,e.visibility)).sort((a,b)=>a.sortOrder-b.sortOrder||b.year-a.year).map(e=>({id:e.id,year:e.year,title:e.title,visibility:e.visibility,poster:e.poster,projectCount:Object.values(ctx.state.projects).filter(p=>p.exhibitionId===e.id&&canReadPublicProject(ctx,p)).length}))};
 }
 let match=pathname.match(/^\/api\/public\/years\/([^/]+)\/projects$/);
 if(match) {
  methodAllowed(method,['GET']); if(!/^[1-9]\d{3}$/.test(match[1]))throw new MockHttpError(400,'VALIDATION_ERROR','Year must have four digits'); const year=Number(match[1]); const exhibitions=ctx.state.exhibitions.filter(e=>e.year===year&&canReadVisibility(ctx,e.visibility));
  if(!exhibitions.length) throw new MockHttpError(404,'NOT_FOUND','Year not found');
  const items=orderedProjects(ctx).filter(p=>exhibitions.some(e=>e.id===p.exhibitionId)&&canReadPublicProject(ctx,p)).map(p=>publicCard(ctx,p));
  return {year,exhibitions:exhibitions.map(e=>({id:e.id,title:e.title||`${year} 전시`,visibility:e.visibility})),items,empty:items.length===0};
 }
 match=pathname.match(/^\/api\/public\/exhibitions\/(\d+)\/projects$/);
 if(match) {
  methodAllowed(method,['GET']); const e=ctx.state.exhibitions.find(e=>e.id===Number(match![1])&&canReadVisibility(ctx,e.visibility));
  if(!e) throw new MockHttpError(404,'NOT_FOUND','Exhibition not found');
  const items=orderedProjects(ctx).filter(p=>p.exhibitionId===e.id&&canReadPublicProject(ctx,p)).map(p=>publicCard(ctx,p));
  return {exhibition:{id:e.id,year:e.year,title:e.title||`${e.year} 전시`,visibility:e.visibility},items,empty:items.length===0};
 }
 match=pathname.match(/^\/api\/public\/projects\/([^/]+)$/);
 if(match) {
  methodAllowed(method,['GET']); if(query.has('year')&&!/^[1-9]\d{3}$/.test(query.get('year')!))throw new MockHttpError(400,'VALIDATION_ERROR','Year must have four digits'); let idOrSlug:string;try{idOrSlug=decodeURIComponent(match[1]);}catch{throw new MockHttpError(400,'VALIDATION_ERROR','Invalid project identifier');}
  const p=orderedProjects(ctx).find(p=>(p.id===Number(idOrSlug)||p.slug===idOrSlug)&&(!query.has('year')||p.year===Number(query.get('year')))&&canReadPublicProject(ctx,p));
  if(!p) throw new MockHttpError(404,'NOT_FOUND','Project not found');
  return publicProjectDetail(ctx,p);
 }
 if(pathname==='/api/admin/exhibitions') {
  ctx.requireUser(); methodAllowed(method,['GET','POST']); if(method==='POST')ctx.requireAdmin();
  if(method==='GET') return {items:ctx.state.exhibitions.filter(e=>canReadVisibility(ctx,e.visibility)).map(e=>({...e,projectCount:Object.values(ctx.state.projects).filter(p=>p.exhibitionId===e.id&&!p.isChangeRequestDraft).length}))};
  const body=parse(CreateExhibitionBaseSchema,options.body);if(ctx.state.exhibitions.some(e=>e.year===body.year&&(e.title??'')===(body.title??'')))throw new MockHttpError(409,'CONFLICT','Exhibition already exists');
  const id=Math.max(0,...ctx.state.exhibitions.map(e=>e.id))+1;
  const enabled=body.isModificationEnabled??body.isUploadEnabled??true;
  ctx.state.exhibitions.push({...body,id,visibility:body.visibility??'PUBLIC',isModificationEnabled:enabled,isUploadEnabled:enabled,sortOrder:body.sortOrder??0,projectCount:0});
  return Response.json({ok:true,data:{id,year:body.year,visibility:body.visibility??'PUBLIC'}},{status:201});
 }
 match=pathname.match(/^\/api\/admin\/exhibitions\/(\d+)(\/poster)?$/);
 if(match) {
  ctx.requireAdmin(); const e=ctx.state.exhibitions.find(e=>e.id===Number(match![1])); if(!e) throw new MockHttpError(404,'NOT_FOUND','Exhibition not found');
  if(match[2]) { methodAllowed(method,['DELETE']); delete e.poster;delete e.posterOriginalName;delete e.posterSize;return; }
  methodAllowed(method,['PATCH','DELETE']);
  if(method==='DELETE') { for(const p of Object.values(ctx.state.projects)) if(p.exhibitionId===e.id) removeProject(ctx,p.id);ctx.state.exhibitions.splice(ctx.state.exhibitions.indexOf(e),1);return; }
  if(method==='PATCH') { const body=parse(UpdateExhibitionBaseSchema,options.body);if(body.title!==undefined&&ctx.state.exhibitions.some(other=>other.id!==e.id&&other.year===e.year&&(other.title??'')===body.title))throw new MockHttpError(409,'CONFLICT','Exhibition already exists');Object.assign(e,body);if(body.isModificationEnabled!==undefined||body.isUploadEnabled!==undefined){e.isModificationEnabled=body.isModificationEnabled??body.isUploadEnabled;e.isUploadEnabled=e.isModificationEnabled!;} }
  return {...e,projectCount:Object.values(ctx.state.projects).filter(p=>p.exhibitionId===e.id&&!p.isChangeRequestDraft).length};
 }
 if(pathname==='/api/admin/projects') {
  ctx.requireUser(); methodAllowed(method,['GET']); const params: Record<string, unknown>=Object.fromEntries(query); for(const key of ['page','limit','year'])if(params[key]!==undefined){if(!/^[1-9]\d*$/.test(String(params[key])))throw new MockHttpError(400,'VALIDATION_ERROR','Expected canonical positive integer');params[key]=Number(params[key]);} if(params.year!==undefined&&(Number(params.year)<1000||Number(params.year)>9999))throw new MockHttpError(400,'VALIDATION_ERROR','Year must have four digits'); const validated=parse(AdminProjectListQueryBaseSchema,params);
  const page=validated.page??1,limit=Math.min(validated.limit??20,100),search=(validated.search??'').trim().toLowerCase();
  const items=Object.values(ctx.state.projects).filter(p=>!p.isChangeRequestDraft&&(isStaff(ctx)||isRelated(ctx,p))&&(!validated.status||p.status===validated.status)&&(!validated.year||p.year===validated.year)&&(!search||[p.title,p.summary,projectExhibition(ctx,p).title,p.year,...p.members.flatMap(m=>[m.name,m.studentId])].some(v=>String(v).toLowerCase().includes(search))));
  const sort=validated.sort??'createdAt',direction=validated.order==='asc'?1:-1;
  items.sort((a,b)=> direction*(sort==='year'?a.year-b.year:sort==='title'?a.title.localeCompare(b.title,'ko'):sort==='status'?a.status.localeCompare(b.status):a.createdAt.localeCompare(b.createdAt))||a.id-b.id);
  const totalItems=items.length,totalPages=Math.ceil(totalItems/limit);
  return {items:items.slice((page-1)*limit,page*limit).map(p=>({requiredAssets:requiredAssets(ctx,p),id:p.id,title:p.title,slug:p.slug,year:p.year,status:p.status,visibility:p.visibility,exhibitionVisibility:projectExhibition(ctx,p).visibility,isIncomplete:p.isIncomplete,memberNames:p.members.map(m=>m.name),memberStudentIds:p.members.map(m=>m.studentId),updatedAt:p.updatedAt,createdByUserName:Object.values(MOCK_USERS).find(user=>user.id===p.createdByUserId)?.name,...listCapabilities(ctx,p)})),pagination:{page,limit,totalItems,totalPages,hasNextPage:page<totalPages,hasPreviousPage:page>1&&totalItems>0}};
 }
 if(pathname==='/api/admin/projects/bulk/status') {
  ctx.requireAdmin();methodAllowed(method,['PATCH']);const body=parse(BulkUpdateProjectStatusSchema,options.body);let updated=0;
  for(const id of new Set(body.ids)){const p=ctx.state.projects[id];if(p&&!p.isChangeRequestDraft){p.status=body.status;bumpProjectVersion(ctx,p);updated++;}} return {updated};
 }
 if(pathname==='/api/admin/projects/bulk/delete') {
  ctx.requireUser();if(ctx.user?.role!=='ADMIN')throw new MockHttpError(403,'FORBIDDEN','Administrator required');methodAllowed(method,['POST']);const body=parse(BulkDeleteProjectsSchema,options.body);let deleted=0,assetsRemoved=0,webglBuildsRemoved=0;
  for(const id of new Set(body.ids)){const p=ctx.state.projects[id];if(p&&!p.isChangeRequestDraft){deleted++;assetsRemoved+=p.assets.length;webglBuildsRemoved+=p.webglDeployment?1:0;removeProject(ctx,id);}}return {deleted,assetsRemoved,webglBuildsRemoved};
 }
 match=pathname.match(/^\/api\/admin\/assets\/(\d+)$/);
 if(match){methodAllowed(method,['DELETE']);ctx.requireUser();const id=Number(match[1]);const p=Object.values(ctx.state.projects).find(p=>p.assets.some(a=>a.id===id));if(!p)throw new MockHttpError(404,'NOT_FOUND','Asset not found');assertProjectWrite(ctx,p);removeAsset(p,id);bumpProjectVersion(ctx,p);return;}
 match=pathname.match(/^\/api\/admin\/projects\/(\d+)(?:\/(poster|webgl|videos\/order|members)(?:\/(swap|\d+))?)?$/);
 if(!match)return UNHANDLED;
 const p=getProject(ctx,Number(match[1])),route=match[2],memberId=match[3];
 if(!route&&method==='GET')return adminProjectDetail(ctx,assertProjectRead(ctx,p));
 assertProjectWrite(ctx,p);
 if(!route){methodAllowed(method,['PATCH','DELETE']);if(method==='DELETE'){removeProject(ctx,p.id);return;}const body=parse(UpdateProjectBaseSchema,options.body);if(body.status!==undefined&&!isStaff(ctx))throw new MockHttpError(403,'FORBIDDEN','Users cannot change project status');Object.assign(p,body);bumpProjectVersion(ctx,p);return adminProjectDetail(ctx,p);}
 if(route==='poster'){methodAllowed(method,['PATCH']);const {assetId}=parse(SetProjectPosterSchema,options.body);const asset=p.assets.find(a=>a.id===assetId);if(!asset)throw new MockHttpError(404,'NOT_FOUND','Asset not found in this project');if(!('image' in asset))throw new MockHttpError(400,'VALIDATION_ERROR','Only image assets can be used as poster');p.posterAssetId=assetId;p.poster=asset.image;bumpProjectVersion(ctx,p);return {posterAssetId:assetId};}
 if(route==='webgl'){methodAllowed(method,['DELETE']);delete p.webglUrl;delete p.webglDeployment;bumpProjectVersion(ctx,p);return;}
 if(route==='videos/order'){methodAllowed(method,['PUT']);const body=parse(SetProjectVideoOrderSchema,options.body);const current=p.videos.map(v=>v.assetId);if(JSON.stringify(current)!==JSON.stringify(body.expectedOrder))throw new MockHttpError(409,'CONFLICT','Video order has changed');if(body.order.length!==current.length||new Set(body.order).size!==current.length||body.order.some(id=>!current.includes(id)))throw new MockHttpError(400,'VALIDATION_ERROR','Order must contain every video exactly once');p.videos=body.order.map((id,i)=>({...p.videos.find(v=>v.assetId===id)!,sortOrder:i,role:i===0?'MAIN':'ADDITIONAL'}));p.video=p.videos[0]??null;for(const a of p.assets)if(a.kind==='VIDEO')a.videoSortOrder=body.order.indexOf(a.id);bumpProjectVersion(ctx,p);return {order:body.order};}
 if(route==='members') {
  if(memberId==='swap'){methodAllowed(method,['PATCH']);const body=parse(SwapProjectMembersSchema,options.body);const a=p.members.find(m=>m.id===body.memberIdA),b=p.members.find(m=>m.id===body.memberIdB);if(!a||!b)throw new MockHttpError(404,'NOT_FOUND','Member not found');[a.sortOrder,b.sortOrder]=[b.sortOrder,a.sortOrder];}
  else if(memberId){methodAllowed(method,['PATCH','DELETE']);const member=p.members.find(m=>m.id===Number(memberId));if(!member)throw new MockHttpError(404,'NOT_FOUND','Member not found');if(method==='DELETE')p.members.splice(p.members.indexOf(member),1);else Object.assign(member,parse(UpdateMemberBaseSchema,options.body));}
  else {methodAllowed(method,['POST']);const body=parse(AddMemberSchema,options.body);const id=Math.max(0,...Object.values(ctx.state.projects).flatMap(p=>p.members.map(m=>m.id)))+1;p.members.push({...body,id,sortOrder:body.sortOrder??p.members.length,userId:null});bumpProjectVersion(ctx,p);return {id};}
  p.members.sort((a,b)=>a.sortOrder-b.sortOrder||a.id-b.id);bumpProjectVersion(ctx,p);return;
 }
 return UNHANDLED;
}
