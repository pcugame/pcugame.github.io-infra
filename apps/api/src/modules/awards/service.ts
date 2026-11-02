import type { AwardState } from '@pcu/contracts';
import type { AwardChange, AwardRepository, AwardSnapshot } from './ports.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { awardImageUrl, serializeAwards } from './serialization.js';
export function createAwardService(repository: AwardRepository, origin: string, bucket: string) {
 const serialize = (s: AwardSnapshot): AwardState => ({ projects: s.candidates, version: s.version,
  items: serializeAwards(s.items.map(award => ({ award: { ...award, exhibition: { awards: s.items } } })), origin, bucket).map(a => ({ ...a, projectIds: s.items.find(i => i.id === a.id)!.recipients.map(r => r.projectId) })),
  assets: s.assets.filter(a => a.status === 'READY').map(a => ({ id: a.id, name: a.originalName,
   imageUrl: awardImageUrl(a, origin, bucket) })),
 });
 return {
  read: async (id: number) => serialize(await repository.read(id)),
  async change(id: number | null, expectedVersion: number, change: AwardChange) {
   const projectIds = change.kind === 'project' ? [change.projectId] : change.kind === 'recipients' ? [...change.addProjectIds, ...change.removeProjectIds] : [];
   return serialize(await repository.mutate(id, projectIds, snapshot => {
    if (snapshot.version !== expectedVersion) throw conflict('수상 설정이 변경되었습니다. 다시 조회한 후 저장해 주세요.');
    if (snapshot.projects.length !== projectIds.length || snapshot.projects.some(p => p.exhibitionId !== snapshot.exhibitionId || p.staging)) throw badRequest('같은 전시회의 일반 작품만 지정할 수 있습니다.');
    if ('awardId' in change && change.awardId !== undefined && !snapshot.items.some(a => a.id === change.awardId)) throw notFound('Award not found');
    if (change.kind === 'create' || change.kind === 'edit') {
     if (snapshot.items.some(a => a.name === change.name && a.id !== change.awardId)) throw conflict('같은 이름의 상이 이미 있습니다.');
     if (change.assetId !== null && !snapshot.assets.some(a => a.id === change.assetId && a.kind === 'IMAGE' && a.status === 'READY' && a.projectId === null && a.exhibitionId === snapshot.exhibitionId)) throw badRequest('이 전시회의 처리 완료 이미지가 필요합니다.');
    }
    if (change.kind === 'order' || change.kind === 'project') {
     if (new Set(change.awardIds).size !== change.awardIds.length || change.awardIds.some(id => !snapshot.items.some(a => a.id === id)) || (change.kind === 'order' && change.awardIds.length !== snapshot.items.length)) throw badRequest('Invalid award IDs');
    }
    if (change.kind === 'asset-delete') {
     const refs = snapshot.items.filter(a => a.assetId === change.assetId);
     if (refs.length) throw conflict(`사용 중인 이미지: ${refs.map(a => a.name).join(', ')}`);
     if (!snapshot.assets.some(a => a.id === change.assetId)) throw notFound('Image not found');
    }
    return change;
   }));
  },
 };
}
