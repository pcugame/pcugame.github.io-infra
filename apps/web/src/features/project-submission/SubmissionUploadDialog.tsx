import { UploadFileRows } from '../../components/common/UploadFileRows';
import { useQuery } from '@tanstack/react-query';
import { getDirectAssetUploadStatus } from '../../lib/api/game-upload';
import { useCallback } from 'react';
import { ProjectUploadDialog } from '../../components/common/ProjectUploadDialog';
import { Button } from '../../components/ui';
import { getApiErrorMessage } from '../../lib/api';
import { SubmissionUploadProgress } from './SubmissionUploadProgress';
import { studioFileGroups } from './studio/fileGroups';
import type { useProjectSubmissionForm } from './useProjectSubmissionForm';
import type { SubmissionFilesState } from './useSubmissionFiles';

export function SubmissionUploadDialog({ submission, files, title }: {
 submission: ReturnType<typeof useProjectSubmissionForm>; files: SubmissionFilesState; title: string;
}) {
 const { createdProjectId, finalizeIfReady, submissionItems, showGameProgress, isSubmitting } = submission;
 const missingNames = submissionItems.filter(item => item.sessionId && !submission.createdSubmission?.fileNames?.[item.slot]);
 const recoveredNames = useQuery({
  queryKey: ['submission-file-names', createdProjectId, missingNames.map(item => item.sessionId)],
  enabled: showGameProgress && missingNames.length > 0,
  staleTime: Infinity,
  retry: false,
  queryFn: async ({ signal }) => {
   const results = await Promise.allSettled(missingNames.map(async item => {
    const status = await getDirectAssetUploadStatus(item.sessionId!, signal);
    return [item.slot, status.originalName] as const;
   }));
   return Object.fromEntries(results.flatMap(result => result.status === 'fulfilled' && result.value[1] ? [result.value] : []));
  },
 });
 const fileNames = { ...recoveredNames.data, ...submission.createdSubmission?.fileNames };
 const onComplete = useCallback(() => {
  if (createdProjectId !== null) void finalizeIfReady(createdProjectId);
 }, [createdProjectId, finalizeIfReady]);
 const error = submission.submissionError ?? submission.submitMutation.error;
 const selectedNames = [files.posterFile, files.gameFile, files.webglFile, ...files.videoFiles, ...files.imageFiles, ...files.documentFiles, ...files.attachmentFiles].flatMap(file => file ? [file.name] : []);
 const completed = submissionItems.filter(item => item.state === 'READY').length;
 if (!isSubmitting && !showGameProgress) return null;
 return <ProjectUploadDialog open={isSubmitting || showGameProgress} busy={isSubmitting || showGameProgress}
  title={createdProjectId === null ? '업로드 준비 중' : '파일 업로드'}
  description={`${title || '작품'} · 파일 전송과 검증이 모두 끝나면 작품이 공개됩니다.`}
  completed={completed} total={createdProjectId === null ? selectedNames.length : submissionItems.length}
  actions={showGameProgress && <Button variant="danger" size="small" onClick={() => void submission.cancelSubmission()}>전체 취소</Button>}>
  {showGameProgress && selectedNames.length === 0 && submissionItems.some(item => item.state !== 'READY' && item.state !== 'VERIFYING') && <p className="project-upload-dialog__recovery">업로드가 중단되었습니다. ‘파일 선택’을 누르고 동일한 파일을 다시 선택해 주세요.</p>}
  {error != null && <div className="error-box" role="alert">{getApiErrorMessage(error)}</div>}
  {submission.canRetryStatus && <Button disabled={submission.isFinalizing} onClick={() => void submission.retryStatus()}>제출 상태 다시 확인</Button>}
  {import.meta.env.VITE_MOCK === 'true' && submission.canRetryPublication && <Button disabled={submission.isFinalizing} onClick={() => void submission.retryPublication()}>Mock 발행 다시 시도</Button>}
  {createdProjectId === null ? <><UploadFileRows names={selectedNames} /><p role="status">작품 정보를 저장하고 있습니다.</p></> : <>
   <SubmissionUploadProgress zone="poster" projectId={createdProjectId} fileNames={fileNames} files={files} items={submissionItems} onComplete={onComplete} />
   {studioFileGroups.map(group => <SubmissionUploadProgress key={group.id} zone="files" group={group} projectId={createdProjectId} fileNames={fileNames} files={files} items={submissionItems} onComplete={onComplete} />)}
   {completed === submissionItems.length && <p role="status">파일 검증이 끝났습니다. 작품 등록을 마무리하고 있습니다.</p>}
  </>}
 </ProjectUploadDialog>;
}
