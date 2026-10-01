import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WebglNetworkList, WebglNetworkRequest, WebglNetworkCreateBody } from '@pcu/contracts';
import { api, ApiError } from '../lib/api/client';
import { getApiErrorMessage } from '../lib/api';
import { ErrorMessage, LoadingSpinner } from '../components/common';
import { useViewerKey } from '../lib/query';

const stateLabels = { PENDING: '검토 대기', APPROVED: '승인', REJECTED: '반려', REVOKED: '철회' };

function ReviewActions({ item, onReviewed }: { item: WebglNetworkRequest; onReviewed: () => void }) {
	const [reason, setReason] = useState('');
	const review = useMutation({
		mutationFn: (action: 'approve' | 'reject' | 'revoke') => api.post(`/api/admin/webgl-network-requests/${item.id}/${action}`, { reason: reason.trim() }),
		onSuccess: () => { setReason(''); onReviewed(); },
	});
	if (item.state !== 'PENDING' && item.state !== 'APPROVED') return null;
	return <div className="form-group">
		<label htmlFor={`reason-${item.id}`}>검토 사유</label>
		<textarea id={`reason-${item.id}`} value={reason} onChange={event => setReason(event.target.value)} maxLength={2000} required />
		<div className="project-actions">
			{item.state === 'PENDING' ? <>
				<button type="button" className="btn btn--primary" disabled={!reason.trim() || review.isPending} onClick={() => review.mutate('approve')}>승인</button>
				<button type="button" className="btn btn--secondary" disabled={!reason.trim() || review.isPending} onClick={() => review.mutate('reject')}>반려</button>
			</> : <button type="button" className="btn btn--danger" disabled={!reason.trim() || review.isPending} onClick={() => review.mutate('revoke')}>승인 철회</button>}
		</div>
		{review.error && <p role="alert">{getApiErrorMessage(review.error)}</p>}
	</div>;
}

