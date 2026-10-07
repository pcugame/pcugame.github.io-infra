/* @vitest-environment jsdom */
import { AdminProjectDetailSchema, ProjectSubmissionStatusResponseSchema, SubmitProjectResponseSchema, type ProjectChangeDetail } from '@pcu/contracts';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectAssetUploadStatus, ProjectSubmissionStatusResponse, SubmitProjectResponse } from '../contracts';
import { mockFetch, resetMockState, selectMockUser, setMockControls, forgetMockCacheForTests, getMockSnapshot, updateMockState } from '../lib/api/mock/transport';
import { uploadDirectAssetFile, getDirectAssetUploadStatus, cancelDirectAssetUploadSession } from '../lib/api/game-upload';
import { createFileSourceIdentity } from '../lib/file-identity';

const manifest = (kind = 'GAME', slot = 'game') => [{ kind, slot, clientToken: 'test_client_token_'.padEnd(32, 'x'), required: true }];
function payload(title = 'Upload project', items = manifest()) {
  return { exhibitionId: 1, title, members: [{ name: 'Student', studentId: '2088099' }], manifest: items };
}
async function request<T>(path: string, method = 'GET', body?: unknown, headers?: HeadersInit): Promise<T> {
  const response = await mockFetch(path, { method, body: body instanceof FormData || body instanceof Blob ? body : body === undefined ? undefined : JSON.stringify(body), headers });
  const data = response.status === 204 ? undefined : await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error.message), { status: response.status, code: data.error.code });
  return data?.data as T;
}
async function submit(title?: string, items?: ReturnType<typeof manifest>, key?: string) {
  const form = new FormData(); form.set('payload', JSON.stringify(payload(title, items)));
  return request<SubmitProjectResponse>('/api/me/projects/submit', 'POST', form, key ? { 'Idempotency-Key': key } : undefined);
}
const file = (name = 'game.zip') => new File(['demo'], name, { type: 'application/zip' });
const binding = (created: SubmitProjectResponse) => ({ submissionItem: { id: created.items[0]!.id, clientToken: created.items[0]!.clientToken } });
const status = (id: number) => request<ProjectSubmissionStatusResponse>(`/api/me/projects/${id}/submission`).then(response => ProjectSubmissionStatusResponseSchema.parse(response));
const finalize = (id: number) => request<ProjectSubmissionStatusResponse>(`/api/me/projects/${id}/submission/finalize`, 'POST').then(response => ProjectSubmissionStatusResponseSchema.parse(response));

