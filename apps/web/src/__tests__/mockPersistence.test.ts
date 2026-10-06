import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockContext, MockState } from '../lib/api/mock/context';
const route = vi.hoisted(() => vi.fn());
vi.mock('../lib/api/mock/handler', () => ({ dispatchMockRequest: route }));
import { forgetMockCacheForTests, mockFetch, reloadMockState, resetMockState, updateMockState } from '../lib/api/mock/transport';

async function externalSnapshot(update: (value: MockState) => void): Promise<void> {
  const connection = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('pcu-development-mock-v1', 1);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = connection.transaction('snapshots', 'readwrite');
      const store = transaction.objectStore('snapshots'); const request = store.get('current');
      request.onsuccess = () => { const value = request.result as MockState; update(value); store.put(value, 'current'); };
      transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
    });
  } finally { connection.close(); }
}
beforeEach(async () => {
  await forgetMockCacheForTests(); vi.stubGlobal('indexedDB', new IDBFactory());
  route.mockReset(); await resetMockState();
});
afterEach(async () => { vi.restoreAllMocks(); await forgetMockCacheForTests(); vi.unstubAllGlobals(); });

describe('IndexedDB mock snapshots', () => {
  it('awaits durable snapshot writes and reloads blobs and normalized state', async () => {
    const blob = new Blob(['durable bytes'], { type: 'text/plain' });
    await updateMockState(state => { state.fileTokens.blob = { blob }; state.authUser = 'owner'; });
    await forgetMockCacheForTests();
    const loaded = await reloadMockState();
    expect(loaded.authUser).toBe('owner');
    expect(await ((loaded.fileTokens.blob as {blob:Blob}).blob).text()).toBe('durable bytes');
    expect(loaded.projects[9001].createdByUserId).toBe(3);
  });
  it('rejects a stale transaction instead of overwriting an external revision', async () => {
    route.mockImplementation(async (ctx: MockContext) => {
      ctx.state.settings.maxGameFileMb = 111;
      await externalSnapshot(state => { state.revision += 1; state.settings.maxGameFileMb = 222; });
      return { saved: true };
    });
    const response = await mockFetch('/api/settings', { method: 'PATCH' });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: 'CONFLICT', details: { mockCode: 'MOCK_REVISION_CONFLICT' } } });
    expect((await reloadMockState()).settings.maxGameFileMb).toBe(222);
  });
  it('does not acknowledge or retain mutations when storage fails', async () => {
    const before = await reloadMockState();
    route.mockImplementation((ctx: MockContext) => { ctx.state.settings.maxGameFileMb = 123; return { saved: true }; });
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new DOMException('Disk full', 'QuotaExceededError'); });
    // A throwing put must abort the transaction instead of leaving the request hanging.
    const response = await mockFetch('/api/settings', { method: 'PATCH' });
    expect(response.status).toBe(500); spy.mockRestore();
    expect((await reloadMockState()).settings).toEqual(before.settings);
  });
  it('migrates version zero and allows reset recovery for a future snapshot', async () => {
    await externalSnapshot(state => { (state as unknown as {version:number}).version = 0; state.authUser = 'other'; });
    expect((await reloadMockState()).version).toBe(1); expect((await reloadMockState()).authUser).toBe('other');
    await externalSnapshot(state => { (state as unknown as {version:number}).version = 999; });
    await expect(reloadMockState()).rejects.toMatchObject({ code: 'MOCK_STORAGE_VERSION' });
    expect((await resetMockState()).version).toBe(1); expect((await reloadMockState()).version).toBe(1);
  });
});
