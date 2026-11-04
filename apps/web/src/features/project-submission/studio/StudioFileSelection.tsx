import { materialGroups, type MaterialGroup } from '../../../components/project/editor/materialGroups';
import { useState } from 'react';
import { ProjectMaterialManager, MaterialPanel, MaterialUploadSummary } from '../../../components/project/editor/ProjectMaterialManager';
import { MaterialFileRow } from '../../../components/project/editor/MaterialFileRow';
import { classifyMaterialSelection } from '../../../components/project/editor/materialSelection';
import { ProjectPosterPreview } from '../../../components/project/editor/ProjectPosterPreview';
import { WebglBuildGuideLink } from '../../../components/project/WebglBuildGuideLink';
import { FileUploadRow } from '../../../components/common/FileUploadRows';
import { studioFileHint } from '../../../components/project/editor/studioFileHint';
import type { ClientUploadLimits, MaterialUploadLimits } from '../../../lib/upload-limits';
import type { SubmissionFilesState } from '../useSubmissionFiles';
import type { useProjectSubmissionForm } from '../useProjectSubmissionForm';
import { selectedStudioFiles } from './fileGroups';
import { useStudioSubmissionUploads } from './useStudioSubmissionUploads';
import { getApiErrorMessage } from '../../../lib/api';

export function StudioFileSelection({ files, enabled, limits, materialLimits, retryConfig, submission, title = '작품' }: {
 files: SubmissionFilesState; enabled: boolean; limits: ClientUploadLimits; materialLimits?: MaterialUploadLimits; retryConfig: () => void;
 submission?: ReturnType<typeof useProjectSubmissionForm>; title?: string;
}) {
 const { queues, rows } = useStudioSubmissionUploads(files, submission);
 const [errors, setErrors] = useState<Record<string, string | null>>({});
 const selected = [...(files.posterFile ? [{ kind: 'POSTER' as const, file: files.posterFile }] : []), ...selectedStudioFiles(files)];
 const uploading = submission?.createdProjectId != null;
 const busy = !!(submission?.isSubmitting || submission?.showGameProgress);
 const select = (group: MaterialGroup, chosen: File[]) => {
  if (!enabled || !chosen.length) return;
  const error = (message: string | null) => setErrors(previous => ({ ...previous, [group.id]: message }));
  try {
   const typed = classifyMaterialSelection(group, chosen);
   if (group.id === 'poster') { error(null); files.selectPoster(chosen[0]); }
   else files.addFiles(typed.filter((item): item is typeof item & { kind: Exclude<typeof item.kind, 'POSTER'> } => item.kind !== 'POSTER'), error);
  } catch (cause) { error((cause as Error).message); }
 };
 const failure = submission?.submissionError ?? submission?.submitMutation.error;
 return <ProjectMaterialManager busy={busy} firstKind={rows.find(row => row.phase !== 'ready')?.kind ?? selected[0]?.kind}
  summary={busy && <>
   {uploading ? <MaterialUploadSummary rows={rows}><button type="button" className="btn btn--danger btn--small" onClick={() => void submission?.cancelSubmission()}>전체 업로드 중단</button></MaterialUploadSummary> : <p role="status">작품 정보를 저장하고 있습니다.</p>}
   {uploading && selected.length === 0 && rows.some(row => !row.file && row.phase === 'waiting') && <p className="field-hint">원본 파일을 다시 선택해 주세요. 완료된 파일은 유지됩니다.</p>}
   {failure != null && <p className="field-error" role="alert">{getApiErrorMessage(failure)}</p>}
   {submission?.canRetryStatus && <button type="button" className="btn btn--secondary" disabled={submission.isFinalizing} onClick={() => void submission.retryStatus()}>제출 상태 다시 확인</button>}
   {failure != null && uploading && <button type="button" className="btn btn--secondary" onClick={submission?.goToEdit}>작품에서 수정·재시도</button>}
  </>}
  groups={materialGroups.map(group => {
   const matches = (kind: string) => (group.kinds as readonly string[]).includes(kind);
   const chosen = selected.filter(item => matches(item.kind));
   const progress = rows.filter(row => matches(row.kind));
   const count = uploading ? submission!.submissionItems.filter(item => matches(item.kind)).length : chosen.length;
   return { id: group.id, count, failed: !!errors[group.id] || (group.id === 'poster' && !!files.fileSizeError) || progress.some(row => ['failed', 'cancel-unconfirmed', 'cancelled'].includes(row.phase)), content: <MaterialPanel group={group} count={count} enabled={enabled} onFiles={chosen => select(group, chosen)} hint={studioFileHint(group.kinds[0], limits, materialLimits)} error={errors[group.id] ?? (group.id === 'poster' ? files.fileSizeError : null)} help={group.id === 'web' ? <WebglBuildGuideLink /> : undefined}>
    {group.id === 'materials' && !materialLimits && <p className="field-hint">문서·첨부자료는 설정 조회 후 선택할 수 있습니다. <button type="button" className="btn btn--secondary btn--small" disabled={!enabled} onClick={retryConfig}>설정 다시 불러오기</button></p>}
    {uploading ? progress.map(row => <FileUploadRow key={row.id} row={row} queue={queues[row.kind]} material />) : chosen.map(({ kind, file }, index) => <MaterialFileRow key={`${kind}:${index}`} name={file.name} kind={kind} size={file.size} status="저장 시 업로드" icon={kind === 'POSTER' && files.posterPreview ? <ProjectPosterPreview title={title} localFile={file} trigger={<img src={files.posterPreview} alt="포스터" />} /> : undefined} actions={[{ label: '선택 취소', disabled: !enabled, onClick: () => { files.removeFile(kind, file); setErrors(previous => ({ ...previous, [group.id]: null })); } }]} />)}
   </MaterialPanel> };
  })} />;
}
