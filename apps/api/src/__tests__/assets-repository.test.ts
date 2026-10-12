import { describe, expect, it } from 'vitest';
import { planAssetDeletion } from '../modules/assets/deletion.policy.js';
import type { AssetDeletionSnapshot } from '../modules/assets/ports.js';
const snapshot: AssetDeletionSnapshot = {
 id: 1, projectId: 7, kind: 'VIDEO', status: 'READY', representations: [], submissionState: null,
 project: { id: 7, exhibitionId: 1, creatorId: 1, status: 'PUBLISHED', isMember: false, posterAssetId: 1, version: 4 },
 videos: [{ id: 1, videoSortOrder: 0 }, { id: 2, videoSortOrder: 1 }],
};
describe('asset deletion snapshot policy', () => {
 it.each(['PENDING', 'VERIFYING', 'PROCESSING', 'READY', 'FAILED'] as const)('terminalizes %s with one version increment', status => {
  expect(planAssetDeletion({ ...snapshot, status }, { id: 1, role: 'USER' })).toMatchObject({ incrementVersion: true, clearPoster: true });
 });
 it.each(['DELETED', 'DELETING'] as const)('does not increment version again for %s', status => {
  expect(planAssetDeletion({ ...snapshot, status }, { id: 1, role: 'USER' }).incrementVersion).toBe(false);
 });
 it('removes the selected READY video and preserves remaining order', () => {
  expect(planAssetDeletion(snapshot, { id: 1, role: 'USER' }).videoIds).toEqual([2]);
 });
 it.each(['PENDING', 'FINALIZING'])('rejects videos in %s submissions', submissionState => {
  expect(() => planAssetDeletion({ ...snapshot, submissionState }, { id: 1, role: 'ADMIN' })).toThrow('submission cancellation');
 });
});
