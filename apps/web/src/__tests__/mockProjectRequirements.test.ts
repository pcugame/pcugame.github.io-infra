import { IDBFactory } from 'fake-indexeddb';
import {
  AdminProjectDetailSchema, AdminProjectListResponseSchema, PublicProjectDetailResponseSchema,
  PublicYearProjectsResponseSchema, SubmitProjectResponseSchema,
} from '@pcu/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockContext } from '../lib/api/mock/context';
import { createSubmission } from '../lib/api/mock/uploads';
import { mockFetch, resetMockState, selectMockUser, forgetMockCacheForTests, updateMockState } from '../lib/api/mock/transport';

async function request(path: string, method = 'GET', body?: unknown) {
  const response = await mockFetch(path, { method, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) });
  const envelope = response.status === 204 ? undefined : await response.json();
  return { response, data: envelope?.data, error: envelope?.error };
}
async function create(title = '새 작품') {
  const form = new FormData();
  form.set('payload', JSON.stringify({ exhibitionId: 1, title, summary: '등록 소개', description: '등록 설명', members: [{ name: '학생', studentId: '2088099' }], platforms: ['PC', 'WEB'], hardwareRequirements: ' VR 헤드셋\n컨트롤러 ', manifest: [] }));
  const { response, data } = await request('/api/admin/projects/submit', 'POST', form);
  expect(response.status).toBe(201);
  return SubmitProjectResponseSchema.parse(data);
}

beforeEach(async () => {
  await forgetMockCacheForTests();
  vi.stubGlobal('indexedDB', new IDBFactory());
  await resetMockState(); await selectMockUser('ADMIN');
});
afterEach(async () => { await forgetMockCacheForTests(); vi.unstubAllGlobals(); });