beforeEach(async () => {
  vi.stubEnv('VITE_MOCK', 'true'); vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('File', NodeFile); vi.stubGlobal('crypto', webcrypto);
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  await resetMockState(); await selectMockUser('owner');
  await updateMockState(state => { const exhibition = state.exhibitions.find(item => item.id === 1)!; exhibition.isModificationEnabled = true; exhibition.isUploadEnabled = true; exhibition.visibility = 'PUBLIC'; });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('persisted project direct upload mock through the actual client', () => {
  it('serializes strict submission contracts without internal scheduling or ownership fields', async () => {
    const created = await submit('Strict responses', []); expect(SubmitProjectResponseSchema.safeParse(created).success).toBe(true);
    const pending = await status(created.id); expect(ProjectSubmissionStatusResponseSchema.parse(pending).state).toBe('PENDING');
    const finalizing = await finalize(created.id); expect(ProjectSubmissionStatusResponseSchema.parse(finalizing).state).toBe('FINALIZING');
    await vi.advanceTimersByTimeAsync(650); expect(ProjectSubmissionStatusResponseSchema.parse(await status(created.id)).state).toBe('PUBLISHED');
    const cancelledProject = await submit('Cancelled strict responses');
    const cancelled = await request(`/api/me/projects/${cancelledProject.id}/submission`, 'DELETE');
    expect(ProjectSubmissionStatusResponseSchema.parse(cancelled).state).toBe('CANCELLED');
    expect(ProjectSubmissionStatusResponseSchema.parse(await status(cancelledProject.id)).state).toBe('CANCELLED');
    await selectMockUser('ADMIN');
    expect(ProjectSubmissionStatusResponseSchema.parse(await request(`/api/admin/projects/${created.id}/submission`)).state).toBe('PUBLISHED');
  });
  it('uses real unique projects and scopes idempotency replay and conflicts', async () => {
    const first = await submit('first', undefined, 'submission-key-1');
    const replay = await submit('first', undefined, 'submission-key-1');
    const second = await submit('second');
    expect(replay).toEqual(first); expect(second.id).not.toBe(first.id);
    expect((await status(first.id)).items[0]!.id).not.toBe((await status(second.id)).items[0]!.id);
    await expect(submit('different', undefined, 'submission-key-1')).rejects.toMatchObject({ status: 409 });
    expect((await getMockSnapshot()).projects[first.id]!.title).toBe('first');
  });
  it('rejects unauthenticated, foreign, closed and invalid owner uploads', async () => {
    const created = await submit();
    await selectMockUser('anonymous'); await expect(uploadDirectAssetFile(created.id, file(), 'GAME', undefined, binding(created))).rejects.toMatchObject({ status: 401 });
    await selectMockUser('other'); await expect(uploadDirectAssetFile(created.id, file(), 'GAME', undefined, binding(created))).rejects.toMatchObject({ status: 403 });
    await selectMockUser('owner'); await expect(uploadDirectAssetFile(999999, file(), 'GAME')).rejects.toMatchObject({ status: 404 });
    await expect(uploadDirectAssetFile({ type: 'EXHIBITION', id: 1 }, file('poster.png'), 'POSTER')).rejects.toMatchObject({ status: 403 });
    await updateMockState(state => { state.exhibitions.find(item => item.id === 1)!.isModificationEnabled = false; });
    await expect(uploadDirectAssetFile(created.id, file(), 'GAME', undefined, binding(created))).rejects.toMatchObject({ status: 403 });
  });
  it('preserves verification and processing after reload, then publishes canonical metadata', async () => {
    const created = await submit(); const progress: number[] = [];
    const completion = await uploadDirectAssetFile(created.id, file(), 'GAME', event => progress.push(event.percent), binding(created));
    expect(completion.status).toBe('VERIFYING'); expect(progress).toEqual([100]);
    await expect(finalize(created.id)).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    await vi.advanceTimersByTimeAsync(400); await forgetMockCacheForTests();
    expect(await getDirectAssetUploadStatus(completion.sessionId)).toMatchObject({ state: 'VERIFYING' });
    expect((await getMockSnapshot()).sessions[completion.sessionId]).toMatchObject({ processingState: 'PROCESSING' });
    await vi.advanceTimersByTimeAsync(600); expect((await status(created.id)).items[0]!.state).toBe('READY');
    expect(await finalize(created.id)).toMatchObject({ state: 'FINALIZING', publicationState: 'PROCESSING' });
    await forgetMockCacheForTests(); expect((await status(created.id)).state).toBe('FINALIZING');
    await vi.advanceTimersByTimeAsync(650); expect(await status(created.id)).toMatchObject({ state: 'PUBLISHED', projectStatus: 'PUBLISHED' });
    expect((await getMockSnapshot()).projects[created.id]!.assets[0]).toMatchObject({ kind: 'GAME', originalName: 'game.zip', size: 4, url: expect.stringContaining('/mock/files/game.zip') });
  });
  it('fails processing deterministically, retains failure on reload and supports replacement retry', async () => {
    const created = await submit(); await setMockControls({ worker: 'fail' });
    const completion = await uploadDirectAssetFile(created.id, file(), 'GAME', undefined, binding(created));
    await vi.advanceTimersByTimeAsync(400); expect((await status(created.id)).items[0]).toMatchObject({ state: 'FAILED' });
    await forgetMockCacheForTests(); expect((await getDirectAssetUploadStatus(completion.sessionId)).state).toBe('REJECTED');
    await setMockControls({ worker: 'auto' });
    const replacement = await uploadDirectAssetFile(created.id, file(), 'GAME', undefined, binding(created));
    expect(replacement.sessionId).not.toBe(completion.sessionId); await vi.advanceTimersByTimeAsync(950);
    expect((await status(created.id)).items[0]).toMatchObject({ state: 'READY', sessionId: replacement.sessionId });
    expect((await getDirectAssetUploadStatus(completion.sessionId)).state).toBe('REJECTED');
  });
  it('replaces a failed video processing result without duplicating canonical videos', async () => {
    const created = await submit('Failed video', manifest('VIDEO', 'video:0'));
    const first = await uploadDirectAssetFile(created.id, file('demo.webm'), 'VIDEO', undefined, binding(created));
    await vi.advanceTimersByTimeAsync(400); await getDirectAssetUploadStatus(first.sessionId);
    await setMockControls({ worker: 'fail' }); expect((await status(created.id)).items[0]).toMatchObject({ state: 'FAILED', playbackState: 'FAILED' });
    expect((await getMockSnapshot()).projects[created.id]!.video).toMatchObject({ playbackStatus: 'FAILED' });
    await setMockControls({ worker: 'auto' });
    await uploadDirectAssetFile(created.id, file('demo.webm'), 'VIDEO', undefined, binding(created));
    await vi.advanceTimersByTimeAsync(950); expect((await status(created.id)).items[0]).toMatchObject({ state: 'READY', playbackState: 'READY' });
    expect((await getMockSnapshot()).projects[created.id]!.videos).toHaveLength(1);
  });
  it('keeps a failed publication terminal until an explicit finalize retry', async () => {
    const created = await submit('Failed publication', []);
    await setMockControls({ worker: 'fail' }); await finalize(created.id); await vi.advanceTimersByTimeAsync(650);
    expect(await status(created.id)).toMatchObject({ state: 'FINALIZING', publicationState: 'FAILED' });
    await setMockControls({ worker: 'auto' }); await forgetMockCacheForTests(); await vi.advanceTimersByTimeAsync(1000);
    expect(await status(created.id)).toMatchObject({ state: 'FINALIZING', publicationState: 'FAILED' });
    expect(await finalize(created.id)).toMatchObject({ state: 'FINALIZING', publicationState: 'PROCESSING' });
    await vi.advanceTimersByTimeAsync(650); expect(await status(created.id)).toMatchObject({ state: 'PUBLISHED', publicationState: 'COMPLETED' });
  });
  it('cancels pending processing and prevents publication and old capabilities', async () => {
    const created = await submit(); const completion = await uploadDirectAssetFile(created.id, file(), 'GAME', undefined, binding(created));
    await request(`/api/me/projects/${created.id}/submission`, 'DELETE'); await vi.advanceTimersByTimeAsync(2000);
    expect((await status(created.id)).state).toBe('CANCELLED'); expect((await getDirectAssetUploadStatus(completion.sessionId)).state).toBe('CANCELLED');
    await expect(finalize(created.id)).rejects.toMatchObject({ status: 409 });
    await expect(uploadDirectAssetFile(created.id, file(), 'GAME', undefined, binding(created))).rejects.toMatchObject({ status: 409 });
  });
  it('validates source identity, binding, generation, checksum, parts, ETags and resumable expiry', async () => {
    const created = await submit(); const sourceFile = file(); const source = await createFileSourceIdentity(sourceFile);
    const createPath = `/api/admin/projects/${created.id}/direct-game-upload-sessions`;
    await expect(request(createPath, 'POST', { originalName: sourceFile.name, totalBytes: 4, ...source, sourceIdentity: '0'.repeat(64), ...binding(created) })).rejects.toMatchObject({ status: 400 });
    await expect(request(createPath, 'POST', { originalName: sourceFile.name, totalBytes: 4, ...source, submissionItem: { ...binding(created).submissionItem, clientToken: 'wrong' } })).rejects.toMatchObject({ status: 409 });
    const session = await request<DirectAssetUploadStatus>(createPath, 'POST', { originalName: sourceFile.name, totalBytes: 4, ...source, ...binding(created) });
    const partPath = `/api/admin/direct-asset-upload-sessions/${session.sessionId}/part-urls`;
    await expect(request(partPath, 'POST', { generation: 2, parts: [] })).rejects.toMatchObject({ status: 409 });
    await expect(request(partPath, 'POST', { generation: 1, parts: [{ partNumber: 2, checksumSha256: 'a'.repeat(43) + '=' }] })).rejects.toMatchObject({ status: 400 });
    const checksum = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', await sourceFile.arrayBuffer()))));
    const signed = await request<{ parts: Array<{ url: string; requiredHeaders: Record<string, string> }> }>(partPath, 'POST', { generation: 1, parts: [{ partNumber: 1, checksumSha256: checksum }] });
    expect((await mockFetch(signed.parts[0]!.url, { method: 'PUT', body: new Blob(['evil']), headers: signed.parts[0]!.requiredHeaders })).status).toBe(400);
    const put = await mockFetch(signed.parts[0]!.url, { method: 'PUT', body: sourceFile, headers: signed.parts[0]!.requiredHeaders }); expect(put.headers.get('etag')).toBeTruthy();
    await expect(request(`/api/admin/direct-asset-upload-sessions/${session.sessionId}/complete`, 'POST', { generation: 1, parts: [{ partNumber: 1, etag: 'wrong', sizeBytes: 4 }] })).rejects.toMatchObject({ status: 409 });
    await forgetMockCacheForTests();
    const completion = await uploadDirectAssetFile(created.id, sourceFile, 'GAME', undefined, { ...binding(created), resume: { ...session, kind: 'GAME' } }); expect(completion.status).toBe('VERIFYING');
    const extra = await submit('expired'); let resume: Parameters<typeof uploadDirectAssetFile>[4] extends { resume?: infer R } | undefined ? R : never;
    const abort = new AbortController();
    await expect(uploadDirectAssetFile(extra.id, sourceFile, 'GAME', undefined, { ...binding(extra), signal: abort.signal, onSession: value => { resume = value; abort.abort(); } })).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(3600001); await expect(uploadDirectAssetFile(extra.id, sourceFile, 'GAME', undefined, { resume: resume! })).rejects.toThrow('can be resumed');
    expect((await status(extra.id)).items[0]!.state).toBe('FAILED');
  });
  it('reflects video processing and ready image, poster, material and WebGL metadata', async () => {
    const kinds = ['VIDEO', 'IMAGE', 'POSTER', 'DOCUMENT', 'ATTACHMENT', 'WEBGL'] as const;
    for (const kind of kinds) {
      const slot = ['VIDEO', 'IMAGE', 'DOCUMENT', 'ATTACHMENT'].includes(kind) ? `${kind.toLowerCase()}:0` : kind.toLowerCase();
      const created = await submit(`Metadata ${kind}`, manifest(kind, slot));
      const completion = await uploadDirectAssetFile(created.id, file(`${kind.toLowerCase()}.bin`), kind, undefined, binding(created));
      await vi.advanceTimersByTimeAsync(400); await getDirectAssetUploadStatus(completion.sessionId);
      if (kind === 'VIDEO') expect((await getMockSnapshot()).projects[created.id]!.video).toMatchObject({ playbackStatus: 'PENDING' });
      await vi.advanceTimersByTimeAsync(600); expect((await status(created.id)).items[0]!.state).toBe('READY');
      const project = (await getMockSnapshot()).projects[created.id]!;
      if (kind === 'WEBGL') expect(project.webglDeployment).toMatchObject({ url: expect.stringContaining(`/mock/webgl/index.html?mock_project=${created.id}`) });
      else expect(project.assets[0]).toMatchObject({ kind, originalName: `${kind.toLowerCase()}.bin`, size: 4 });
      if (kind === 'VIDEO') expect(project.video).toMatchObject({ playbackStatus: 'READY', url: expect.stringContaining('/mock/files/demo.webm') });
      if (kind === 'POSTER') expect(project.poster!.original.url).toContain(`mock_project=${created.id}`);
      if (kind === 'DOCUMENT' || kind === 'ATTACHMENT') expect(project.attachments![0]).toMatchObject({ kind, sizeBytes: 4 });
    }
  });
  it('keeps change request uploads staged until approval processing completes and retries failure', async () => {
    await updateMockState(state => { const project = state.projects[1]!; project.status = 'PUBLISHED'; project.createdByUserId = 3; state.exhibitions.find(item => item.id === project.exhibitionId)!.isModificationEnabled = false; });
    const before = structuredClone((await getMockSnapshot()).projects[1]!);
    const draft = await request<ProjectChangeDetail>('/api/me/projects/1/change-requests', 'POST', { kind: 'EDIT', reason: 'Replace archive' });
    const updated = await request<ProjectChangeDetail>(`/api/me/change-requests/${draft.id}`, 'PATCH', { changes: { title: 'Approved update' }, manifest: manifest().map(({ kind, slot, clientToken }) => ({ kind, slot, clientToken })) });
    expect((await getMockSnapshot()).projects[updated.stagingProjectId!]).toMatchObject({ isChangeRequestDraft: true, status: 'DRAFT' });
    await selectMockUser('other');
    await expect(uploadDirectAssetFile(updated.stagingProjectId!, file(), 'GAME', undefined, { submissionItem: { id: updated.items[0]!.id, clientToken: updated.items[0]!.clientToken } })).rejects.toMatchObject({ status: 403 });
    await selectMockUser('owner');
    const completion = await uploadDirectAssetFile(updated.stagingProjectId!, file(), 'GAME', undefined, { submissionItem: { id: updated.items[0]!.id, clientToken: updated.items[0]!.clientToken } });
    await expect(request(`/api/me/change-requests/${draft.id}/submit`, 'POST')).rejects.toMatchObject({ status: 409 });
    await vi.advanceTimersByTimeAsync(950); await getDirectAssetUploadStatus(completion.sessionId);
    await request(`/api/me/change-requests/${draft.id}/submit`, 'POST');
    expect((await getMockSnapshot()).projects[1]).toEqual(before);
    await selectMockUser('ADMIN'); await setMockControls({ worker: 'fail' });
    expect(await request(`/api/admin/change-requests/${draft.id}/approve`, 'POST')).toMatchObject({ state: 'APPLYING' });
    await vi.advanceTimersByTimeAsync(800); await forgetMockCacheForTests();
    expect(await request(`/api/admin/change-requests/${draft.id}`)).toMatchObject({ state: 'FAILED' });
    expect((await getMockSnapshot()).projects[1]).toEqual(before);
    await setMockControls({ worker: 'auto' });
    expect(await request(`/api/admin/change-requests/${draft.id}/retry`, 'POST')).toMatchObject({ state: 'APPLYING' });
    await vi.advanceTimersByTimeAsync(800);
    expect(await request(`/api/admin/change-requests/${draft.id}`)).toMatchObject({ state: 'COMPLETED' });
    const project = await request('/api/admin/projects/1'); expect(AdminProjectDetailSchema.safeParse(project).success).toBe(true);
    const after = (await getMockSnapshot()).projects[1]!;
    expect(after.title).toBe('Approved update'); expect(after.assets.find(asset => asset.originalName === 'game.zip')).toMatchObject({ kind: 'GAME', size: 4 });
    expect((await getMockSnapshot()).projects[updated.stagingProjectId!]).toBeUndefined();
  });
  it('uploads exhibition posters as staff and pauses durable asset progress', async () => {
    await selectMockUser('OPERATOR'); await setMockControls({ worker: 'paused' });
    const completion = await uploadDirectAssetFile({ type: 'EXHIBITION', id: 1 }, file('poster.png'), 'POSTER');
    await vi.advanceTimersByTimeAsync(2000); await forgetMockCacheForTests(); expect((await getDirectAssetUploadStatus(completion.sessionId)).state).toBe('VERIFYING');
    await setMockControls({ worker: 'auto' }); expect((await getDirectAssetUploadStatus(completion.sessionId)).state).toBe('READY');
    expect((await getMockSnapshot()).exhibitions.find(item => item.id === 1)).toMatchObject({ posterOriginalName: 'poster.png', posterSize: 4 });
    await expect(cancelDirectAssetUploadSession(completion.sessionId)).rejects.toMatchObject({ status: 409 });
  });
});
