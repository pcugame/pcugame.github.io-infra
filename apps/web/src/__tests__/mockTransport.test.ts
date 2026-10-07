import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockHttpError, UNHANDLED } from '../lib/api/mock/context';
import type { MockContext, MockRequestOptions } from '../lib/api/mock/context';

const route = vi.hoisted(() => vi.fn());
vi.mock('../lib/api/mock/handler', () => ({ dispatchMockRequest: route }));
import { api, ApiError, getApiErrorCode } from '../lib/api/client';
import { getDirectAssetUploadStatus, uploadDirectAssetFile } from '../lib/api/game-upload';
import { forgetMockCacheForTests, getMockState, mockFetch, reloadMockState, resetMockState, selectMockUser, setMockControls, updateMockState, subscribeMockState } from '../lib/api/mock/transport';

beforeEach(async () => {
  vi.stubEnv('VITE_MOCK', 'true');
  route.mockReset();
  await resetMockState();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('mock HTTP response boundary', () => {
  it('uses production ApiError parsing for forbidden and unknown routes', async () => {
    route.mockImplementation(() => { throw new MockHttpError(403, 'FORBIDDEN', 'No access'); });
    try { await api.get('/api/private'); throw new Error('Expected error'); } catch (error) {
      expect(error).toBeInstanceOf(ApiError); expect(getApiErrorCode(error)).toBe('FORBIDDEN');
      expect(error).toMatchObject({ status: 403, body: { ok: false, error: { message: 'No access' } } });
    }
    route.mockReturnValue(UNHANDLED);
    await expect(api.get('/api/missing')).rejects.toMatchObject({ status: 404, body: { error: { code: 'NOT_FOUND' } } });
  });
  it.each([
    '/api/me/projects/submit', '/api/admin/projects/submit', '/api/me/projects/1/change-requests',
    '/api/me/projects/1/webgl-network-requests', '/api/admin/projects/1/members', '/api/admin/banned-ips',
    '/api/admin/projects/1/direct-game-upload-sessions',
  ])('matches HTTP Created for POST %s', async path => {
    route.mockReturnValue({id:1});
    expect((await mockFetch(path,{method:'POST',body:{}})).status).toBe(201);
  });
  it('passes PATCH JSON, headers, FormData and Blob, and parses 204', async () => {
    route.mockImplementation((_ctx: MockContext, _path: string, method: string, opts: MockRequestOptions) => {
      expect(method).toBe('PATCH'); expect(new Headers(opts.headers).get('x-test')).toBe('kept');
      expect(JSON.parse(opts.body as string)).toEqual({ title: 'changed' });
      return { saved: true };
    });
    await expect(api.patch('/api/project', { title: 'changed' }, { headers: { 'x-test': 'kept' } })).resolves.toEqual({ saved: true });
    const form = new FormData(); form.append('file', new Blob(['image']), 'image.png');
    route.mockImplementation((_ctx: MockContext, _path: string, _method: string, opts: MockRequestOptions) => {
      expect(opts.body).toBe(form); expect(new Headers(opts.headers).get('content-type')).toBeNull(); return undefined;
    });
    await expect(api.post('/api/form', form)).resolves.toBeUndefined();
    const blob = new Blob(['part']);
    route.mockImplementation((_ctx: MockContext, _path: string, _method: string, opts: MockRequestOptions) => {
      expect(opts.body).toBe(blob); return new Response(null, { headers: { ETag: '"mock-part"' } });
    });
    expect((await mockFetch('https://mock-storage.local/part', { method: 'PUT', body: blob })).headers.get('etag')).toBe('"mock-part"');
  });
  it('cancels delayed requests before dispatch and persistence', async () => {
    await setMockControls({ delayMs: 100 });
    const revision = getMockState()!.revision;
    const controller = new AbortController();
    const pending = api.patch('/api/project', {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(route).not.toHaveBeenCalled(); expect(getMockState()!.revision).toBe(revision);
  });
  it('rolls back domain mutations when a handler fails', async () => {
    const before = getMockState()!.settings.maxGameFileMb;
    route.mockImplementation((ctx: MockContext) => { ctx.state.settings.maxGameFileMb = 1; throw new MockHttpError(409, 'CONFLICT', 'Conflict'); });
    await expect(api.patch('/api/settings', {})).rejects.toMatchObject({ status: 409 });
    expect((await reloadMockState()).settings.maxGameFileMb).toBe(before);
  });
  it('runs the real upload-control 429 retry and preserves request headers', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    await setMockControls({ fault: { status: 429, code: 'RATE_LIMITED', message: 'Retry', retryAfter: '0' } });
    route.mockReturnValue({ sessionId: 'ready', state: 'READY' });
    await expect(getDirectAssetUploadStatus('ready')).resolves.toMatchObject({ state: 'READY' });
    expect(route).toHaveBeenCalledTimes(1); expect(getMockState()!.controls.fault).toBeNull();
  });
  it('retries UploadPart through the production ETag and capability-header boundary', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    await setMockControls({ fault: { status: 503, code: 'UNAVAILABLE', message: 'Retry part', method: 'PUT' } });
    let capabilities = 0;
    route.mockImplementation((_ctx: MockContext, path: string, method: string, opts: MockRequestOptions) => {
      if (path.endsWith('/direct-game-upload-sessions')) {
        const input = JSON.parse(opts.body as string);
        return { sessionId: 'parts', owner: { type: 'PROJECT', id: 1 }, generation: 1, partSizeBytes: 1024,
          totalParts: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), sourceIdentityAlgorithm: input.sourceIdentityAlgorithm, sourceIdentity: input.sourceIdentity };
      }
      if (path.endsWith('/part-urls')) {
        capabilities += 1;
        return { generation: 1, parts: [{ partNumber: 1, url: 'https://mock-storage.local/part', requiredHeaders: { 'x-capability': String(capabilities) } }] };
      }
      if (method === 'PUT') {
        expect(new Headers(opts.headers).get('x-capability')).toBe('2');
        expect(opts.body).toBeInstanceOf(Blob);
        return new Response(null, { headers: { ETag: '"part-etag"' } });
      }
      if (path.endsWith('/complete')) {
        expect(JSON.parse(opts.body as string).parts[0].etag).toBe('"part-etag"');
        return { state: 'VERIFYING', sessionId: 'parts' };
      }
      return UNHANDLED;
    });
    await expect(uploadDirectAssetFile(1, new File(['bytes'], 'game.zip'), 'GAME')).resolves.toMatchObject({ state: 'VERIFYING' });
    expect(capabilities).toBe(2);
  });
  it('leaves read-only revision and notifications unchanged across repeated reads', async () => {
    route.mockReturnValue({ items: [] });
    const revision = getMockState()!.revision;
    const changed = vi.fn(); const unsubscribe = subscribeMockState(changed);
    await Promise.all([api.get('/api/list'), api.get('/api/list'), api.get('/api/list')]);
    expect(getMockState()!.revision).toBe(revision); expect(changed).not.toHaveBeenCalled(); unsubscribe();
  });
  it('expires mock authentication and resets expiry on explicit user selection', async () => {
    await selectMockUser('owner');
    await updateMockState(state => { state.authExpiresAt = new Date(Date.now() - 1000).toISOString(); });
    route.mockImplementation((ctx: MockContext) => ctx.requireUser());
    await expect(api.get('/api/me/protected')).rejects.toMatchObject({ status: 401, body: { error: { code: 'UNAUTHORIZED' } } });
    await selectMockUser('owner');
    await expect(api.get('/api/me/protected')).resolves.toMatchObject({ id:3 });
  });
  it('retains snapshots across cache reload and serializes simultaneous mutations', async () => {
    await selectMockUser('participant');
    await forgetMockCacheForTests(); expect((await reloadMockState()).authUser).toBe('participant');
    route.mockImplementation(async (ctx: MockContext) => { const count = ctx.state.counters.test ?? 0; await Promise.resolve(); ctx.state.counters.test = count + 1; return count + 1; });
    await Promise.all([api.post('/api/count'), api.post('/api/count'), api.post('/api/count')]);
    expect((await reloadMockState()).counters.test).toBe(3);
  });
});
