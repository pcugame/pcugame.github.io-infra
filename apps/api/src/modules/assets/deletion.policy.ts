import type { Actor } from '../../application/http-input.js';
import { conflict, forbidden } from '../../shared/errors.js';
import { assertWriteAccess } from '../admin/project-access.policy.js';
import type { AssetDeletionSnapshot, AssetDeletionPlan } from './ports.js';
import { assertVideoCount } from './video-order.policy.js';

export function planAssetDeletion(snapshot: AssetDeletionSnapshot, actor: Actor): AssetDeletionPlan {
 const project = snapshot.project;
 assertWriteAccess(actor.role, project.creatorId, actor.id, {
  isMember: project.isMember, isModificationEnabled: project.isModificationEnabled,
 });
 if (project.isChangeRequestDraft) throw forbidden('Staged change-request projects cannot be modified through project routes');
 if (snapshot.kind === 'VIDEO' && ['PENDING', 'FINALIZING'].includes(snapshot.submissionState ?? '')) {
  throw conflict('Submission videos must be removed through submission cancellation');
 }
 const videoIds = snapshot.kind === 'VIDEO' && snapshot.status === 'READY'
  ? snapshot.videos.filter(video => video.id !== snapshot.id).map(video => video.id) : null;
 if (videoIds) assertVideoCount(videoIds.length);
 return {
  incrementVersion: snapshot.status !== 'DELETED' && snapshot.status !== 'DELETING',
  clearPoster: project.posterAssetId === snapshot.id,
  videoIds,
  reason: 'asset-delete',
 };
}
