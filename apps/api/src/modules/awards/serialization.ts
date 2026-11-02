import type { Award } from '@pcu/contracts';
import { publicObjectUrl } from '../../shared/public-origin.js';
import type { AwardAsset } from './ports.js';

export function awardImageUrl(asset: Pick<AwardAsset, 'representations'> | null | undefined, origin: string, bucket: string): string | undefined {
 // Badges and picker previews use the smallest rendition; keep legacy assets usable.
 for (const role of ['CARD_480', 'DISPLAY_960', 'ORIGINAL']) {
  const rep = asset?.representations.find(r => r.role === role && r.state === 'READY' && r.bucket === bucket);
  if (rep) return publicObjectUrl(origin, rep.objectKey);
 }
 return undefined;
}
export interface AwardLink { award: { id: number; name: string; sortOrder: number; builtinKey: string | null; assetId: number | null; exhibition?: { awards: { id: number; sortOrder: number }[] }; asset?: { representations: { role: string; state: string; bucket: string; objectKey: string }[] } | null } }
export const awardInclude = { include: { award: { include: { exhibition: { select: { awards: { select: { id: true, sortOrder: true } } } }, asset: { include: { representations: true } } } } } } as const;
export function serializeAwards(links: AwardLink[] = [], origin: string, bucket: string): Award[] {
 return links.map(({ award: a }) => {
  const ordered = a.exhibition?.awards.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const rank = ordered?.findIndex(item => item.id === a.id);
  const imageUrl = awardImageUrl(a.asset, origin, bucket);
  return { id: a.id, name: a.name, sortOrder: a.sortOrder, builtinKey: a.builtinKey as Award['builtinKey'], assetId: a.assetId,
   ...(rank !== undefined && rank >= 0 ? { displayRank: rank + 1 } : {}),
   ...(imageUrl ? { imageUrl } : {}) };
 }).sort((a,b) => a.sortOrder - b.sortOrder || a.id - b.id);
}
