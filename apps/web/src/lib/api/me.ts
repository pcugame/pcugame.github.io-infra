import type { SubmitProjectResponse } from '../../contracts';
import { uploadFormData } from './client';

export const userProjectApi = {
  submit(formData: FormData) {
    return uploadFormData<SubmitProjectResponse>(
      '/api/me/projects/submit',
      formData,
      {
        title: '작품 파일 업로드',
        processingMessage: '파일 전송 및 변환이 끝날 때까지 이 창을 닫거나 새로고침하지 마세요.',
      },
    );
  },
};
