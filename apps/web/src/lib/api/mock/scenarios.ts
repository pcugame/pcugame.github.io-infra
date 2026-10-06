import { createMockContext, createMockState } from './context';
import { updateMockState } from './transport';
import { handleChanges } from './changes';

export type MockScenario = 'default' | 'empty' | 'permissions' | 'media' | 'review' | 'failures';
export function chooseMockScenario(scenario: MockScenario) {
  return updateMockState(state => {
    const user = state.authUser;
    Object.assign(state, createMockState()); state.authUser = user;
    if (scenario === 'empty') { state.projects = {}; state.exhibitions = []; }
    if (scenario === 'permissions' || scenario === 'review') {
      state.authUser = 'owner';
      const exhibition = state.exhibitions.find(e => Object.values(state.projects).some(p => p.exhibitionId === e.id && p.createdByUserId === 3 && p.status !== 'DRAFT'));
      if (exhibition) { exhibition.isModificationEnabled = false; exhibition.isUploadEnabled = false; }
      if (scenario === 'review') {
        const project = Object.values(state.projects).find(p => p.exhibitionId === exhibition?.id && p.createdByUserId === 3 && p.status !== 'DRAFT');
        if (project) {
          const ctx = createMockContext(state), path = `/api/me/projects/${project.id}/change-requests`;
          handleChanges(ctx, path, 'POST', { body: { kind:'EDIT',reason:'Fixture review request' } }, path);
          const row = Object.values(state.changeRequests)[0]; row.changes = { title: `${project.title} — 검토 변경` }; row.state='PENDING'; row.submittedAt=ctx.now();
          state.authUser = 'ADMIN';
        }
      }
    }
    if (scenario === 'media') {
      // Seed completed uploads into the same persisted validation lifecycle as
      // real mock uploads. Pausing and resuming therefore affects both fixtures
      // and newly submitted videos through advanceUploadJobs.
      for (const project of Object.values(state.projects).filter(p=>p.videos.length>0).slice(0,3)) {
        const items = project.videos.map((video,index)=>{
          const asset=project.assets.find(a=>a.id===video.assetId&&a.kind==='VIDEO');
          if(!asset || asset.kind!=='VIDEO') throw new Error('Media fixture video must have a matching asset');
          asset.playbackStatus='PENDING';delete asset.playbackUrl;delete asset.playbackError;
          video.playbackStatus='PENDING';delete video.url;delete video.playbackError;
          const sessionId=crypto.randomUUID(),itemId=crypto.randomUUID(),clientToken=crypto.randomUUID();
          state.sessions[sessionId]={sessionId,owner:{type:'PROJECT',id:project.id},kind:'VIDEO',actorId:project.createdByUserId,
            generation:1,state:'VERIFYING',originalName:asset.originalName,totalBytes:asset.size,partSizeBytes:5*1024*1024,totalParts:1,
            expiresAt:new Date(Date.now()+3600000).toISOString(),sourceIdentityAlgorithm:'SHA256_BLOCK_MANIFEST_V1',
            sourceIdentity:'0'.repeat(64),sourceIdentityBlockDigests:['0'.repeat(64)],capabilities:{},parts:[],
            submissionItemId:itemId,resultAssetId:asset.id,completedAt:new Date(Date.now()-1000).toISOString(),processingState:'PROCESSING'};
          return {id:itemId,kind:'VIDEO' as const,slot:`video:${index}`,clientToken,required:true as const,state:'VERIFYING' as const,sessionId,generation:1};
        });
        state.submissions[project.id]={submissionId:crypto.randomUUID(),projectId:project.id,projectStatus:project.status,state:'PUBLISHED',
          actorId:project.createdByUserId,createdAt:new Date().toISOString(),items};
        project.video=project.videos[0]??null;
      }
      state.controls.worker='paused';
    }
    if (scenario === 'failures') { state.controls.worker='fail'; state.controls.fault={method:'GET',path:'/api/admin/projects',status:503,code:'DRAINING',message:'Mock one-shot unavailable',retryAfter:'0'}; }
  });
}
