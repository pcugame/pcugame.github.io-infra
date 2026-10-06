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
      for (const project of Object.values(state.projects).slice(0,3)) {
        const asset = project.assets.find(a=>a.kind==='VIDEO');
        if (asset && asset.kind==='VIDEO') { asset.playbackStatus='PENDING'; delete asset.playbackUrl; }
        for (const video of project.videos) { video.playbackStatus='PENDING'; delete video.url; }
        project.video=project.videos[0]??null;
      }
      state.controls.worker='paused';
    }
    if (scenario === 'failures') { state.controls.worker='fail'; state.controls.fault={method:'GET',path:'/api/admin/projects',status:503,code:'DRAINING',message:'Mock one-shot unavailable',retryAfter:'0'}; }
  });
}
