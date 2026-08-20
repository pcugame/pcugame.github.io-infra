import type { SubmitProjectPayload, SubmitProjectResponse } from '../../contracts';
import { api, uploadFormData } from './client';

export const userProjectApi = {
  submit(input: { payload: SubmitProjectPayload; idempotencyKey: string }) {
    return api.post<SubmitProjectResponse>(
      '/api/me/projects/submit',
      input.payload,
      { headers: { 'Idempotency-Key': input.idempotencyKey } },
    );
  },

  addAsset(input: { projectId: number; formData: FormData; idempotencyKey: string }) {
    return uploadFormData<{ assetId: number }>(
      `/api/me/projects/${input.projectId}/assets`,
      input.formData,
      {
        title: '소형 자산 업로드',
        processingMessage: '이미지 전송과 변환을 진행하고 있습니다.',
        headers: { 'Idempotency-Key': input.idempotencyKey },
      },
    );
  },
};
