import { expect, it } from 'vitest';
import type { Award } from '@pcu/contracts';
import { awardTone, orderedAwards } from '../components/project/awardTone';

const award = (displayRank?: number): Award => ({ id: displayRank ?? 9, name: '상', sortOrder: 99, builtinKey: 'laurel-gold', assetId: null, displayRank });
it.each([[1, 'gold'], [2, 'silver'], [3, 'bronze'], [4, 'sky'], [7, 'sky'], [undefined, 'sky']] as const)('maps rank %s independently of icon and name', (rank, tone) => {
 expect(awardTone(award(rank))).toBe(tone);
});
it('selects the highest award without mutating the project', () => {
 const awards = [award(4), award(2)];
 expect(awardTone(orderedAwards(awards)[0])).toBe('silver');
 expect(awards[0].displayRank).toBe(4);
 expect(orderedAwards()).toEqual([]);
});
