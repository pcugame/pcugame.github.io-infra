import { expect, it } from 'vitest';
import { AwardEditSchema, AwardSchema } from './awards.js';

it.each(['laurel-gold', 'laurel-silver', 'laurel-bronze', 'laurel-slate', 'medal', 'trophy', 'ribbon'])('accepts %s for write and read contracts', builtinKey => {
 expect(AwardEditSchema.safeParse({ expectedVersion: 0, name: '특별상', builtinKey, assetId: null }).success).toBe(true);
 expect(AwardSchema.safeParse({ id: 1, sortOrder: 0, name: '특별상', builtinKey, assetId: null }).success).toBe(true);
});
it('keeps photos mutually exclusive with builtin icons and rejects unknown keys', () => {
 const input = { expectedVersion: 0, name: '대상', builtinKey: null, assetId: 42 };
 expect(AwardEditSchema.safeParse(input).success).toBe(true);
 expect(AwardEditSchema.safeParse({ ...input, builtinKey: 'laurel-gold' }).success).toBe(false);
 expect(AwardEditSchema.safeParse({ ...input, builtinKey: 'laurel-invalid', assetId: null }).success).toBe(false);
});

it('normalizes custom HEX colors, supports default reset and preserves omitted colors for older clients', () => {
 const edit = { expectedVersion: 0, name: 'Custom', builtinKey: 'laurel-gold', assetId: null };
 expect(AwardEditSchema.parse({ ...edit, color: '#7c3aed' }).color).toBe('#7C3AED');
 expect(AwardEditSchema.parse({ ...edit, color: null }).color).toBeNull();
 expect(AwardEditSchema.parse(edit)).not.toHaveProperty('color');
 for (const color of ['red', '#123', '#12345678', '#12345G', 'url(x)', '']) expect(AwardEditSchema.safeParse({ ...edit, color }).success).toBe(false);
});
