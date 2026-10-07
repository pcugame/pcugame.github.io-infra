import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WebglNetworkList, WebglNetworkRequest, WebglNetworkCreateBody } from '@pcu/contracts';
import { api, ApiError } from '../lib/api/client';
import { getApiErrorMessage } from '../lib/api';
import { ErrorMessage, LoadingSpinner } from '../components/common';
import { useViewerKey } from '../lib/query';

const stateLabels = { PENDING: '검토 대기', APPROVED: '승인', REJECTED: '반려', REVOKED: '철회' };
const eventLabels = { APPROVE: '승인', REJECT: '반려', REVOKE: '승인 철회' };
type StateFilter = 'ALL' | WebglNetworkRequest['state'];
const filters: StateFilter[] = ['ALL', 'PENDING', 'APPROVED', 'REJECTED', 'REVOKED'];
const dateLabel = (value: string) => new Date(value).toLocaleString('ko-KR');

function ReviewActions({ item, onReviewed }: { item: WebglNetworkRequest; onReviewed: () => void }) {
	const [reason, setReason] = useState('');
	const review = useMutation({
		mutationFn: (action: 'approve' | 'reject' | 'revoke') => api.post(`/api/admin/webgl-network-requests/${item.id}/${action}`, { reason: reason.trim() }),
		onSuccess: () => { setReason(''); onReviewed(); },
	});
	if (item.projectId === null || (item.state !== 'PENDING' && item.state !== 'APPROVED')) return null;
	return <div className="network-review">
		<h4>{item.state === 'PENDING' ? '신청 검토' : '승인 관리'}</h4>
		<p className="field-hint">{item.state === 'PENDING' ? '사용 목적과 서버 설정 계획을 확인한 뒤, 처리 사유를 남겨 주세요.' : '철회하면 이 주소를 사용하는 이후 파일 요청과 갱신이 거절됩니다.'}</p>
		<div className="form-field">
			<label htmlFor={`reason-${item.id}`}>검토 사유</label>
			<textarea id={`reason-${item.id}`} value={reason} onChange={event => setReason(event.target.value)} maxLength={2000} rows={3} placeholder="신청자에게 전달할 처리 사유를 입력하세요." required />
		</div>
		<div className="form-actions">
			{item.state === 'PENDING' ? <>
				<button type="button" className="btn btn--primary" disabled={!reason.trim() || review.isPending} onClick={() => review.mutate('approve')}>승인</button>
				<button type="button" className="btn btn--secondary" disabled={!reason.trim() || review.isPending} onClick={() => review.mutate('reject')}>반려</button>
			</> : <button type="button" className="btn btn--danger" disabled={!reason.trim() || review.isPending} onClick={() => review.mutate('revoke')}>승인 철회</button>}
			{review.isPending && <span className="field-hint" role="status">처리 중…</span>}
		</div>
		{review.error && <p className="field-error" role="alert">{getApiErrorMessage(review.error)}</p>}
	</div>;
}

