import { materialGroups, type MaterialGroup } from '../../../components/project/editor/materialGroups';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { ProjectMaterialManager, MaterialPanel, MaterialUploadSummary } from '../../../components/project/editor/ProjectMaterialManager';
import { MaterialFileRow } from '../../../components/project/editor/MaterialFileRow';
import { classifyMaterialSelection } from '../../../components/project/editor/materialSelection';
import { studioFileHint } from '../../../components/project/editor/studioFileHint';
import { ProjectPosterPreview } from '../../../components/project/editor/ProjectPosterPreview';
import { WebglBuildGuideLink } from '../../../components/project/WebglBuildGuideLink';
import { FileUploadRow } from '../../../components/common/FileUploadRows';
import type { ProjectUploadQueue } from './useProjectUploadQueue';
import { useVideoConversionRetry } from './useVideoConversionRetry';
import { VideoFileRow } from './VideoFileRow';
import type { ProjectUploadKind } from '../../../lib/upload/project-files';

export function StudioEditMaterials({ queue, canEditContent, webglActions, canRetryVideos, videoRetryDisabled }: {
 queue: ProjectUploadQueue; canEditContent: boolean; webglActions?: ReactNode; canRetryVideos: boolean; videoRetryDisabled: boolean;
}) {
 const rows = useSyncExternalStore(queue.uploads.subscribe, queue.uploads.getSnapshot);
 const conversion = useVideoConversionRetry(queue.project.id, videoRetryDisabled || queue.locked);
 const [errors, setErrors] = useState<Record<string, string | null>>({});
 const [baseline] = useState(() => ({ assets: new Set(queue.storedAssets.map(asset => asset.id)), completed: new Set(queue.entries.filter(entry => entry.status === 'done').map(entry => entry.uploadId)), webgl: queue.project.webglDeployment?.id ?? queue.project.webglUrl }));
 const availableAssets = [...queue.storedAssets];
 const reflected = new Set<string>();
 const processingAssets = new Set<number>();
 // Restored completed entries already belong to stored assets, even before the queue's first sync effect.
 const completedEntries = queue.entries.filter(entry => entry.status === 'done' && !rows.some(row => row.id === entry.uploadId)).map(entry => ({ id: entry.uploadId, kind: entry.kind, name: entry.file.name, size: entry.file.size, phase: 'ready' }));
 for (const row of [...rows, ...completedEntries]) {
  const index = availableAssets.findIndex(asset => (!baseline.assets.has(asset.id) || baseline.completed.has(row.id)) && asset.kind === row.kind && asset.originalName === row.name && (row.size === undefined || asset.size === row.size));
  if (index >= 0) {
   const [asset] = availableAssets.splice(index, 1);
   if (row.phase === 'ready') reflected.add(row.id); else processingAssets.add(asset.id);
  }
  if (row.phase === 'ready' && row.kind === 'WEBGL' && queue.hasWebgl && (baseline.completed.has(row.id) || baseline.webgl !== (queue.project.webglDeployment?.id ?? queue.project.webglUrl))) reflected.add(row.id);
 }
 const select = (group: MaterialGroup, files: File[]) => {
  if (!canEditContent || queue.locked || !files.length) return;
  let error: string | null;
  try { const typed = classifyMaterialSelection(group, files); error = queue.add(files, group.id === 'poster' ? 'poster' : 'files', typed.map(item => item.kind)); }
  catch (cause) { error = (cause as Error).message; }
  setErrors(previous => ({ ...previous, [group.id]: error }));
 };
 const started = rows.some(row => row.phase !== 'waiting') || queue.locked;
 return <ProjectMaterialManager busy={queue.locked} firstKind={rows.find(row => row.phase !== 'ready')?.kind}
  summary={started && rows.length > 0 && <MaterialUploadSummary rows={rows}><button type="button" className="btn btn--danger btn--small" disabled={!canEditContent || !rows.some(row => ['waiting', 'checking', 'preparing', 'uploading', 'completing', 'verifying', 'cancel-unconfirmed'].includes(row.phase))} onClick={queue.cancelAll}>전체 업로드 중단</button></MaterialUploadSummary>}
  groups={materialGroups.map(group => {
   const matches = (kind: string) => (group.kinds as readonly string[]).includes(kind);
   const poster = group.id === 'poster';
   const entries = queue.entries.filter(entry => entry.status !== 'removed' && matches(entry.kind) && !reflected.has(entry.uploadId));
   const stored = queue.storedAssets.filter(asset => !processingAssets.has(asset.id)).filter(asset => poster ? asset.id === queue.project.posterAssetId || asset.kind === 'POSTER' : asset.id !== queue.project.posterAssetId && matches(asset.kind));
   const webgl = group.id === 'web' && queue.hasWebgl && !(baseline.webgl !== (queue.project.webglDeployment?.id ?? queue.project.webglUrl) && rows.some(row => row.kind === 'WEBGL' && row.phase !== 'ready'));
   const count = ['poster', 'native', 'web'].includes(group.id) ? Math.min(1, stored.length + entries.length + Number(webgl)) : stored.length + entries.length;
   const failed = !!errors[group.id] || rows.some(row => matches(row.kind) && ['failed', 'cancelled', 'cancel-unconfirmed'].includes(row.phase)) || (group.id === 'video' && (conversion.error !== null || queue.project.videos.some(video => video.playbackJob?.status === 'FAILED' || video.playbackStatus === 'FAILED')));
   return { id: group.id, count, failed, content: <MaterialPanel group={group} count={count} enabled={canEditContent && !queue.locked} hint={studioFileHint(group.kinds[0], queue.limits, queue.materialLimits)} error={errors[group.id]} onFiles={files => select(group, files)} actions={group.id === 'web' ? webglActions : undefined} help={group.id === 'web' ? <WebglBuildGuideLink /> : undefined}>
    {group.id === 'materials' && queue.configUnavailable && <p className="field-hint">자료 설정을 불러오지 못했습니다. <button type="button" className="btn btn--secondary btn--small" disabled={queue.configLoading || queue.locked} onClick={queue.retryConfig}>설정 재시도</button></p>}
    {stored.map(asset => asset.kind === 'VIDEO' ? <VideoFileRow material key={`stored-${asset.id}`} name={asset.originalName} size={asset.size} assetId={asset.id} video={queue.project.videos.find(video => video.assetId === asset.id)} conversion={conversion} canRetry={canRetryVideos} canDelete={canEditContent} deleteDisabled={queue.locked || conversion.busy !== null} removing={queue.removals.includes(asset.id)} onDelete={() => queue.toggleRemoval(asset.id)} /> : <MaterialFileRow key={`stored-${asset.id}`} name={asset.originalName} kind={poster ? 'POSTER' : asset.kind as ProjectUploadKind} size={asset.size} status={queue.removals.includes(asset.id) ? '삭제 예정' : entries.length > 0 && ['poster', 'native'].includes(group.id) ? '교체 예정' : '등록됨'} icon={poster && queue.project.poster ? <ProjectPosterPreview title={queue.project.title} image={queue.project.poster} trigger={<img src={queue.project.poster.original.url} alt="포스터" />} /> : undefined} actions={canEditContent ? [{ label: queue.removals.includes(asset.id) ? '삭제 취소' : '삭제', disabled: queue.locked, onClick: () => queue.toggleRemoval(asset.id) }] : []} />)}
    {webgl && <MaterialFileRow name="WebGL 배포" kind="WEBGL" status={queue.removeWebgl ? '삭제 예정' : entries.length ? '교체 예정' : '등록됨'} actions={canEditContent ? [{ label: queue.removeWebgl ? '삭제 취소' : '삭제', disabled: queue.locked, onClick: queue.toggleWebglRemoval }] : []} />}
    {entries.map(entry => {
     const row = rows.find(row => row.id === entry.uploadId);
     if (row && (row.phase !== 'waiting' || started || !(entry.file instanceof File))) return <FileUploadRow key={entry.uploadId} row={row} queue={queue.uploads} disabled={!queue.enabled} material />;
     return <MaterialFileRow key={entry.uploadId} name={entry.file.name} kind={entry.kind as ProjectUploadKind} size={entry.file.size} status="적용 시 업로드" error={queue.issues.get(entry.id)} actions={[{ label: '선택 취소', disabled: queue.locked || !canEditContent, onClick: () => queue.cancel(entry.id) }]} />;
    })}
   </MaterialPanel> };
  })} />;
}
