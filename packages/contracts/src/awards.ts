import { z } from 'zod';
export const AwardBuiltinKeySchema = z.enum(['medal', 'trophy', 'ribbon', 'laurel-gold', 'laurel-silver', 'laurel-bronze', 'laurel-slate']);
export const AwardSchema = z.object({
 id: z.number().int(), name: z.string(), sortOrder: z.number().int(),
 displayRank: z.number().int().positive().optional(),
 builtinKey: AwardBuiltinKeySchema.nullable(), assetId: z.number().int().nullable(), imageUrl: z.string().optional(),
});
export type Award = z.infer<typeof AwardSchema>;
const ids = z.array(z.number().int().positive()).max(10000).refine(v => new Set(v).size === v.length, 'Duplicate IDs');
export const AwardVersionSchema = z.object({ expectedVersion: z.number().int().nonnegative() }).strict();
export const AwardEditSchema = AwardVersionSchema.extend({
 name: z.string().transform(v => v.trim().replace(/\s+/g, ' ')).pipe(z.string().min(1).max(100)),
 builtinKey: AwardBuiltinKeySchema.nullable(), assetId: z.number().int().positive().nullable(),
}).refine(v => (v.builtinKey === null) !== (v.assetId === null), 'Choose exactly one asset');
export const AwardOrderSchema = AwardVersionSchema.extend({ awardIds: ids });
export const AwardRecipientsSchema = AwardVersionSchema.extend({ addProjectIds: ids, removeProjectIds: ids }).refine(v => !v.addProjectIds.some(id => v.removeProjectIds.includes(id)), 'Conflicting changes');
export const AwardStateSchema = z.object({
 projects: z.array(z.object({ id: z.number().int(), title: z.string(), members: z.array(z.object({ name: z.string(), studentId: z.string() })).optional() })),
 version: z.number().int(), items: z.array(AwardSchema.extend({ projectIds: z.array(z.number().int()) })),
 assets: z.array(z.object({ id: z.number().int(), name: z.string(), imageUrl: z.string().optional() })),
});
export type AwardState = z.infer<typeof AwardStateSchema>;
