import type { LabResult, LabRun } from '@pcu/contracts';

export const runLabels: Record<LabRun['status'], string> = {
  QUEUED: '대기', RUNNING: '진행 중', COMPLETED: '완료', CANCELLED: '취소',
};
export const resultLabels: Record<LabResult['status'], string> = {
  PENDING: '대기', RUNNING: '처리 중', SUCCEEDED: '성공', FAILED: '실패', CANCELLED: '취소',
};
export function runLabel(run: LabRun) {
  return `${new Date(run.createdAt).toLocaleString('ko-KR')} · ${run.size}개 · ${runLabels[run.status]} · ${run.id.slice(-8)}`;
}
export function active(run?: LabRun) {
  return run?.status === 'QUEUED' || run?.status === 'RUNNING';
}

export const bertScoreLabels = { PENDING: '계산 대기', RUNNING: '계산 중', SUCCEEDED: '계산 완료',
  FAILED: '계산 실패', SKIPPED: '미측정', CANCELLED: '계산 취소' } as const;
export const bertScoreReasons: Record<string, string> = { EMPTY_REASON: '비교할 근거 없음', TOKEN_LIMIT: '근거가 토큰 한도 초과',
  GENERATION_FAILED: '생성 실패', GENERATION_CANCELLED: '생성 취소', RUN_CANCELLED: '실행 취소',
  MOCK_NOT_MEASURED: '모의 실행에서는 계산하지 않음', ATTEMPT_LIMIT: '재시도 한도 도달',
  BERTSCORE_UNAVAILABLE_OR_INVALID: '평가 서비스 연결 또는 응답 오류' };
