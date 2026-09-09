import { env } from '../../lib/env';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorMessage, LoadingSpinner } from '../../components/common';
import { adminChangeRequestApi, getApiErrorMessage } from '../../lib/api';
import { queryKeys } from '../../lib/query';

const labels: Record<string, string> = { DRAFT: '작성 중', PENDING: '검토 대기', APPLYING: '반영 중', COMPLETED: '완료', REJECTED: '반려', CANCELLED: '취소', CONFLICT: '충돌', FAILED: '반영 실패' };

export default function AdminChangeRequestReviewPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const completedId = useRef<string | null>(null);
  const [reviewReason, setReviewReason] = useState('');
  const requestQuery = useQuery({ queryKey: queryKeys.changeRequest(id ?? ''), queryFn: () => adminChangeRequestApi.get(id!), enabled: Boolean(id), refetchInterval: (query) => query.state.data?.state === 'APPLYING' ? 1500 : false });
  const invalidate = () => { void queryClient.invalidateQueries({ queryKey: queryKeys.changeRequest(id ?? '') }); void queryClient.invalidateQueries({ queryKey: queryKeys.changeRequests }); };
  const approve = useMutation({ mutationFn: () => adminChangeRequestApi.approve(id!), onSuccess: invalidate });
  const reject = useMutation({ mutationFn: () => adminChangeRequestApi.reject(id!, reviewReason), onSuccess: invalidate });
  const retry = useMutation({ mutationFn: () => adminChangeRequestApi.retry(id!), onSuccess: invalidate });
  useEffect(() => {
    const completed = requestQuery.data;
    if (completed?.state !== 'COMPLETED' || completedId.current === completed.id) return;
    completedId.current = completed.id;
    void queryClient.invalidateQueries({ queryKey: queryKeys.adminProjects });
    void queryClient.invalidateQueries({ queryKey: queryKeys.publicYears });
  }, [queryClient, requestQuery.data]);
  if (requestQuery.isLoading) return <LoadingSpinner />;
  if (requestQuery.error) return <ErrorMessage error={requestQuery.error} onReset={() => requestQuery.refetch()} />;
  const request = requestQuery.data;
  if (!request) return null;
  const canReview = request.state === 'PENDING';
  const error = approve.error ?? reject.error ?? retry.error;
  return <div className="admin-project-edit-page"><div className="admin-page-header"><div className="admin-page-header__text"><h1>변경 요청 검토</h1><p>{request.projectTitle ?? `작품 #${request.projectId}`} · {request.kind === 'DELETE' ? '삭제 요청' : '수정 요청'}</p></div></div>
    <section className="project-form"><fieldset><legend>요청 정보</legend><p>상태: <strong>{labels[request.state] ?? request.state}</strong></p><p>요청 사유: {request.reason}</p><p>요청일: {new Date(request.createdAt).toLocaleString('ko-KR')}</p>{request.reviewReason && <p>처리 의견: {request.reviewReason}</p>}</fieldset></section>
    {request.kind === 'DELETE' ? <section className="project-form"><fieldset><legend>삭제 범위</legend><p>승인 시 작품과 연결된 파일이 영구 삭제됩니다.</p><ul>{request.before.assets.map((asset) => <li key={asset.id}>{asset.originalName} ({asset.kind})</li>)}</ul></fieldset></section> : <section className="project-form"><fieldset><legend>변경 전후 비교</legend><table className="admin-table"><thead><tr><th>항목</th><th>변경 전</th><th>변경 후</th></tr></thead><tbody><tr><th>제목</th><td>{request.before.title ?? '-'}</td><td>{request.changes.title ?? request.before.title ?? '-'}</td></tr><tr><th>한줄 소개</th><td>{request.before.summary ?? '-'}</td><td>{request.changes.summary ?? request.before.summary ?? '-'}</td></tr><tr><th>상세 설명</th><td style={{ whiteSpace: 'pre-wrap' }}>{request.before.description ?? '-'}</td><td style={{ whiteSpace: 'pre-wrap' }}>{request.changes.description ?? request.before.description ?? '-'}</td></tr><tr><th>GitHub</th><td>{request.before.githubUrl ?? '-'}</td><td>{request.changes.githubUrl ?? request.before.githubUrl ?? '-'}</td></tr><tr><th>플랫폼</th><td>{request.before.platforms?.join(', ') || '-'}</td><td>{request.changes.platforms ? (request.changes.platforms.join(', ') || '없음') : (request.before.platforms?.join(', ') || '-')}</td></tr><tr><th>참여 학생</th><td>{request.before.members?.map((member) => `${member.name} (${member.studentId})`).join(', ') || '-'}</td><td>{request.changes.members ? (request.changes.members.map((member) => `${member.name} (${member.studentId})`).join(', ') || '없음') : (request.before.members?.map((member) => `${member.name} (${member.studentId})`).join(', ') || '-')}</td></tr><tr><th>포스터</th><td>-</td><td>{request.changes.posterAssetId === undefined ? '변경 없음' : request.changes.posterAssetId === null ? '포스터 해제' : `자산 #${request.changes.posterAssetId}`}</td></tr><tr><th>영상 순서</th><td>-</td><td>{request.changes.videoAssetIds === undefined ? '변경 없음' : (request.changes.videoAssetIds.join(', ') || '없음')}</td></tr><tr><th>WebGL</th><td>{request.before.currentWebglDeploymentId ?? '없음'}</td><td>{request.changes.removeWebgl ? '삭제' : '유지'}</td></tr></tbody></table><h3>기존 파일</h3><ul>{request.before.assets.map((asset) => <li key={asset.id}>{asset.originalName} ({asset.kind}){request.changes.removeAssetIds?.includes(asset.id) ? ' · 삭제 예정' : ''}</li>)}</ul>{request.stagedAssets.length > 0 && <><h3>임시 업로드 파일</h3><ul>{request.stagedAssets.map((asset) => <li key={asset.id}>{asset.kind === 'IMAGE' || asset.kind === 'POSTER' ? <img src={`${env.API_BASE_URL}${asset.previewUrl}`} referrerPolicy="origin" alt={asset.originalName} className="asset-thumb" /> : null}<a href={`${env.API_BASE_URL}${asset.previewUrl}`} referrerPolicy="origin" target="_blank" rel="noopener">{asset.originalName} ({asset.kind}) 미리보기</a></li>)}</ul></>}{request.items.length > 0 && <p>업로드 처리 상태: {request.items.map((item) => `${item.kind} ${item.state}`).join(', ')}</p>}</fieldset></section>}
    {canReview && <section className="project-form"><fieldset><legend>처리</legend><button type="button" className="btn btn--primary" disabled={approve.isPending || reject.isPending} onClick={() => approve.mutate()}>{approve.isPending ? '승인 중…' : '승인 및 반영'}</button><div className="form-field" style={{ marginTop: '1rem' }}><label htmlFor="review-reason">반려 사유 *</label><textarea id="review-reason" rows={3} value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} /></div><button type="button" className="btn btn--danger" disabled={!reviewReason.trim() || approve.isPending || reject.isPending} onClick={() => reject.mutate()}>{reject.isPending ? '반려 중…' : '반려'}</button></fieldset></section>}
    {request.state === 'FAILED' && <button type="button" className="btn btn--primary" disabled={retry.isPending} onClick={() => retry.mutate()}>{retry.isPending ? '재시도 중…' : '반영 재시도'}</button>}
    {error && <p className="error-box" role="alert">{getApiErrorMessage(error)}</p>}<p><Link to="/admin/change-requests" className="btn btn--secondary">요청함으로 돌아가기</Link></p>
  </div>;
}
