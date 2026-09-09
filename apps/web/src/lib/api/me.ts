import type { ProjectSubmissionStatusResponse, SubmitProjectResponse } from '../../contracts';
import { api, uploadFormData } from './client';

export const userProjectApi = {
  submit(input: { formData: FormData; idempotencyKey: string }) {
    return uploadFormData<SubmitProjectResponse>(
      '/api/me/projects/submit',
      input.formData,
      {
        title: '작품 파일 업로드',
        processingMessage: '파일 전송 및 변환이 끝날 때까지 이 창을 닫거나 새로고침하지 마세요.',
        headers: { 'Idempotency-Key': input.idempotencyKey },
      },
    );
  },
  getSubmission(projectId: number) {
    return api.get<ProjectSubmissionStatusResponse>(`/api/me/projects/${projectId}/submission`);
  },
  finalizeSubmission(projectId: number) {
    return api.post<ProjectSubmissionStatusResponse>(`/api/me/projects/${projectId}/submission/finalize`);
  },
  cancelSubmission(projectId: number) {
    return api.delete<ProjectSubmissionStatusResponse>(`/api/me/projects/${projectId}/submission`);
  },
};
