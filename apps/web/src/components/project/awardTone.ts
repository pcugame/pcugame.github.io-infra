import type { Award } from '@pcu/contracts';

export function awardTone(award: Award): string {
  return award.displayRank === 1 ? 'gold' : award.displayRank === 2 ? 'silver' : award.displayRank === 3 ? 'bronze' : 'sky';
}
export function orderedAwards(awards: Award[] = []): Award[] {
  return [...awards].sort((a, b) => (a.displayRank ?? Infinity) - (b.displayRank ?? Infinity) || a.sortOrder - b.sortOrder || a.id - b.id);
}
