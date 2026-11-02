import { describe, expect, it } from 'vitest';
import { awardImageUrl, serializeAwards } from './serialization.js';

const origin = 'https://assets.example.test';
const bucket = 'pcu-public';
const rep = (role: string, state = 'READY', storageBucket = bucket) => ({
 role, state, bucket: storageBucket, objectKey: `awards/${role}.webp`,
});

describe('award image selection', () => {
 it.each([
  { reps: [rep('ORIGINAL'), rep('DISPLAY_960'), rep('CARD_480')], selected: 'CARD_480' },
  { reps: [rep('CARD_480', 'PENDING'), rep('DISPLAY_960'), rep('ORIGINAL')], selected: 'DISPLAY_960' },
  { reps: [rep('CARD_480', 'FAILED'), rep('DISPLAY_960', 'READY', 'pcu-protected'), rep('ORIGINAL')], selected: 'ORIGINAL' },
  { reps: [rep('CARD_480', 'READY', 'pcu-protected'), rep('ORIGINAL', 'DELETED')], selected: undefined },
  { reps: [], selected: undefined },
 ])('selects $selected from eligible public representations', ({ reps, selected }) => {
  expect(awardImageUrl({ representations: reps }, origin, bucket)).toBe(selected ? `${origin}/awards/${selected}.webp` : undefined);
 });
 it('keeps builtin badges and empty award lists intact', () => {
  expect(serializeAwards([], origin, bucket)).toEqual([]);
  const award = { id: 1, name: 'Winner', sortOrder: 0, builtinKey: 'medal', assetId: null, asset: null };
  expect(serializeAwards([{ award }], origin, bucket)).toEqual([{ id: 1, name: 'Winner', sortOrder: 0, builtinKey: 'medal', assetId: null }]);
 });
});

it('ranks against all exhibition awards including gaps and unassigned awards', () => {
 const awards = [{ id: 3, sortOrder: 90 }, { id: 2, sortOrder: 20 }, { id: 1, sortOrder: 20 }];
 const award = { id: 3, name: 'Third', sortOrder: 90, builtinKey: 'medal', assetId: null, exhibition: { awards } };
 expect(serializeAwards([{ award }], origin, bucket)[0].displayRank).toBe(3);
 expect(awards.map(a => a.id)).toEqual([3, 2, 1]);
});
