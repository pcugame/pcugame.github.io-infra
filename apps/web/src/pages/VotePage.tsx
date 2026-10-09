import { ConfirmVoteDialog } from '../features/voting/ConfirmVoteDialog';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import type { VotePublic, VoteRecords } from '@pcu/contracts';
import { votingApi } from '../features/voting/api';
import { stableCandidateOrder } from '../features/voting/participant';
import { getApiErrorMessage } from '../lib/api';

export default function VotePage() {
	const { pathname } = useLocation();
	return <VoteScreen key={pathname} />;
}
function VoteScreen() {
	const { publicId = '' } = useParams(),
		location = useLocation();
	const recordsMode = location.pathname.endsWith('/records'),
		drawMode = location.pathname.endsWith('/draw');
	const [view, setView] = useState<VotePublic | null>(null),
		[records, setRecords] = useState<VoteRecords | null>(null);
	const [selected, setSelected] = useState<string[]>([]),
		[order, setOrder] = useState<string[]>([]);
	const [page, setPage] = useState(1),
		[error, setError] = useState(''),
		[busy, setBusy] = useState(false);
	const [confirm, setConfirm] = useState<'vote' | 'receive' | null>(null);
	const inFlight = useRef(false),
		refreshVersion = useRef(0);
	const refresh = useCallback(async () => {
		const version = ++refreshVersion.current;
		if (recordsMode) {
			try {
				const next = await votingApi.records(publicId, page);
				if (version === refreshVersion.current) setRecords(next);
			} catch (e) {
				if (version === refreshVersion.current) {
					setRecords(null);
					throw e;
				}
			}
			return;
		}
		const next = await votingApi.view(publicId);
		if (version !== refreshVersion.current) return;
		setView(next);
		setOrder((old) =>
			stableCandidateOrder(
				next.candidates.map((c) => c.id),
				old,
			),
		);
		setSelected((old) =>
			old.filter((id) => next.candidates.some((c) => c.id === id)).slice(0, next.maxSelections),
		);
	}, [publicId, page, recordsMode]);
	useEffect(() => {
		let live = true;
		void refresh().catch((e) => {
			if (live) setError(getApiErrorMessage(e));
		});
		return () => {
			live = false;
		};
	}, [refresh]);
	// Server remains authoritative after another tab submits or when a QR page is revisited.
	useEffect(() => {
		const focus = () => {
			void refresh().catch((e) => setError(getApiErrorMessage(e)));
		};
		window.addEventListener('focus', focus);
		return () => window.removeEventListener('focus', focus);
	}, [refresh]);
	async function act(action: 'vote' | 'draw' | 'receive') {
		if (inFlight.current || !view) return;
		inFlight.current = true;
		setBusy(true);
		setError('');
		try {
			if (action === 'vote') await votingApi.submit(publicId, view.version, selected);
			else await votingApi[action](publicId);
			setConfirm(null);
			await refresh();
		} catch (e) {
			setConfirm(null);
			setError(getApiErrorMessage(e));
			await refresh().catch(() => undefined);
		} finally {
			inFlight.current = false;
			setBusy(false);
		}
	}
	const feedback = error && (
		<p role="alert" className="error-box error-box__message">
			{error}{' '}
			<button
				className="btn btn--secondary"
				onClick={() => {
					setError('');
					void refresh().catch((e) => setError(getApiErrorMessage(e)));
				}}
			>
				다시 확인
			</button>
		</p>
	);
	if (recordsMode)
		return (
			<main className="vote-page">
				<h1>투표 공개 기록</h1>
				{feedback}
				{records && (
					<>
						<p>총 {records.total}표</p>
						<ul>
							{records.totals.map((t) => (
								<li key={t.id}>
									{t.title}: {t.count}표
								</li>
							))}
						</ul>
						<ol>
							{records.ballots.map((b) => (
								<li key={b.id}>
									<code>{b.id}</code> · <time>{new Date(b.createdAt).toLocaleString()}</time>
									<p>{b.selections.map((s) => s.title).join(', ')}</p>
								</li>
							))}
						</ol>
						<h2>후보 변경 이력</h2>
						<ul>
							{records.changes.map((c) => (
								<li key={c.id}>
									{new Date(c.createdAt).toLocaleString()} · 버전 {c.version} ·{' '}
									{c.candidate && `${c.candidate.title} (${c.candidate.active ? '활성' : '제외'}) · `}
									{c.reason}
								</li>
							))}
						</ul>
						<button
							className="btn btn--secondary"
							disabled={page <= 1}
							onClick={() => {
								setRecords(null);
								setPage((p) => p - 1);
							}}
						>
							이전
						</button>{' '}
						{page}{' '}
						<button
							className="btn btn--secondary"
							disabled={page * 50 >= Math.max(records.total, records.changesTotal)}
							onClick={() => {
								setRecords(null);
								setPage((p) => p + 1);
							}}
						>
							다음
						</button>
					</>
				)}
			</main>
		);
	if (!view) return <main className="vote-page">{feedback || <p role="status">불러오는 중…</p>}</main>;
	const d = view.draw;
	if (drawMode)
		return (
			<main className="vote-page">
				<h1>{view.title} · 추첨</h1>
				{feedback}
				{d ? (
					<>
						<h2>{d.title}</h2>
						{d.receipt ? (
							<section role="status" className="vote-receipt">
								<h2>수령 완료</h2>
								<p>{d.title}</p>
								<time>{new Date(d.receipt.createdAt).toLocaleString()}</time>
								<p>
									식별번호 <code>{d.receipt.id}</code>
								</p>
								<p>이 화면을 직원에게 보여 주세요.</p>
							</section>
						) : d.prize ? (
							<>
								<p>직원 앞에서 수령을 확인해 주세요.</p>
								<button className="btn btn--primary" disabled={busy} onClick={() => setConfirm('receive')}>
									경품 수령
								</button>
							</>
						) : (
							<p>참여해주셔서 감사합니다!</p>
						)}
					</>
				) : view.drawEligible ? (
					<button className="btn btn--primary" disabled={busy} onClick={() => void act('draw')}>
						{busy ? '확인 중…' : '추첨하기'}
					</button>
				) : (
					<p>현재 추첨에 참여할 수 없습니다.</p>
				)}
				{confirm === 'receive' && (
					<ConfirmVoteDialog titleId="receive-title" busy={busy} onClose={() => setConfirm(null)}>
						<h2 id="receive-title">직원 앞에서 수령하시겠습니까?</h2>
						<p>확인하면 수령 완료로 저장됩니다.</p>
						<button className="btn btn--primary" autoFocus disabled={busy} onClick={() => void act('receive')}>
							수령 완료
						</button>
						<button className="btn btn--secondary" disabled={busy} onClick={() => setConfirm(null)}>
							취소
						</button>
					</ConfirmVoteDialog>
				)}
				<p>
					<Link className="btn btn--secondary" to={`/votes/${publicId}`}>투표 참여 확인</Link>
				</p>
			</main>
		);
	if (view.ballot)
		return (
			<main className="vote-page">
				<h1>참여해주셔서 감사합니다!</h1>
				{feedback}
				<ul className="vote-completed">
					{view.ballot.selections.map((c) => (
						<li key={c.id}>
							<img src={c.posterUrl} alt="" />
							<p>{c.title}</p>
						</li>
					))}
				</ul>
				{(view.drawEligible || d) && (
					<Link className="btn btn--primary" to={`/votes/${publicId}/draw`}>{d ? '추첨 결과 확인' : '추첨 참여'}</Link>
				)}
			</main>
		);
	const candidates = order.flatMap((id) => view.candidates.find((c) => c.id === id) ?? []);
	return (
		<main className="vote-page">
			<header>
				<h1>{view.title}</h1>
				<p>{view.guidance}</p>
			</header>
			{view.privacyNotice && (
				<details>
					<summary>개인정보 처리 안내</summary>
					<p>{view.privacyNotice}</p>
				</details>
			)}
			{feedback}
			{view.state !== 'OPEN' && (
				<p role="status">
					{view.state === 'PAUSED'
						? '투표가 일시 정지되었습니다.'
						: view.state === 'CLOSED'
							? '투표가 마감되었습니다.'
							: '투표 준비 중입니다.'}
				</p>
			)}
			<div className="vote-grid">
				{candidates.map((c) => (
					<button
						key={c.id}
						type="button"
						className="vote-poster"
						aria-label={c.title}
						aria-pressed={selected.includes(c.id)}
						disabled={
							busy ||
							view.state !== 'OPEN' ||
							(!selected.includes(c.id) && selected.length >= view.maxSelections)
						}
						onClick={() =>
							setSelected((ids) => (ids.includes(c.id) ? ids.filter((id) => id !== c.id) : [...ids, c.id]))
						}
					>
						<img src={c.posterUrl} alt="" />
						{selected.includes(c.id) && (
							<span aria-hidden="true" className="vote-check">
								✓
							</span>
						)}
					</button>
				))}
			</div>
			<p role="status" className="sr-only">
				{selected.length}개 선택, 최대 {view.maxSelections}개
			</p>
			{selected.length > 0 && view.state === 'OPEN' && (
				<footer className="vote-submit">
					<span>
						{selected.length} / {view.maxSelections}
					</span>
					<button className="btn btn--primary" disabled={busy} onClick={() => setConfirm('vote')}>
						투표 완료
					</button>
				</footer>
			)}
			{confirm === 'vote' && (
				<ConfirmVoteDialog titleId="vote-confirm-title" busy={busy} onClose={() => setConfirm(null)}>
					<h2 id="vote-confirm-title">이 작품에 투표하시겠습니까?</h2>
					<ul>
						{selected.map((id) => (
							<li key={id}>{view.candidates.find((c) => c.id === id)?.title}</li>
						))}
					</ul>
					<p>제출 후 선택을 변경할 수 없습니다.</p>
					<button className="btn btn--primary" autoFocus disabled={busy} onClick={() => void act('vote')}>
						{busy ? '접수 확인 중…' : '최종 제출'}
					</button>
					<button className="btn btn--secondary" disabled={busy} onClick={() => setConfirm(null)}>
						돌아가기
					</button>
				</ConfirmVoteDialog>
			)}
		</main>
	);
}
