import type { WebglDisplayAnalysis } from '@pcu/contracts';
import type { MockContext, MockProject } from './context';
import { MockHttpError } from './context';

export const isStaff = (ctx: MockContext) => ctx.user?.role === 'ADMIN' || ctx.user?.role === 'OPERATOR';
export const isPrivileged = isStaff;
export const isRelated = (ctx: MockContext, project: MockProject) => !!ctx.user && (project.createdByUserId === ctx.user.id || project.members.some(m => m.userId === ctx.user!.id));
export const isProjectRelated = isRelated;
export function getProject(ctx: MockContext, id: number): MockProject {
 const project = ctx.state.projects[id];
 if (!project) throw new MockHttpError(404, 'NOT_FOUND', 'Project not found');
 return project;
}
export function projectExhibition(ctx: MockContext, project: MockProject) {
 const exhibition = ctx.state.exhibitions.find(e => e.id === project.exhibitionId);
 if (!exhibition) throw new MockHttpError(404, 'NOT_FOUND', 'Exhibition not found');
 return exhibition;
}
export function projectCapabilities(ctx: MockContext, project: MockProject) {
 const exhibition = projectExhibition(ctx, project);
 const isModificationEnabled = exhibition.isModificationEnabled ?? exhibition.isUploadEnabled;
 const direct = isStaff(ctx) || (isModificationEnabled && isRelated(ctx, project));
 return { isModificationEnabled, canEdit: direct, canDelete: direct, canChangeVisibility: direct,
 canRequestChange: !isStaff(ctx) && !isModificationEnabled && isRelated(ctx, project) && project.status !== 'DRAFT',
 canEditWebglDisplay: isStaff(ctx) || (isModificationEnabled && project.createdByUserId === ctx.user?.id) };
}
export function assertProjectRead(ctx: MockContext, project: MockProject) {
 ctx.requireUser();
 if (project.isChangeRequestDraft) throw new MockHttpError(404, 'NOT_FOUND', 'Project not found');
 if (!isStaff(ctx) && !isRelated(ctx, project)) throw new MockHttpError(403, 'FORBIDDEN', 'Not your project');
 return project;
}
export function assertProjectWrite(ctx: MockContext, project: MockProject) {
 assertProjectRead(ctx, project);
 if (!projectCapabilities(ctx, project).canEdit) throw new MockHttpError(403, 'FORBIDDEN', 'Project modifications are closed for this exhibition');
 return project;
}
export const requireProjectRead = (ctx: MockContext, id: number) => assertProjectRead(ctx, getProject(ctx,id));
export const requireProjectWrite = (ctx: MockContext, id: number) => assertProjectWrite(ctx, getProject(ctx,id));
export const requireProjectDelete = requireProjectWrite;
export function canReadVisibility(ctx: MockContext, visibility: string) {
 return visibility === 'PUBLIC' || (visibility === 'AUTHENTICATED' && !!ctx.user) || (visibility === 'STAFF' && isStaff(ctx));
}
export function canReadPublicProject(ctx: MockContext, project: MockProject) {
 return !project.isChangeRequestDraft && project.status !== 'DRAFT' && (isRelated(ctx,project) || (canReadVisibility(ctx, project.visibility) && canReadVisibility(ctx, projectExhibition(ctx,project).visibility)));
}
export function bumpProjectVersion(ctx: MockContext, project: MockProject) { project.version = (project.version ?? 0) + 1; project.updatedAt = ctx.now(); }
export const projectVersion = bumpProjectVersion;
export function removeProject(ctx: MockContext, id: number) {
 delete ctx.state.projects[id]; delete ctx.state.submissions[id];
 for (const session of Object.values(ctx.state.sessions)) if (session.owner.type==='PROJECT' && session.owner.id===id) session.state='CANCELLED';
 for (const request of Object.values(ctx.state.changeRequests)) {
  if(request.projectId===id) {
   if(request.stagingProjectId!==null && request.stagingProjectId!==id) removeProject(ctx,request.stagingProjectId);
   if(['DRAFT','PENDING','APPLYING','FAILED'].includes(request.state)) {request.state='CONFLICT';request.error='Source project was deleted';request.updatedAt=ctx.now();}
   request.projectId=null;
  }
  if(request.stagingProjectId===id) {request.stagingProjectId=null;request.submissionId=null;request.items=[];}
 }
 for(const request of Object.values(ctx.state.networkRequests)) if(request.projectId===id) request.projectId=null;
}
export function removeAsset(project: MockProject, assetId: number) {
 project.assets = project.assets.filter(a => a.id !== assetId);
 project.videos = project.videos.filter(v => v.assetId !== assetId).map((v,i)=>({...v, sortOrder:i, role:i===0?'MAIN':'ADDITIONAL'}));
 project.video = project.videos[0] ?? null;
 project.attachments = project.attachments?.filter(a => a.assetId !== assetId);
 if (project.posterAssetId === assetId) { delete project.posterAssetId; delete project.poster; }
}

/** The local preview fixtures carry the same analysis categories as processed builds. */
export function mockWebglAnalysis(project: MockProject): WebglDisplayAnalysis | null {
 if (!project.webglUrl) return null;
 if (new URL(project.webglUrl).pathname.endsWith('/fixed.html')) {
  return {version:1,kind:'fixed',width:800,height:600,reason:null};
 }
 return {version:1,kind:'responsive',width:null,height:null,reason:null};
}
