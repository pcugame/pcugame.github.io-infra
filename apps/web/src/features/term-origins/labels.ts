import type { LabResult, LabRun } from '@pcu/contracts';

export const runLabels: Record<LabRun['status'], string> = {
  QUEUED: '대기', RUNNING: '진행 중', COMPLETED: '완료', CANCELLED: '취소',
};
export const resultLabels: Record<LabResult['status'], string> = {
  PENDING: '대기', RUNNING: '처리 중', SUCCEEDED: '성공', FAILED: '실패', CANCELLED: '취소',
};
export function runLabel(run: LabRun) {
  return `${new Date(run.createdAt).toLocaleString('ko-KR')} · ${run.nickname ?? `${run.size}개`} · ${runLabels[run.status]} · ${run.id.slice(-8)}`;
}
export function active(run?: LabRun) {
  return run?.status === 'QUEUED' || run?.status === 'RUNNING';
}

export function controversyLabel(result?: LabResult | null) {
  if (!result?.output) return '—';
  const { abstained, controversyScore } = result.output;
  return abstained || controversyScore === null ? '판단 보류' : `${controversyScore}점`;
}
