import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ErrorMessage, LoadingSpinner } from '../components/common';
import { changeRequestApi } from '../lib/api';
import { queryKeys } from '../lib/query';

const labels: Record<string, string> = { DRAFT: '작성 중', PENDING: '검토 대기', APPLYING: '반영 중', COMPLETED: '완료', REJECTED: '반려', CANCELLED: '취소', CONFLICT: '충돌', FAILED: '반영 실패' };

export default function MyChangeRequestPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: queryKeys.changeRequest(id ?? ''), queryFn: () => changeRequestApi.get(id!), enabled: Boolean(id), refetchInterval: (query) => query.state.data?.state === 'APPLYING' ? 2000 : false });
  if (isLoading) return <LoadingSpinner />;
  if (error) return <ErrorMessage error={error} onReset={() => refetch()} />;
  if (!data) return null;
  return <div className="admin-project-edit-page"><div className="admin-page-header"><div className="admin-page-header__text"><h1>변경 요청</h1><p>{data.projectTitle} · {labels[data.state] ?? data.state}</p></div></div><section className="project-form"><fieldset><legend>요청 내용</legend><p>종류: {data.kind === 'DELETE' ? '삭제' : '수정'}</p><p>사유: {data.reason}</p>{data.reviewReason && <p>운영자 의견: {data.reviewReason}</p>}{data.error && <p className="field-error">{data.error}</p>}<p>제목: {data.changes.title ?? '변경 없음'}</p><p style={{ whiteSpace: 'pre-wrap' }}>상세 설명: {data.changes.description ?? '변경 없음'}</p></fieldset></section><Link to="/me/projects" className="btn btn--secondary">내 작품으로 돌아가기</Link></div>;
}
