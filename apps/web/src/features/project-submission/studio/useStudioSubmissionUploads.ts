import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useMe } from '../../auth';
import { getDirectAssetUploadStatus } from '../../../lib/api/game-upload';
import { FileUploadQueue, type FileUploadRowState, type FileUploadSpec } from '../../../lib/upload/fileUploadQueue';
import { uploadKindLabels } from '../../../lib/upload/project-files';
import type { useProjectSubmissionForm } from '../useProjectSubmissionForm';
import type { SubmissionFilesState } from '../useSubmissionFiles';

/** One owner for all kinds. Navigation never rebinds, detaches or starts a transfer. */
export function useStudioSubmissionUploads(files: SubmissionFilesState, submission?: ReturnType<typeof useProjectSubmissionForm>) {
 const { user } = useMe();
 const projectId = submission?.createdProjectId;
 const items = submission?.submissionItems;
 const savedNames = submission?.createdSubmission?.fileNames;
 const finalize = submission?.finalizeIfReady;
 const owner = useMemo(() => {
  return createUploadOwner(String(user?.id ?? 'current-user'), user?.role === 'USER' ? 'user' : 'admin', projectId);

 }, [projectId, user?.id, user?.role]);
 const rows = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
 useEffect(() => { const off = owner.all.map(queue => queue.attach()); return () => off.forEach(stop => stop()); }, [owner]);
 const complete = useCallback(() => { if (projectId != null) void finalize?.(projectId); }, [projectId, finalize]);
 useEffect(() => { owner.all.forEach(queue => queue.setOnReady(complete)); return () => owner.all.forEach(queue => queue.setOnReady(undefined)); }, [owner, complete]);
 const missing = items?.filter(item => item.sessionId && !savedNames?.[item.slot]) ?? [];
 const recovered = useQuery({
  queryKey: ['submission-file-names', projectId, missing.map(item => item.sessionId)], enabled: projectId != null && missing.length > 0, staleTime: Infinity, retry: false,
  queryFn: async ({ signal }) => {
   const results = await Promise.allSettled(missing.map(async item => [item.slot, (await getDirectAssetUploadStatus(item.sessionId!, signal)).originalName] as const));
   return Object.fromEntries(results.flatMap(result => result.status === 'fulfilled' && result.value[1] ? [result.value] : []));
  },
 });
 const { posterFile, gameFile, webglFile, videoFiles, imageFiles, documentFiles, attachmentFiles } = files;
 useEffect(() => {
  if (projectId == null || !items) return;
  const selected = { POSTER: posterFile ? [posterFile] : [], GAME: gameFile ? [gameFile] : [], WEBGL: webglFile ? [webglFile] : [], VIDEO: videoFiles, IMAGE: imageFiles, DOCUMENT: documentFiles, ATTACHMENT: attachmentFiles };
  const specs: FileUploadSpec[] = Object.entries(selected).flatMap(([kind, chosen]) => [...items].filter(item => item.kind === kind).sort((a, b) => a.slot.localeCompare(b.slot, undefined, { numeric: true })).map((item, index) => ({
   id: item.id, owner: { type: 'PROJECT', id: projectId }, kind: item.kind, binding: item, file: chosen[index], name: chosen[index]?.name ?? savedNames?.[item.slot] ?? recovered.data?.[item.slot] ?? `${uploadKindLabels[item.kind]} ${index + 1}`, size: chosen[index]?.size,
   legacyKey: kind === 'GAME' || kind === 'WEBGL' ? `pcu.direct-asset-upload:${projectId}:${kind}` : kind === 'IMAGE' || kind === 'POSTER' ? `pcu.direct-${kind.toLowerCase()}-upload:PROJECT:${projectId}` : `pcu.direct-${kind.toLowerCase()}-upload:${projectId}`,
  })));
  for (const [kind, queue] of Object.entries(owner.queues)) { queue.sync(specs.filter(spec => spec.kind === kind)); void queue.start(); }
 }, [owner, projectId, items, savedNames, recovered.data, posterFile, gameFile, webglFile, videoFiles, imageFiles, documentFiles, attachmentFiles]);
 return { queues: owner.queues, rows };
}

function createUploadOwner(scope: string, mode: 'user' | 'admin', projectId: number | null | undefined) {
  const kinds = ['POSTER', 'GAME', 'WEBGL', 'VIDEO', 'IMAGE', 'DOCUMENT', 'ATTACHMENT'] as const;
  const queues = Object.fromEntries(kinds.map(kind => [kind, new FileUploadQueue(scope, mode, `${projectId}:${kind}`)])) as Record<typeof kinds[number], FileUploadQueue>;
  const all = Object.values(queues);
  let snapshots: FileUploadRowState[][] = [];
  let combined: FileUploadRowState[] = [];
  return { queues, all, subscribe: (notify: () => void) => { const off = all.map(queue => queue.subscribe(notify)); return () => off.forEach(stop => stop()); }, getSnapshot: () => {
   const next = all.map(queue => queue.getSnapshot());
   if (next.some((rows, index) => rows !== snapshots[index])) { snapshots = next; combined = next.flat(); }
   return combined;
  } };
}
