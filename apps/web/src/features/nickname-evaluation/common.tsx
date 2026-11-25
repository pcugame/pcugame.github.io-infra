import { LAB_PAGE_SIZE, type LabStatus } from '@pcu/contracts';
import { Button } from '../../components/ui';
import { getApiErrorMessage } from '../../lib/api';

export function LabError({ error }: { error: unknown }) {
  return error ? <p role="alert" className="field-error">{getApiErrorMessage(error)}</p> : null;
}
export function Pager({ page, total, change }: { page: number; total: number; change: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / LAB_PAGE_SIZE));
  return <div className="lab-actions lab-pager">
    <Button variant="secondary" size="small" disabled={page <= 1} onClick={() => change(page - 1)}>이전</Button>
    <span>{page} / {pages} 페이지 · 총 {total}개</span>
    <Button variant="secondary" size="small" disabled={page >= pages} onClick={() => change(page + 1)}>다음</Button>
  </div>;
}
export function Connections({ status }: { status: LabStatus }) {
  const labels = { available: '연결됨', unavailable: '연결 실패', unknown: '미확인' };
  const tools = { supported: '지원', unsupported: '미지원', unknown: '미확인' };
  return <div className="lab-connections">
    <span>모델 서버 <strong>{labels[status.modelStatus]}</strong></span>
    <span>검색 서버 <strong>{labels[status.searchStatus]}</strong></span>
    <span>도구 호출 <strong>{tools[status.toolSupport]}</strong></span>
  </div>;
}
