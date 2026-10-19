import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { StudioFileGroup } from './studio/fileGroups';
import type { ProjectSubmissionItemStatus } from '../../contracts';
import { FileUploadRows } from '../../components/common/FileUploadRows';
import { FileUploadQueue, type FileUploadSpec } from '../../lib/upload/fileUploadQueue';
import { uploadKindLabels, type ProjectUploadKind } from '../../lib/upload/project-files';
import type { SubmissionFilesState } from './useSubmissionFiles';

function KindUploads({ projectId, kind, items, selected, fileNames, onComplete }: {
 projectId: number; kind: ProjectUploadKind; items: ProjectSubmissionItemStatus[]; selected: readonly File[];
 fileNames: Record<string, string>; onComplete: () => void;
}) {
 const client = useQueryClient();
 const user = client.getQueryData<{ user?: { id: number; role: string } }>(['me'])?.user;
 const queue = useMemo(() => new FileUploadQueue(String(user?.id ?? 'current-user'), user?.role === 'USER' ? 'user' : 'admin', `${projectId}:${kind}`), [projectId, kind, user?.id, user?.role]);
 const rows = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
 useEffect(() => queue.attach(), [queue]);
 useEffect(() => { queue.setOnReady(onComplete); return () => { queue.setOnReady(undefined); }; }, [queue, onComplete]);
 useEffect(() => {
  const legacyKey = kind === 'GAME' || kind === 'WEBGL' ? `pcu.direct-asset-upload:${projectId}:${kind}`
   : kind === 'IMAGE' || kind === 'POSTER' ? `pcu.direct-${kind.toLowerCase()}-upload:PROJECT:${projectId}` : `pcu.direct-${kind.toLowerCase()}-upload:${projectId}`;
  const specs: FileUploadSpec[] = items.map((item, index) => ({
   id: item.id, owner: { type: 'PROJECT', id: projectId }, kind, binding: item, legacyKey,
   file: selected[index], name: selected[index]?.name ?? fileNames[item.slot] ?? `${uploadKindLabels[kind]} ${index + 1}`, size: selected[index]?.size,
  }));
  queue.sync(specs);
  void queue.start();
 }, [queue, projectId, kind, items, selected, fileNames]);
 // The parent status refresh changes bindings, never a row's queue position or identity.
 return <li data-completed={rows.filter(row => row.phase === 'ready').length}><FileUploadRows queue={queue} /></li>;
}
export function SubmissionUploadProgress({ zone, group, fileNames = {}, projectId, files, items, onComplete }: {
 zone: 'poster' | 'files'; group?: StudioFileGroup; fileNames?: Record<string, string>; projectId: number;
 files: SubmissionFilesState; items: ProjectSubmissionItemStatus[]; onComplete: () => void;
}) {
 const kinds = group?.kinds ?? (zone === 'poster' ? ['POSTER'] as const : ['GAME', 'WEBGL', 'VIDEO', 'IMAGE', 'DOCUMENT', 'ATTACHMENT'] as const);
 const ordered = [...items].sort((a, b) => a.slot.localeCompare(b.slot, undefined, { numeric: true }));
 return <ul className="project-upload-queue" aria-label={group ? `${group.label} 업로드 진행` : zone === 'poster' ? '포스터 업로드 진행' : '파일 업로드 진행'}>
  {kinds.map(kind => {
   const kindItems = ordered.filter(item => item.kind === kind);
   if (!kindItems.length) return null;
   const selected = kind === 'POSTER' ? files.posterFile ? [files.posterFile] : [] : kind === 'GAME' ? files.gameFile ? [files.gameFile] : []
    : kind === 'WEBGL' ? files.webglFile ? [files.webglFile] : [] : kind === 'VIDEO' ? files.videoFiles : kind === 'IMAGE' ? files.imageFiles : kind === 'DOCUMENT' ? files.documentFiles : files.attachmentFiles;
   return <KindUploads key={kind} projectId={projectId} kind={kind} items={kindItems} selected={selected} fileNames={fileNames} onComplete={onComplete} />;
  })}
 </ul>;
}
