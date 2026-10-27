import { z } from 'zod';

export const PublicationStatusSchema = z.enum(['PRIVATE', 'PUBLIC']);
export type PublicationStatus = z.infer<typeof PublicationStatusSchema>;
export const PublicationCommandSchema = z.object({
 status: PublicationStatusSchema,
 expectedVersion: z.number().int().positive(),
 exceptionReason: z.string().trim().min(1).max(2000).optional(),
}).strict();
export type PublicationCommand = z.infer<typeof PublicationCommandSchema>;
export const PublicationRequirementSchema = z.object({
 key: z.enum(['title', 'members', 'summary', 'platforms', 'poster', 'nativeBuild', 'video']),
 state: z.enum(['READY', 'MISSING', 'PROCESSING', 'FAILED']),
});
export const PublicationReadinessSchema = z.object({
 ready: z.boolean(),
 requirements: z.array(PublicationRequirementSchema),
 blockers: z.array(PublicationRequirementSchema.shape.key),
 canOverride: z.boolean(),
});
export type PublicationReadiness = z.infer<typeof PublicationReadinessSchema>;
export type PublicationSource = {
 title: string; summary?: string; platforms: readonly string[];
 members: readonly { name: string; studentId: string }[];
 poster: { status: string; representations?: readonly { role: string; state: string }[] } | null;
 assets: readonly { kind: string; status?: string; representations?: readonly { role: string; state: string }[] }[];
 assetUploads?: readonly { kind: string; state: string }[];
};
/** Shared by API and Web. READY media means verified bytes and, for video, playable output. */
export function publicationReadiness(source: PublicationSource, role?: string): PublicationReadiness {
 const ready = (asset: PublicationSource['assets'][number], rep: string) =>
  (asset.status === undefined || asset.status === 'READY') && asset.representations?.some(r => r.role === rep && r.state === 'READY');
 const media = (kind: string, complete: boolean): 'READY' | 'PROCESSING' | 'FAILED' | 'MISSING' => {
  if (complete) return 'READY';
  const uploads = source.assetUploads?.filter(u => u.kind === kind) ?? [];
  const assets = source.assets.filter(a => a.kind === kind);
  if (uploads.some(u => ['ALLOCATING', 'UPLOADING', 'COMPLETING', 'VERIFYING'].includes(u.state)) ||
   assets.some(a => a.representations?.some(r => ['PENDING', 'VERIFYING'].includes(r.state)))) return 'PROCESSING';
  if (uploads[0]?.state === 'REJECTED' || assets.some(a => a.representations?.some(r => r.state === 'FAILED'))) return 'FAILED';
  return 'MISSING';
 };
 const requirements: PublicationReadiness['requirements'] = [
  { key: 'title', state: source.title.trim() ? 'READY' : 'MISSING' },
  { key: 'members', state: source.members.length > 0 && source.members.every(m => m.name.trim() && m.studentId.trim()) ? 'READY' : 'MISSING' },
  { key: 'summary', state: source.summary?.trim() ? 'READY' : 'MISSING' },
  { key: 'platforms', state: source.platforms.length ? 'READY' : 'MISSING' },
  { key: 'poster', state: media('POSTER', !!source.poster && !!ready({ kind: 'POSTER', ...source.poster! }, 'ORIGINAL')) },
  { key: 'nativeBuild', state: media('GAME', source.assets.some(a => a.kind === 'GAME' && ready(a, 'ORIGINAL'))) },
  { key: 'video', state: media('VIDEO', source.assets.some(a => a.kind === 'VIDEO' && ready(a, 'ORIGINAL') && ready(a, 'PLAYBACK'))) },
 ];
 const blockers = requirements.filter(r => r.state !== 'READY').map(r => r.key);
 return { ready: blockers.length === 0, requirements, blockers, canOverride: role === 'ADMIN' };
}
