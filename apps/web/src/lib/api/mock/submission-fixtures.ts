import type { ProjectSubmissionItemStatus } from '../../../contracts';
import type { MockProject } from './context';
import type { MockSubmissionRecord } from './uploads';

/** Existing draft fixtures already own processed assets; represent that same state in the submission UI. */
export function createSeedSubmissions(projects: Record<number, MockProject>): Record<string, MockSubmissionRecord> {
  const result: Record<string, MockSubmissionRecord> = {};
  for (const project of Object.values(projects)) {
    if (project.status !== 'DRAFT' || project.isChangeRequestDraft) continue;
    const counts: Record<string, number> = {};
    const items: ProjectSubmissionItemStatus[] = [];
    const add = (kind: ProjectSubmissionItemStatus['kind']) => {
      const index = counts[kind] ?? 0; counts[kind] = index + 1;
      const singleton = ['GAME', 'WEBGL', 'POSTER'].includes(kind);
      if (singleton && index > 0) return;
      items.push({ id: crypto.randomUUID(), kind, slot: singleton ? kind.toLowerCase() : `${kind.toLowerCase()}:${index}`,
        clientToken: crypto.randomUUID().replaceAll('-', ''), required: true, state: 'READY', ...(kind === 'VIDEO' ? { playbackState: 'READY' as const } : {}) });
    };
    for (const asset of project.assets) if (asset.kind !== 'THUMBNAIL') add(asset.kind);
    if (project.webglUrl) add('WEBGL');
    result[project.id] = { submissionId: crypto.randomUUID(), projectId: project.id, projectStatus: 'DRAFT', state: 'PENDING',
      actorId: project.createdByUserId, createdAt: project.createdAt, items };
  }
  return result;
}