function RequestCard({ item, admin, onReviewed }: { item: WebglNetworkRequest; admin: boolean; onReviewed: () => void }) {
	return <article className="admin-card network-request">
		<div className="network-request__header">
			<div><p className="network-request__project">{item.projectTitle}{item.projectId === null && ' · 삭제된 작품'}</p><h3><code>{item.origin}</code></h3></div>
			<span className={`network-status network-status--${item.state.toLowerCase()}`}>{stateLabels[item.state]}</span>
		</div>
		<p className="network-request__meta">{item.mode === 'HTTPS' ? 'HTTPS API / Addressables' : 'WSS'} · 신청자 #{item.requesterId} · 신청 {dateLabel(item.createdAt)}</p>
		<dl className="network-request__details">
			<div><dt>사용 목적</dt><dd>{item.purpose}</dd></div>
			<div><dt>CORS / 인증 설정 계획</dt><dd>{item.cors}</dd></div>
			{item.reviewReason && <div><dt>최근 검토 사유</dt><dd>{item.reviewReason}</dd></div>}
		</dl>
		{item.projectId === null ? <p className="field-hint">삭제된 작품의 기록입니다. 검토와 승인 변경을 할 수 없습니다.</p> : item.state === 'APPROVED' ? <p className="network-request__notice">이 주소로 연결할 수 있습니다. 새 승인은 다음 게임 실행부터 반영되며, 다음 배포에도 유지됩니다.</p> : item.state === 'PENDING' && !admin ? <p className="network-request__notice">관리자가 검토 중입니다. 승인 전에는 이 주소로 연결할 수 없습니다.</p> : null}
		<details className="network-history">
			<summary>처리 이력 <span>{item.events.length}건</span></summary>
			{item.events.length === 0 ? <p className="field-hint">아직 검토 기록이 없습니다.</p> : <ol>{item.events.map(event => <li key={event.id}><div><strong>{eventLabels[event.action]}</strong><span>검토자 #{event.actorId} · {dateLabel(event.createdAt)}</span></div><p>{event.reason}</p></li>)}</ol>}
		</details>
		{admin && <ReviewActions item={item} onReviewed={onReviewed} />}
	</article>;
}

export default function WebglNetworkPage({ admin = false }: { admin?: boolean }) {
	const { id } = useParams();
	const projectId = Number(id);
	const viewerKey = useViewerKey();
	const client = useQueryClient();
	const path = admin ? '/api/admin/webgl-network-requests' : `/api/me/projects/${projectId}/webgl-network-requests`;
	const queryKey = viewerKey(['webgl-network', path]);
	const query = useQuery({ queryKey, queryFn: () => api.get<WebglNetworkList>(path), enabled: admin || Number.isSafeInteger(projectId) && projectId > 0, retry: false });
	const [filter, setFilter] = useState<StateFilter>(admin ? 'PENDING' : 'ALL');
	const [origin, setOrigin] = useState('');
	const [mode, setMode] = useState<'HTTPS' | 'WSS'>('HTTPS');
	const [purpose, setPurpose] = useState('');
	const [cors, setCors] = useState('');
	const refresh = () => { void client.invalidateQueries({ queryKey }); };
	const submit = useMutation({
		mutationFn: (body: WebglNetworkCreateBody) => api.post<WebglNetworkRequest>(path, body),
		onSuccess: () => { setOrigin(''); setPurpose(''); setCors(''); setFilter('ALL'); refresh(); },
	});
	function send(event: FormEvent) {
		event.preventDefault();
		submit.mutate({ origin: origin.trim(), mode, purpose: purpose.trim(), cors: cors.trim() });
	}
	if (query.isLoading) return <LoadingSpinner />;
	if (query.error instanceof ApiError && query.error.status === 404) return <div className="webgl-network-page"><section className="admin-card network-unavailable"><h1>게임 외부 연결</h1><p>외부 연결 신청 기능이 아직 활성화되지 않았거나 접근 가능한 작품이 없습니다.</p><Link className="btn btn--secondary" to={admin ? '/admin/projects' : '/me/projects'}>{admin ? '작품 관리로 돌아가기' : '내 작품으로 돌아가기'}</Link></section></div>;
	if (query.error) return <ErrorMessage error={query.error} onReset={() => query.refetch()} />;
	if (!query.data) return <p>작품을 확인해 주세요.</p>;
	const items = query.data.items;
	const stateOrder = { PENDING: 0, APPROVED: 1, REJECTED: 2, REVOKED: 3 };
	const visibleItems = items.filter(item => filter === 'ALL' || item.state === filter).sort((a, b) => stateOrder[a.state] - stateOrder[b.state]);
	const pendingCount = items.filter(item => item.state === 'PENDING').length;
	const approvedCount = items.filter(item => item.state === 'APPROVED' && item.projectId !== null).length;
	return <div className="webgl-network-page">
		<header className="admin-page-header">
			<div className="admin-page-header__text"><span className="admin-page-header__eyebrow">Game Connections</span><h1>{admin ? '게임 외부 연결 검토' : '게임 외부 연결 신청'}</h1><p className="field-hint">{admin ? '작품별 외부 서버 연결 신청을 확인하고 처리합니다.' : '게임에서 사용할 외부 API, 에셋 서버 또는 WebSocket 주소를 신청합니다.'}</p></div>
			<div className="network-header-actions">{!admin && <a className="btn btn--primary btn--small" href="#network-new-request">새 연결 신청</a>}<Link className="btn btn--secondary btn--small" to={admin ? '/admin/projects' : '/me/projects'}>{admin ? '작품 관리' : '내 작품'}</Link></div>
		</header>
		<section className="admin-card network-guide" aria-labelledby="network-guide-title">
			<div className="network-section-heading"><h2 id="network-guide-title">외부 연결은 이렇게 진행됩니다</h2><span className="network-role">{admin ? '관리자 검토 화면' : '작품 참여자 신청 화면'}</span></div>
			<ol className="network-steps">
				<li><span className="network-step-number">1</span><div><h3>연결 주소 신청</h3><p>내 작품 → 외부 연결에서 주소와 사용 목적, 서버 설정 계획을 제출합니다.</p></div></li>
				<li><span className="network-step-number">2</span><div><h3>관리자가 검토</h3><p>관리 메뉴 → 게임 외부 연결에서 사유를 남기고 승인 또는 반려합니다.</p></div></li>
				<li><span className="network-step-number">3</span><div><h3>다음 게임 실행에 적용</h3><p>승인 후 게임을 다시 실행하면 연결이 허용됩니다. 다음 배포에도 승인이 유지됩니다.</p></div></li>
			</ol>
			<div className="network-guide__footer"><p>{admin ? <>검토 대기 <strong>{pendingCount}건</strong>을 먼저 확인해 주세요.</> : <>현재 연결 가능한 주소 <strong>{approvedCount}개</strong> · 검토 대기 <strong>{pendingCount}건</strong></>}</p><p className="field-hint">외부 서버의 CORS / 인증 설정은 신청자가 직접 준비해야 합니다.</p></div>
		</section>
		<div className={`network-workspace${admin ? ' network-workspace--admin' : ''}`}>
		<section className="network-list" aria-label="외부 연결 신청 이력">
			<div className="network-section-heading"><h2>{admin ? '신청 검토 목록' : '연결 현황'}</h2><span className="field-hint">전체 {items.length}건</span></div>
			<div className="network-filters" aria-label="신청 상태 필터">{filters.map(value => <button key={value} type="button" className={`btn btn--secondary btn--small network-filter${filter === value ? ' is-active' : ''}`} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'ALL' ? '전체' : stateLabels[value]} <span>{value === 'ALL' ? items.length : items.filter(item => item.state === value).length}</span></button>)}</div>
			{visibleItems.length === 0 ? <div className="admin-card network-empty"><h3>{items.length === 0 ? '등록된 신청이 없습니다.' : `${filter === 'ALL' ? '전체' : stateLabels[filter]} 신청이 없습니다.`}</h3><p>{items.length === 0 ? admin ? '작품 담당자가 연결 주소를 신청하면 이곳에서 검토할 수 있습니다.' : '새 연결 신청에 필요한 정보를 입력해 첫 주소를 등록하세요.' : '다른 상태를 선택하면 이전 신청과 처리 결과를 확인할 수 있습니다.'}</p></div> : visibleItems.map(item => <RequestCard key={item.id} item={item} admin={admin} onReviewed={refresh} />)}
		</section>
		{!admin && <form id="network-new-request" className="admin-card project-form network-form" onSubmit={send}>
			<h2>새 연결 신청</h2><p className="field-hint">주소마다 신청해 주세요. 관리자가 검토한 후 결과를 연결 현황에서 확인할 수 있습니다.</p>
			<div className="form-field"><label htmlFor="network-mode">연결 방식</label><select id="network-mode" value={mode} onChange={event => setMode(event.target.value as 'HTTPS' | 'WSS')}><option value="HTTPS">HTTPS API / Addressables</option><option value="WSS">WSS</option></select></div>
			<div className="form-field"><label htmlFor="network-origin">정확한 origin</label><input type="url" id="network-origin" value={origin} onChange={event => setOrigin(event.target.value)} placeholder={mode === 'WSS' ? 'wss://socket.example.com' : 'https://assets.example.com'} maxLength={500} autoComplete="off" spellCheck={false} aria-describedby="network-origin-hint" required /><p className="field-hint" id="network-origin-hint">경로·쿼리·와일드카드 없이 입력하세요. 포트가 필요하면 포함하세요.</p></div>
			<div className="form-field"><label htmlFor="network-purpose">사용 목적</label><textarea id="network-purpose" value={purpose} onChange={event => setPurpose(event.target.value)} maxLength={2000} rows={3} placeholder="예: 게임 실행 중 원격 에셋 번들 다운로드" required /></div>
			<div className="form-field"><label htmlFor="network-cors">CORS / 인증 설정 계획</label><textarea id="network-cors" value={cors} onChange={event => setCors(event.target.value)} maxLength={2000} rows={3} aria-describedby="network-cors-hint" placeholder={mode === 'HTTPS' ? '예: 외부 서버에서 아래 게임 origin을 허용' : '서버의 Origin 검사 및 인증 방식'} required /><p className="field-hint" id="network-cors-hint">{mode === 'HTTPS' ? '외부 서버에서 허용할 게임 origin' : '서버의 Origin 검사 시 확인할 게임 origin'}: <code>{query.data.gameOrigin}</code></p></div>
			<div className="form-actions"><button className="btn btn--primary" type="submit" disabled={submit.isPending}>{submit.isPending ? '신청 중…' : '검토 신청'}</button></div>
			{submit.error && <p className="field-error" role="alert">{getApiErrorMessage(submit.error)}</p>}
			{submit.isSuccess && <p className="success-message" role="status">신청이 등록되었습니다. 관리자 검토 결과를 기다려 주세요.</p>}
		</form>}
		</div>
		<details className="admin-card network-help"><summary>서버 설정과 연결 실패 확인 방법</summary><div className="network-help__content">
			<div><h3>외부 서버 설정</h3><p>게임 파일 origin: <code>{query.data.gameOrigin}</code></p><p>HTTPS 서버는 이 origin을 CORS 허용 대상으로 설정하세요. Addressables의 카탈로그·해시·번들과 WSS 인증은 해당 서비스에서 직접 설정해야 합니다.</p></div>
			<div><h3>연결이 차단된다면</h3><p>개발자 도구에 Content Security Policy 차단이 표시되면 승인 상태와 정확한 origin을 확인하세요. CORS 오류라면 외부 서버의 허용 설정을 확인하세요. 승인만으로 CORS 설정이 변경되지는 않습니다.</p></div>
			<div><h3>지원 범위와 승인 철회</h3><p>외부 스크립트 직접 로딩과 OAuth 팝업·리디렉션 로그인은 지원하지 않습니다. 철회 후에는 해당 주소를 사용하는 이후 파일 요청과 갱신이 거절됩니다. 이미 로딩된 코드나 연결된 WSS를 즉시 종료하지는 못합니다.</p></div>
			{query.data.policyVersion !== null && <p className="field-hint">현재 작품 정책 버전 {query.data.policyVersion}</p>}
		</div></details>
	</div>;
}