export default function WebglNetworkPage({ admin = false }: { admin?: boolean }) {
	const { id } = useParams();
	const projectId = Number(id);
	const viewerKey = useViewerKey();
	const client = useQueryClient();
	const path = admin ? '/api/admin/webgl-network-requests' : `/api/me/projects/${projectId}/webgl-network-requests`;
	const queryKey = viewerKey(['webgl-network', path]);
	const query = useQuery({ queryKey, queryFn: () => api.get<WebglNetworkList>(path), enabled: admin || Number.isSafeInteger(projectId) && projectId > 0, retry: false });
	const [origin, setOrigin] = useState('');
	const [mode, setMode] = useState<'HTTPS' | 'WSS'>('HTTPS');
	const [purpose, setPurpose] = useState('');
	const [cors, setCors] = useState('');
	const refresh = () => { void client.invalidateQueries({ queryKey }); };
	const submit = useMutation({
		mutationFn: (body: WebglNetworkCreateBody) => api.post<WebglNetworkRequest>(path, body),
		onSuccess: () => { setOrigin(''); setPurpose(''); setCors(''); refresh(); },
	});
	function send(event: FormEvent) {
		event.preventDefault();
		submit.mutate({ origin: origin.trim(), mode, purpose: purpose.trim(), cors: cors.trim() });
	}
	if (query.isLoading) return <LoadingSpinner />;
	if (query.error instanceof ApiError && query.error.status === 404) return <section className="admin-card"><h1>게임 외부 연결</h1><p>외부 연결 신청 기능이 아직 활성화되지 않았거나 접근 가능한 작품이 없습니다.</p><Link to="/me/projects">내 작품으로 돌아가기</Link></section>;
	if (query.error) return <ErrorMessage error={query.error} onReset={() => query.refetch()} />;
	if (!query.data) return <p>작품을 확인해 주세요.</p>;
	return <div className="admin-projects-page">
		<header className="admin-page-header"><h1>{admin ? '게임 외부 연결 검토' : '게임 외부 연결 신청'}</h1></header>
		<section className="admin-card">
			<p>HTTPS API·Addressables 또는 WSS 연결에 사용할 정확한 origin을 신청하세요. 승인된 주소는 이 작품의 다음 배포에도 적용되며, 새 승인은 다음 게임 실행부터 반영됩니다.</p>
			<p>외부 서버의 CORS 허용 대상은 게임 파일 origin <code>{query.data.gameOrigin}</code>입니다. Addressables의 카탈로그·해시·번들과 WSS 인증은 해당 서비스에 직접 설정해 주세요.</p>
			<p>외부 스크립트 직접 로딩과 OAuth 팝업·리디렉션 로그인은 지원하지 않습니다. 승인 철회 시 해당 주소를 사용하는 실행 세션의 이후 파일 요청과 갱신이 거절됩니다. 이미 로딩된 코드나 연결된 WSS를 즉시 종료하지는 못합니다.</p>
			<details><summary>연결 실패 확인 방법</summary><p>개발자 도구에 Content Security Policy 차단이 표시되면 승인 상태와 정확한 origin을 확인하세요. CORS 오류라면 외부 서버가 위 게임 origin을 허용하는지 확인하세요. 승인만으로 외부 서버의 CORS 설정이 변경되지는 않습니다.</p></details>
		</section>
		{!admin && <form className="admin-card" onSubmit={send}>
			<div className="form-group"><label htmlFor="network-mode">연결 방식</label><select id="network-mode" value={mode} onChange={event => setMode(event.target.value as 'HTTPS' | 'WSS')}><option value="HTTPS">HTTPS API / Addressables</option><option value="WSS">WSS</option></select></div>
			<div className="form-group"><label htmlFor="network-origin">정확한 origin</label><input id="network-origin" value={origin} onChange={event => setOrigin(event.target.value)} placeholder={mode === 'WSS' ? 'wss://socket.example.com' : 'https://assets.example.com'} maxLength={500} required /><p>경로·쿼리·와일드카드 없이 입력하세요. 포트가 필요하면 포함하세요.</p></div>
			<div className="form-group"><label htmlFor="network-purpose">사용 목적</label><textarea id="network-purpose" value={purpose} onChange={event => setPurpose(event.target.value)} maxLength={2000} required /></div>
			<div className="form-group"><label htmlFor="network-cors">CORS / 인증 설정 계획</label><textarea id="network-cors" value={cors} onChange={event => setCors(event.target.value)} maxLength={2000} required /><p>HTTPS는 게임 origin 허용 설정을, WSS는 서버의 Origin 검사와 인증 방식을 설명해 주세요.</p></div>
			<button className="btn btn--primary" type="submit" disabled={submit.isPending}>{submit.isPending ? '신청 중…' : '검토 신청'}</button>
			{submit.error && <p role="alert">{getApiErrorMessage(submit.error)}</p>}
			{submit.isSuccess && <p role="status">신청이 등록되었습니다.</p>}
		</form>}
		<section aria-label="외부 연결 신청 이력">
			<h2>신청 이력{query.data.policyVersion !== null && ` · 정책 버전 ${query.data.policyVersion}`}</h2>
			{query.data.items.length === 0 && <p>등록된 신청이 없습니다.</p>}
			{query.data.items.map(item => <article className="admin-card" key={item.id}>
				<h3>{item.projectTitle} · {item.origin}</h3>
				<p>{stateLabels[item.state]} · {item.mode} · 신청자 #{item.requesterId} · {new Date(item.createdAt).toLocaleString('ko-KR')}</p>
				<p>{item.purpose}</p><p>CORS / 인증: {item.cors}</p>
				{item.events.length > 0 && <ul>{item.events.map(event => <li key={event.id}>{event.action} · 검토자 #{event.actorId} · {event.reason} · {new Date(event.createdAt).toLocaleString('ko-KR')}</li>)}</ul>}
				{admin && <ReviewActions item={item} onReviewed={refresh} />}
			</article>)}
		</section>
	</div>;
}
