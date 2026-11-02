import type { AwardState } from '@pcu/contracts';
import type { AwardChange, AwardRepository, AwardSnapshot } from './ports.js';
import { validateAwardChange } from './policy.js';
import { serializeAwards } from './serialization.js';
import { publicObjectUrl } from '../../shared/public-origin.js';
export function createAwardService(repository: AwardRepository, origin: string, bucket: string) {
 const serialize = (s: AwardSnapshot): AwardState => ({ projects: s.candidates, version: s.version,
  items: serializeAwards(s.items.map(award => ({ award })), origin, bucket).map(a => ({ ...a, projectIds: s.items.find(i => i.id === a.id)!.recipients.map(r => r.projectId) })),
  assets: s.assets.filter(a => a.status === 'READY').map(a => ({ id: a.id, name: a.originalName,
   imageUrl: a.representations.find(r => r.role === 'ORIGINAL' && r.state === 'READY' && r.bucket === bucket)
    ? publicObjectUrl(origin, a.representations.find(r => r.role === 'ORIGINAL' && r.state === 'READY' && r.bucket === bucket)!.objectKey) : undefined })),
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
