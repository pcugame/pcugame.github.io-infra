import { expect, it } from 'vitest';
import { rebuildProjectPublicationPlan } from './plan-builder.js';

it.each([['ORIGINAL'], ['ORIGINAL', 'CARD_480', 'DISPLAY_960']])('publishes validated image roles %j without requiring derivatives', async (...roles: string[]) => {
 const representations = roles.map(role => ({
  id: role, assetId: 1, role, state: 'READY', bucket: 'protected', objectKey: `staged/${role}`,
  publicationBucket: 'public', publicationObjectKey: `images/${role}`, sizeBytes: 12n,
  checksumAlgorithm: 'SHA256', checksum: 'a'.repeat(64), mimeType: 'image/webp',
  sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'identity',
 }));
 const item = {
  id: 'item', required: true, state: 'READY', kind: 'POSTER', resultAssetId: 1,
  resultRepresentationId: 'ORIGINAL', boundGeneration: 1,
  resultAsset: { id: 1, projectId: 7, exhibitionId: null, kind: 'POSTER', status: 'READY', representations },
  resultRepresentation: representations[0],
  uploadSession: { state: 'READY', generation: 1, resultAssetId: 1, resultRepresentationId: 'ORIGINAL',
   sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'identity' },
 };
 const tx = {
  storageBucket: { findUnique: async ({ where }: { where: { visibility: string } }) => ({ bucket: where.visibility.toLowerCase() }) },
  projectSubmissionItem: { findMany: async () => [item] },
 };
 const plan = await rebuildProjectPublicationPlan(tx as never, { projectId: 7, submissionId: 'submission' });
 expect(plan.objects).toHaveLength(roles.length);
 expect(plan.representations.map(r => r.role)).toEqual(roles);
 item.uploadSession.sourceIdentity = 'changed';
 await expect(rebuildProjectPublicationPlan(tx as never, { projectId: 7, submissionId: 'submission' })).rejects.toThrow('fence');
});
