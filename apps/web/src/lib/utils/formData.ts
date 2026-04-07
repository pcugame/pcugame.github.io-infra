// ── FormData 직렬화 유틸 ─────────────────────────────────────
// POST /api/admin/projects/submit 등 multipart 요청 조립용

import type { SubmitProjectPayloadInput } from '../../contracts/schemas';

export interface SubmitProjectFiles {
  poster?: File;
  images?: File[];
  gameFile?: File;
  videoFile?: File;
}

/**
 * 작품 등록 폼 데이터를 multipart/form-data 로 변환한다.
 *
 * - `payload` 필드: JSON string
 * - `poster` 필드: 단일 파일
 * - `images[]` 필드: 복수 파일
 * - `gameFile` 필드: 단일 파일
 */
export function buildSubmitFormData(
  payload: SubmitProjectPayloadInput,
  files: SubmitProjectFiles,
): FormData {
  const fd = new FormData();

  // JSON payload
  fd.append('payload', JSON.stringify(payload));

  // 포스터
  if (files.poster) {
    fd.append('poster', files.poster);
  }

  // 이미지 배열
  if (files.images) {
    for (const img of files.images) {
      fd.append('images[]', img);
    }
  }

  // 게임 파일
  if (files.gameFile) {
    fd.append('gameFile', files.gameFile);
  }

  // 동영상 파일
  if (files.videoFile) {
    fd.append('videoFile', files.videoFile);
  }

  return fd;
}

/**
 * 기존 프로젝트에 자산 추가용 FormData 구성
 */
export function buildAssetFormData(kind: string, file: File): FormData {
  const fd = new FormData();
  fd.append('kind', kind);
  fd.append('file', file);
  return fd;
}

/**
 * 포스터 교체용 FormData
 */
export function buildPosterReplaceFormData(poster: File): FormData {
  const fd = new FormData();
  fd.append('poster', poster);
  return fd;
}
