import type { Award } from '@pcu/contracts';
import { publicObjectUrl } from '../../shared/public-origin.js';
export interface AwardLink { award: { id: number; name: string; sortOrder: number; builtinKey: string | null; assetId: number | null; asset?: { representations: { role: string; state: string; bucket: string; objectKey: string }[] } | null } }
export function serializeAwards(links: AwardLink[] = [], origin: string, bucket: string): Award[] {
 return links.map(({ award: a }) => {
  const rep = a.asset?.representations.find(r => r.role === 'ORIGINAL' && r.state === 'READY' && r.bucket === bucket);
  return { id: a.id, name: a.name, sortOrder: a.sortOrder, builtinKey: a.builtinKey as Award['builtinKey'], assetId: a.assetId,
   ...(rep ? { imageUrl: publicObjectUrl(origin, rep.objectKey) } : {}) };
 }).sort((a,b) => a.sortOrder - b.sortOrder || a.id - b.id);
}
