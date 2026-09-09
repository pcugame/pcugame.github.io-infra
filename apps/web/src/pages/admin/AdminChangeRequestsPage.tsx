import { Link } from 'react-router-dom';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EmptyState, ErrorMessage, LoadingSpinner } from '../../components/common';
import { adminChangeRequestApi } from '../../lib/api';
import { queryKeys } from '../../lib/query';

const labels: Record<string, string> = { DRAFT: '작성 중', PENDING: '검토 대기', APPLYING: '반영 중', COMPLETED: '완료', REJECTED: '반려', CANCELLED: '취소', CONFLICT: '충돌', FAILED: '반영 실패' };

export default function AdminChangeRequestsPage() {
  const [state, setState] = useState<'PENDING' | 'APPLYING' | 'FAILED' | 'CONFLICT'>('PENDING');
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const { data, isLoading, error, refetch } = useQuery({ queryKey: [...queryKeys.changeRequests, state, offset], queryFn: () => adminChangeRequestApi.list({ state, offset, limit }) });
  if (isLoading) return <LoadingSpinner />;
  if (error) return <ErrorMessage error={error} onReset={() => refetch()} />;
  const items = data?.items ?? [];
  return <div className="admin-projects-page"><div className="admin-page-header"><div className="admin-page-header__text"><span className="admin-page-header__eyebrow">Change requests</span><h1>변경 요청</h1></div></div><div className="admin-card" style={{ marginBottom: '1rem' }}><label htmlFor="change-request-state">상태 </label><select id="change-request-state" value={state} onChange={(event) => { setState(event.target.value as typeof state); setOffset(0); }}><option value="PENDING">검토 대기</option><option value="APPLYING">반영 중</option><option value="FAILED">반영 실패</option><option value="CONFLICT">충돌</option></select></div>
    {items.length === 0 ? <EmptyState message="검토할 변경 요청이 없습니다." /> : <div className="admin-card"><table className="admin-table"><thead><tr><th>작품</th><th>종류</th><th>상태</th><th>요청 사유</th><th>요청일</th><th>관리</th></tr></thead><tbody>{items.map((request) => <tr key={request.id}><td>{request.projectTitle ?? `#${request.projectId}`}</td><td>{request.kind === 'DELETE' ? '삭제' : '수정'}</td><td>{labels[request.state] ?? request.state}</td><td>{request.reason}</td><td>{new Date(request.createdAt).toLocaleString('ko-KR')}</td><td><Link className="btn btn--small btn--secondary" to={`/admin/change-requests/${request.id}`}>검토</Link></td></tr>)}</tbody></table></div>}
    {data && data.total > limit && <div className="admin-pagination"><button type="button" className="btn btn--secondary btn--small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>이전</button><span>{Math.floor(offset / limit) + 1} / {Math.ceil(data.total / limit)}</span><button type="button" className="btn btn--secondary btn--small" disabled={offset + limit >= data.total} onClick={() => setOffset(offset + limit)}>다음</button></div>}
  </div>;
}