describe('persisted project metadata response boundary', () => {
  it('keeps edit, list, public detail and reload on the same project state, including explicit clears', async () => {
    const patch = { title: '저장한 제목', summary: '저장한 소개', description: '첫째 줄\n둘째 줄', platforms: ['MOBILE', 'WEB'], hardwareRequirements: ' VR 헤드셋\n컨트롤러 ' };
    const updated = await request('/api/admin/projects/1', 'PATCH', patch);
    expect(updated.response.status).toBe(200);
    expect(AdminProjectDetailSchema.parse(updated.data)).toMatchObject({ ...patch, hardwareRequirements: patch.hardwareRequirements.trim() });
    await forgetMockCacheForTests();
    expect(AdminProjectDetailSchema.parse((await request('/api/admin/projects/1')).data)).toMatchObject({ title: patch.title, platforms: patch.platforms, hardwareRequirements: patch.hardwareRequirements.trim() });
    const listed = AdminProjectListResponseSchema.parse((await request('/api/admin/projects?search=저장한 제목')).data);
    expect(listed.items.map(item => item.id)).toEqual([1]);
    const year = PublicYearProjectsResponseSchema.parse((await request('/api/public/years/2025/projects')).data);
    expect(year.items.find(item => item.id === 1)).toMatchObject({ title: patch.title, summary: patch.summary });
    const published = PublicProjectDetailResponseSchema.parse((await request('/api/public/projects/dragon-slayer')).data);
    expect(published).toMatchObject({ ...patch, hardwareRequirements: patch.hardwareRequirements.trim() });
    await request('/api/admin/projects/1', 'PATCH', { title: '제목만 변경' });
    expect((await request('/api/public/projects/1')).data).toMatchObject({ platforms: patch.platforms, hardwareRequirements: patch.hardwareRequirements.trim() });
    await request('/api/admin/projects/1', 'PATCH', { platforms: [], hardwareRequirements: '' });
    await forgetMockCacheForTests();
    expect((await request('/api/public/projects/1')).data).toMatchObject({ platforms: [], hardwareRequirements: '' });
  });

  it('creates independent submissions, publishes their metadata, and persists deletes without reusing IDs', async () => {
    const first = await create(); const second = await create();
    expect(second.id).toBeGreaterThan(first.id); expect(second.slug).not.toBe(first.slug);
    expect((await request(`/api/admin/projects/${first.id}`)).data).toMatchObject({ platforms: ['PC', 'WEB'], hardwareRequirements: 'VR 헤드셋\n컨트롤러', status: 'DRAFT' });
    expect((await request(`/api/public/projects/${first.id}`)).response.status).toBe(404);
    await request(`/api/admin/projects/${first.id}/submission/finalize`, 'POST');
    await request(`/api/admin/projects/${second.id}/submission/finalize`, 'POST');
    // Publication is asynchronous in the existing worker simulation; poll through its HTTP boundary.
    await vi.waitFor(async () => expect((await request(`/api/admin/projects/${first.id}/submission`)).data.state).toBe('PUBLISHED'));
    await vi.waitFor(async () => expect((await request(`/api/admin/projects/${second.id}/submission`)).data.state).toBe('PUBLISHED'));
    await forgetMockCacheForTests();
    expect(PublicProjectDetailResponseSchema.parse((await request(`/api/public/projects/${first.id}`)).data)).toMatchObject({ platforms: ['PC', 'WEB'], hardwareRequirements: 'VR 헤드셋\n컨트롤러' });
    expect((await request(`/api/admin/projects/${second.id}`, 'DELETE')).response.status).toBe(204);
    await forgetMockCacheForTests();
    expect((await request(`/api/admin/projects/${second.id}`)).response.status).toBe(404);
    expect((await request(`/api/public/projects/${second.id}`)).response.status).toBe(404);
    expect(AdminProjectListResponseSchema.parse((await request('/api/admin/projects?limit=100')).data).items.some(item => item.id === second.id)).toBe(false);
    expect((await create()).id).toBeGreaterThan(second.id);
  });

  it('shares persisted IDs across normal and staged projects, even after deleting the highest of either kind', async () => {
    const normal = await create();
    await request(`/api/admin/projects/${normal.id}`, 'DELETE');
    await forgetMockCacheForTests();
    await updateMockState(state => { state.exhibitions[0].isModificationEnabled = false; state.exhibitions[0].isUploadEnabled = false; });
    await selectMockUser('owner');
    const change = await request('/api/me/projects/1/change-requests', 'POST', { kind: 'EDIT', reason: '포스터 교체' });
    expect(change.response.status).toBe(201);
    const staged = await request(`/api/me/change-requests/${change.data.id}`, 'PATCH', { manifest: [{ kind: 'POSTER', slot: 'poster', clientToken: 'a'.repeat(32) }] });
    expect(staged.response.status).toBe(200);
    expect(staged.data.stagingProjectId).toBeGreaterThan(normal.id);
    await request(`/api/me/change-requests/${change.data.id}/cancel`, 'POST');
    await forgetMockCacheForTests(); await selectMockUser('ADMIN');
    expect((await create()).id).toBeGreaterThan(staged.data.stagingProjectId);
  });

  it('backfills the allocator from legacy state and explicitly supplied staging IDs', async () => {
    await updateMockState(state => {
      delete state.counters.project;
      state.projects[50000] = { ...state.projects[1], id: 50000, slug: 'legacy-highest' };
    });
    const normal = await create();
    expect(normal.id).toBeGreaterThan(50000);
    await updateMockState(state => {
      const ctx = createMockContext(state);
      createSubmission(ctx, { exhibitionId: 1, title: '외부 생성 임시 작품', members: [], manifest: [] }, 1, { project: { ...state.projects[1], id: 70000, slug: 'explicit-stage', isChangeRequestDraft: true } });
      delete state.projects[70000]; delete state.submissions[70000];
    });
    await forgetMockCacheForTests();
    expect((await create()).id).toBeGreaterThan(70000);
  });

  it('rejects invalid writes without partial mutation and reads legacy hardware as empty', async () => {
    const invalid = await request('/api/admin/projects/1', 'PATCH', { title: '반영되면 안 됨', platforms: ['CONSOLE'], hardwareRequirements: 'x'.repeat(1001) });
    expect(invalid.response.status).toBe(400); expect(invalid.error.code).toBe('VALIDATION_ERROR');
    expect((await request('/api/admin/projects/1')).data.title).toBe('Dragon Slayer');
    await updateMockState(state => { delete state.projects[1].hardwareRequirements; });
    expect((await request('/api/admin/projects/1')).data.hardwareRequirements).toBe('');
    expect((await request('/api/public/projects/1')).data.hardwareRequirements).toBe('');
    await resetMockState();
    expect((await request('/api/admin/projects/1')).data.title).toBe('Dragon Slayer');
  });
});
