import { describe, expect, it, vi } from 'vitest';
import { createAssetsService } from '../modules/assets/service.js';
import type { AssetDeletionSnapshot, AssetDeletionUnitOfWork } from '../modules/assets/ports.js';
const snapshot: AssetDeletionSnapshot = {
 id: 41, projectId: 7, kind: 'GAME', status: 'READY', representations: [], submissionState: null, videos: [],
 project: { id: 7, exhibitionId: 1, creatorId: 1, status: 'PUBLISHED', isMember: false, posterAssetId: 41, version: 1 },
};
function harness() {
 const apply = vi.fn(async () => {});
 const committed = vi.fn();
 const deletion: AssetDeletionUnitOfWork = { async run(_id, _actor, operation) {
  const result = await operation({ snapshot, applyDeletion: apply }); committed(); return result;
 } };
 const wake = vi.fn(); const error = vi.fn();
 const service = createAssetsService({ protectedBucket: 'pcu-protected', repository: { findAssetByIdForDownload: vi.fn() }, deletion, checkDownloadLimit: vi.fn(), wakeDeletionWorker: wake, logger: { error } });
 return { service, apply, committed, wake, error };
}
describe('durable asset deletion callers', () => {
 it('wakes only after commit and returns the project identity', async () => {
  const h = harness();
  await expect(h.service.deleteAsset(41, { id: 1, role: 'USER' })).resolves.toEqual({ projectId: 7 });
  expect(h.apply).toHaveBeenCalledWith({ incrementVersion: true, clearPoster: true, videoIds: null, reason: 'asset-delete' });
  expect(h.committed.mock.invocationCallOrder[0]).toBeLessThan(h.wake.mock.invocationCallOrder[0]!);
 });
 it('does not wake or report success when outbox transaction fails', async () => {
  const h = harness(); h.apply.mockRejectedValueOnce(new Error('outbox failed'));
  await expect(h.service.deleteAsset(41, { id: 1, role: 'USER' })).rejects.toThrow('outbox failed');
  expect(h.wake).not.toHaveBeenCalled(); expect(h.committed).not.toHaveBeenCalled();
 });
 it('logs a failed wake after commit without losing the successful deletion', async () => {
  const h = harness(); h.wake.mockImplementationOnce(() => { throw new Error('wake failed'); });
  await expect(h.service.deleteAsset(41, { id: 1, role: 'USER' })).resolves.toEqual({ projectId: 7 });
  expect(h.committed).toHaveBeenCalledOnce(); expect(h.error).toHaveBeenCalledOnce();
 });
 it('denies an unrelated actor before applying any mutation', async () => {
  const h = harness();
  await expect(h.service.deleteAsset(41, { id: 2, role: 'USER' })).rejects.toMatchObject({ statusCode: 403 });
  expect(h.apply).not.toHaveBeenCalled();
 });
});
