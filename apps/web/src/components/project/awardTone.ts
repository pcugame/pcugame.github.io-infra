import type { CSSProperties } from 'react';
import type { Award } from '@pcu/contracts';

export function awardTone(award: Award): string {
  return award.displayRank === 1 ? 'gold' : award.displayRank === 2 ? 'silver' : award.displayRank === 3 ? 'bronze' : 'sky';
}
export function orderedAwards(awards: Award[] = []): Award[] {
  return [...awards].sort((a, b) => (a.displayRank ?? Infinity) - (b.displayRank ?? Infinity) || a.sortOrder - b.sortOrder || a.id - b.id);
}

/** Custom colors override the default rank palette without changing award order. */
export function awardStyle(award?: Award): CSSProperties | undefined {
  if (!award?.color || !/^#[0-9a-f]{6}$/i.test(award.color)) return undefined;
  return {
    '--award-border': award.color,
    '--award-glint': `color-mix(in srgb, ${award.color} 35%, white)`,
  } as CSSProperties;
}
