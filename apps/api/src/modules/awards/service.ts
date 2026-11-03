import type { AwardState } from '@pcu/contracts';
import type { AwardChange, AwardRepository, AwardSnapshot } from './ports.js';
import { validateAwardChange } from './policy.js';
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
    validateAwardChange(snapshot, expectedVersion, change, projectIds, bucket);
    return change;
   }));
  },
 };
}
