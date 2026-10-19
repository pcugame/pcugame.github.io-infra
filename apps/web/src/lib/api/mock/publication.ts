import { publicationReadiness } from '@pcu/contracts';
import type { MockProject } from './context';
export function mockPublicationStatus(p: MockProject) {
 return p.publicationStatus ?? (p.status !== 'DRAFT' && p.visibility !== 'STAFF' ? 'PUBLIC' : 'PRIVATE');
}
export function mockPublicationReadiness(p: MockProject, role?: string) {
 return publicationReadiness({ title: p.title, summary: p.summary, platforms: p.platforms, members: p.members,
  poster: p.poster ? { status: 'READY', representations: ['ORIGINAL', 'CARD_480', 'DISPLAY_960'].map(role => ({ role, state: 'READY' })) } : null,
  assets: p.assets.map(asset => ({ kind: asset.kind, representations: [{ role: 'ORIGINAL', state: 'READY' }, ...('playbackStatus' in asset ? [{ role: 'PLAYBACK', state: asset.playbackStatus ?? 'PENDING' }] : [])] })),
 }, role);
}
