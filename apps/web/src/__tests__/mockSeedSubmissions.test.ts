import { ProjectSubmissionStatusResponseSchema } from '@pcu/contracts';
import { describe, expect, it } from 'vitest';
import { createMockContext, createMockState } from '../lib/api/mock/context';
import { createSeedSubmissions } from '../lib/api/mock/submission-fixtures';
import { dispatchMockRequest } from '../lib/api/mock/handler';

describe('seed draft submission fixtures', () => {
  it('represents every existing draft asset as a ready slot without changing project fixtures', async () => {
    const state = createMockState(); state.authUser = 'ADMIN'; const before = structuredClone(state.projects);
    state.submissions = createSeedSubmissions(state.projects);
    const drafts = Object.values(state.projects).filter(project => project.status === 'DRAFT' && !project.isChangeRequestDraft);
    expect(drafts.length).toBeGreaterThan(0);
    for (const project of drafts) {
      const path = `/api/admin/projects/${project.id}/submission`;
      const response = ProjectSubmissionStatusResponseSchema.parse(await dispatchMockRequest(createMockContext(state), path, 'GET', {}, path));
      expect(response).toMatchObject({ projectId: project.id, state: 'PENDING' });
      expect(response.items.every(item => item.state === 'READY')).toBe(true);
      expect(new Set(response.items.map(item => item.slot)).size).toBe(response.items.length);
      for (const asset of project.assets.filter(asset => asset.kind !== 'THUMBNAIL')) expect(response.items.some(item => item.kind === asset.kind)).toBe(true);
      expect(state.submissions[project.id]!.actorId).toBe(project.createdByUserId);
    }
    expect(state.projects).toEqual(before);
  });
  it('can finalize seeded ready drafts through the same publication lifecycle', async () => {
    const state = createMockState(); state.authUser = 'ADMIN'; state.submissions = createSeedSubmissions(state.projects);
    const draft = Object.values(state.projects).find(project => project.status === 'DRAFT')!;
    const ctx = createMockContext(state); const path = `/api/admin/projects/${draft.id}/submission`;
    const finalizing = ProjectSubmissionStatusResponseSchema.parse(await dispatchMockRequest(ctx, `${path}/finalize`, 'POST', {}, `${path}/finalize`));
    expect(finalizing.state).toBe('FINALIZING');
    state.submissions[draft.id]!.finalizedAt = new Date(Date.now() - 1000).toISOString();
    const complete = ProjectSubmissionStatusResponseSchema.parse(await dispatchMockRequest(ctx, path, 'GET', {}, path));
    expect(complete.state).toBe('PUBLISHED'); expect(state.projects[draft.id]!.status).toBe('PUBLISHED');
  });
});
