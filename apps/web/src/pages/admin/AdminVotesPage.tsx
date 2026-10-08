import { SelectControl } from '../../components/ui/SelectControl';
import { VotePosterUpload } from '../../features/voting/VotePosterUpload';
import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { DrawAdmin, DrawSettings, VoteAdmin, VoteSettings } from '@pcu/contracts';
import { votingApi } from '../../features/voting/api';
import { getApiErrorMessage } from '../../lib/api';
import { api } from '../../lib/api/client';
import '../../styles/features/voting.css';
const initial: VoteSettings = {
	exhibitionId: 1,
	title: '',
	guidance: '최대 {최대선택수}개 작품을 선택해 주세요.',
	maxSelections: 2,
	state: 'PREPARING',
	startsAt: null,
	endsAt: null,
	eventId: null,
};
const initialDraw: DrawSettings = {
	title: '',
	mode: 'FINITE',
	paused: true,
	items: [{ title: '경품', prize: true, remaining: 10, weight: 1, active: true }],
};
const states = { PREPARING: '준비', OPEN: '진행', PAUSED: '일시 정지', CLOSED: '마감' };
function localTime(value: string | null) {
	if (!value) return '';
	const d = new Date(value);
	return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export default function AdminVotesPage() {
	const [votes, setVotes] = useState<VoteAdmin[]>([]),
		[events, setEvents] = useState<DrawAdmin[]>([]);
	const [vote, setVote] = useState<VoteAdmin | null>(null),
		[settings, setSettings] = useState<VoteSettings>(initial);
	const [event, setEvent] = useState<DrawAdmin | null>(null),
		[drawSettings, setDrawSettings] = useState<DrawSettings>(initialDraw);
	const [reason, setReason] = useState('운영 설정'),
		[error, setError] = useState(''),
		[busy, setBusy] = useState(false),
		[message, setMessage] = useState('');
	const [sources, setSources] = useState<Awaited<ReturnType<typeof votingApi.sources>>>([]);
	const [exhibitions, setExhibitions] = useState<Array<{ id: number; year: number; title: string }>>([]);
	const [records, setRecords] = useState<Awaited<ReturnType<typeof votingApi.adminRecords>> | null>(null),
		[page, setPage] = useState(1);
	const [title, setTitle] = useState(''),
		[qr, setQr] = useState('');
	const [posterId, setPosterId] = useState('');
	const [posters, setPosters] = useState<Awaited<ReturnType<typeof votingApi.posters>>>([]);
	const onPosterReady = useCallback(
		(id: string) => {
			setPosterId(id);
			if (vote)
				void votingApi
					.posters(vote.id)
					.then(setPosters)
					.catch((e) => setError(getApiErrorMessage(e)));
		},
		[vote],
	);
	const reload = useCallback(async () => {
		const [v, e] = await Promise.all([votingApi.list(), votingApi.events()]);
		setVotes(v);
		setEvents(e);
	}, []);
	useEffect(() => {
		void reload().catch((e) => setError(getApiErrorMessage(e)));
		void api
			.get<{ items: Array<{ id: number; year: number; title: string }> }>('/api/admin/exhibitions')
			.then((r) => {
				setExhibitions(r.items);
				setSettings((s) =>
					r.items.some((e) => e.id === s.exhibitionId) ? s : { ...s, exhibitionId: r.items[0]?.id ?? 1 },
				);
			})
			.catch((e) => setError(getApiErrorMessage(e)));
	}, [reload]);
	const voteId = vote?.id;
	useEffect(() => {
		setQr('');
		if (voteId)
			void QRCode.toDataURL(`${location.origin}/votes/${voteId}`, {
				width: 800,
				margin: 4,
				errorCorrectionLevel: 'M',
			}).then(setQr);
	}, [voteId]);
	async function run(work: () => Promise<unknown>) {
		setBusy(true);
		setError('');
		setMessage('');
		try {
			await work();
			await reload();
			setMessage('요청을 처리했습니다.');
		} catch (e) {
			setError(getApiErrorMessage(e));
		} finally {
			setBusy(false);
		}
	}
	function choose(v: VoteAdmin | null) {
		setPosterId('');
		setTitle('');
		setVote(v);
		setSettings(v?.settings ?? { ...initial, exhibitionId: exhibitions[0]?.id ?? 1 });
		setSources([]);
		setPosters([]);
		if (v)
			void votingApi
				.posters(v.id)
				.then(setPosters)
				.catch((e) => setError(getApiErrorMessage(e)));
		setRecords(null);
		setPage(1);
	}
	const accept = (v: VoteAdmin) => {
		setVote(v);
		setSettings(v.settings);
	};
	return (
		<div className="vote-admin">
			<h1>전시회 투표·추첨</h1>
			{error && <p role="alert">{error}</p>}
			{message && <p role="status">{message}</p>}
			<label>
				변경 사유 (후보 변경 시 공개)
				<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
			</label>
			<section>
				<h2>투표 관리</h2>
				<label>
					투표 선택
					<SelectControl
						aria-label="투표 선택"
						value={vote?.id ?? ''}
						onChange={(e) => choose(votes.find((v) => v.id === e.target.value) ?? null)}
					>
						<option value="">새 투표</option>
						{votes.map((v) => (
							<option key={v.id} value={v.id}>
								{v.settings.title} · {states[v.settings.state]} · {v.ballotCount}표
							</option>
						))}
					</SelectControl>
				</label>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void run(async () =>
							accept(
								vote ? await votingApi.update(vote, settings, reason) : await votingApi.create(settings),
							),
						);
					}}
				>
					<label>
						전시회
						<SelectControl
							aria-label="전시회"
							required
							value={settings.exhibitionId}
							disabled={!!vote}
							onChange={(e) => setSettings((s) => ({ ...s, exhibitionId: Number(e.target.value) }))}
						>
							{exhibitions.map((e) => (
								<option key={e.id} value={e.id}>
									{e.year} {e.title}
								</option>
							))}
						</SelectControl>
					</label>
					<label>
						제목
						<input
							required
							value={settings.title}
							maxLength={200}
							onChange={(e) => setSettings((s) => ({ ...s, title: e.target.value }))}
						/>
					</label>
					<label>
						상단 안내
						<textarea
							value={settings.guidance}
							onChange={(e) => setSettings((s) => ({ ...s, guidance: e.target.value }))}
						/>
					</label>
					<label>
						최대 선택 수
						<input
							type="number"
							min={1}
							max={100}
							value={settings.maxSelections}
							onChange={(e) => setSettings((s) => ({ ...s, maxSelections: Number(e.target.value) }))}
						/>
					</label>
					<label>
						운영 상태
						<SelectControl
							aria-label="운영 상태"
							value={settings.state}
							onChange={(e) => setSettings((s) => ({ ...s, state: e.target.value as VoteSettings['state'] }))}
						>
							{Object.entries(states).map(([k, v]) => (
								<option key={k} value={k}>
									{v}
								</option>
							))}
						</SelectControl>
					</label>
					<p>
						마감하면 접수 기록과 집계를 공개합니다. 재개하면 다시 숨기지만 이미 열람하거나 저장한 정보는
						회수할 수 없습니다.
					</p>
					{(['startsAt', 'endsAt'] as const).map((k) => (
						<label key={k}>
							{k === 'startsAt' ? '예약 시작' : '예약 마감'}
							<input
								type="datetime-local"
								value={localTime(settings[k])}
								onChange={(e) =>
									setSettings((s) => ({
										...s,
										[k]: e.target.value ? new Date(e.target.value).toISOString() : null,
									}))
								}
							/>
						</label>
					))}
					<label>
						추첨 행사
						<SelectControl
							aria-label="추첨 행사"
							disabled={!!vote?.ballotCount}
							value={settings.eventId ?? ''}
							onChange={(e) => setSettings((s) => ({ ...s, eventId: e.target.value || null }))}
						>
							<option value="">연결 안 함</option>
							{events.map((e) => (
								<option key={e.id} value={e.id}>
									{e.title}
								</option>
							))}
						</SelectControl>
					</label>
					<button disabled={busy || !reason.trim()} type="submit">
						{vote ? '투표 설정 저장' : '투표 개설'}
					</button>
				</form>
				{vote && (
					<>
						<p>
							고정 주소:{' '}
							<a href={`/votes/${vote.id}`} target="_blank" rel="noreferrer">
								{location.origin}/votes/{vote.id}
							</a>
						</p>
						{qr && (
							<>
								<img className="vote-qr" src={qr} alt="투표 QR 코드" />
								<p>
									<a href={qr} download={`vote-${vote.id}.png`}>
										QR 다운로드
									</a>
								</p>
							</>
						)}
						<a href={`/votes/${vote.id}/records`}>공개 기록 확인</a>
					</>
				)}
			</section>
			{vote && (
				<section>
					<h2>후보 · 버전 {vote.version}</h2>
					<p>후보 카드에는 포스터만 표시됩니다. 제목은 접근성 설명과 제출 확인에 사용됩니다.</p>
					<button
						disabled={busy}
						onClick={() => void run(async () => setSources(await votingApi.sources(vote.id)))}
					>
						전시회 공개 작품 불러오기
					</button>
					{sources.map((s) => (
						<div className="vote-source" key={s.projectId}>
							<img src={s.posterUrl} alt="" />
							{s.title}
							<button
								disabled={busy}
								onClick={() =>
									void run(async () =>
										accept(
											await votingApi.candidate(vote, null, {
												title: s.title,
												representationId: s.representationId,
												sourceProjectId: s.projectId,
												active: true,
												reason,
											}),
										),
									)
								}
							>
								후보 추가
							</button>
						</div>
					))}
					<h3>독립 후보 또는 교체 이미지</h3>
					<VotePosterUpload
						key={vote.id}
						voteId={vote.id}
						exhibitionId={vote.settings.exhibitionId}
						onReady={onPosterReady}
					/>
					{posterId && <p>업로드한 포스터를 후보 추가·교체에 사용할 수 있습니다.</p>}
					<label>
						후보 제목
						<input value={title} onChange={(e) => setTitle(e.target.value)} />
					</label>
					<label>
						준비된 포스터
						<SelectControl
							aria-label="준비된 포스터"
							value={posterId}
							onChange={(e) => setPosterId(e.target.value)}
						>
							<option value="">포스터 선택</option>
							{posters.map((p) => (
								<option key={p.id} value={p.id}>
									{new Date(p.createdAt).toLocaleString()}
								</option>
							))}
						</SelectControl>
					</label>
					{posters.find((p) => p.id === posterId) && (
						<img
							className="vote-qr"
							src={posters.find((p) => p.id === posterId)!.posterUrl}
							alt="선택한 투표 포스터"
						/>
					)}
					<button
						disabled={busy || !title || !posterId}
						onClick={() =>
							void run(async () =>
								accept(
									await votingApi.candidate(vote, null, {
										title,
										posterId,
										sourceProjectId: null,
										active: true,
										reason,
									}),
								),
							)
						}
					>
						독립 후보 추가
					</button>
					{vote.candidates.map((c) => (
						<div className="vote-source" key={c.id}>
							<img src={c.posterUrl} alt="" />
							<span>
								{c.title} · {c.active ? '활성' : '제외'}
							</span>
							<button
								disabled={busy}
								onClick={() =>
									void run(async () =>
										accept(
											await votingApi.candidate(vote, c.id, {
												title: c.title,
												sourceProjectId: null,
												active: !c.active,
												reason,
											}),
										),
									)
								}
							>
								{c.active ? '제외' : '다시 활성화'}
							</button>
							<button
								disabled={busy || !posterId}
								onClick={() =>
									void run(async () =>
										accept(
											await votingApi.candidate(vote, c.id, {
												title: title || c.title,
												posterId,
												sourceProjectId: null,
												active: c.active,
												reason,
											}),
										),
									)
								}
							>
								입력한 포스터로 교체
							</button>
						</div>
					))}
				</section>
			)}
			{vote && (
				<section>
					<h2>접수 조사</h2>
					<p>의심 표시는 득표에 영향을 주지 않습니다. 환경 정보만으로 동일인을 확정할 수 없습니다.</p>
					<button
						disabled={busy}
						onClick={() => void run(async () => setRecords(await votingApi.adminRecords(vote.id, page)))}
					>
						접수 기록 조회
					</button>
					{records?.ballots.map((b) => (
						<fieldset key={b.id}>
							<legend>{b.id}</legend>
							<p>
								{new Date(b.createdAt).toLocaleString()} · {b.selections.map((s) => s.title).join(', ')}
							</p>
							{b.investigation && (
								<p>
									{b.investigation.browser} / {b.investigation.os} /{' '}
									{b.investigation.mobile ? '모바일' : '데스크톱'} · IP 해시 {b.investigation.ipHash}
								</p>
							)}
							<form
								onSubmit={(e) => {
									e.preventDefault();
									const data = new FormData(e.currentTarget);
									void run(async () => {
										await votingApi.flag(
											vote.id,
											b.id,
											data.get('flagged') === 'on',
											String(data.get('note') ?? ''),
										);
										setRecords(await votingApi.adminRecords(vote.id, page));
									});
								}}
							>
								<label>
									<input name="flagged" type="checkbox" defaultChecked={b.flagged} />
									의심 표시
								</label>
								<label>
									메모
									<textarea name="note" defaultValue={b.note} />
								</label>
								<button disabled={busy}>메모 저장</button>
							</form>
						</fieldset>
					))}
					<button
						disabled={busy || page === 1}
						onClick={() =>
							void run(async () => {
								setRecords(await votingApi.adminRecords(vote.id, page - 1));
								setPage((p) => p - 1);
							})
						}
					>
						이전
					</button>
					{page}
					<button
						disabled={busy || !records || page * 50 >= records.total}
						onClick={() =>
							void run(async () => {
								setRecords(await votingApi.adminRecords(vote.id, page + 1));
								setPage((p) => p + 1);
							})
						}
					>
						다음
					</button>
				</section>
			)}
			<section>
				<h2>추첨 행사</h2>
				<p>
					연결된 모든 투표가 재고와 브라우저당 1회 제한을 공유합니다. 당첨 시 재고를 확보하며 미수령분은 자동
					반환하지 않습니다.
				</p>
				<label>
					행사 선택
					<SelectControl
						aria-label="행사 선택"
						value={event?.id ?? ''}
						onChange={(e) => {
							const value = events.find((v) => v.id === e.target.value) ?? null;
							setEvent(value);
							setDrawSettings(
								value
									? { title: value.title, mode: value.mode, paused: value.paused, items: value.items }
									: initialDraw,
							);
						}}
					>
						<option value="">새 행사</option>
						{events.map((e) => (
							<option key={e.id} value={e.id}>
								{e.title}
							</option>
						))}
					</SelectControl>
				</label>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void run(async () => {
							const next = await votingApi.saveEvent(
								event?.id ?? null,
								event?.version ?? 0,
								drawSettings,
								reason,
							);
							setEvent(next);
							setDrawSettings({ title: next.title, mode: next.mode, paused: next.paused, items: next.items });
						});
					}}
				>
					<label>
						행사명
						<input
							required
							value={drawSettings.title}
							onChange={(e) => setDrawSettings((s) => ({ ...s, title: e.target.value }))}
						/>
					</label>
					<label>
						방식
						<SelectControl
							aria-label="방식"
							value={drawSettings.mode}
							onChange={(e) =>
								setDrawSettings((s) => ({ ...s, mode: e.target.value as DrawSettings['mode'] }))
							}
						>
							<option value="FINITE">유한 추첨함 · 남은 수량 비례</option>
							<option value="WEIGHTED">가중치 추첨함</option>
						</SelectControl>
					</label>
					<label>
						<input
							type="checkbox"
							checked={drawSettings.paused}
							onChange={(e) => setDrawSettings((s) => ({ ...s, paused: e.target.checked }))}
						/>
						행사 일시 정지
					</label>
					{drawSettings.items.map((item, index) => {
						const patch = (data: Partial<typeof item>) =>
							setDrawSettings((s) => ({
								...s,
								items: s.items.map((v, i) => (i === index ? { ...v, ...data } : v)),
							}));
						return (
							<fieldset key={item.id ?? index}>
								<legend>결과 {index + 1}</legend>
								<label>
									표시명
									<input required value={item.title} onChange={(e) => patch({ title: e.target.value })} />
								</label>
								<label>
									<input
										type="checkbox"
										checked={item.prize}
										onChange={(e) => patch({ prize: e.target.checked })}
									/>
									경품 (해제하면 꽝)
								</label>
								<label>
									<input
										type="checkbox"
										checked={item.active}
										onChange={(e) => patch({ active: e.target.checked })}
									/>
									활성
								</label>
								<label>
									<input
										type="checkbox"
										checked={item.remaining === null}
										disabled={drawSettings.mode === 'FINITE'}
										onChange={(e) => patch({ remaining: e.target.checked ? null : 0 })}
									/>
									무제한 재고
								</label>
								{item.remaining !== null && (
									<label>
										현재 남은 수량
										<input
											type="number"
											min={0}
											max={1000000000}
											value={item.remaining}
											onChange={(e) => patch({ remaining: Number(e.target.value) })}
										/>
									</label>
								)}
								{drawSettings.mode === 'WEIGHTED' && (
									<label>
										가중치
										<input
											type="number"
											min={1}
											max={1000000}
											value={item.weight}
											onChange={(e) => patch({ weight: Number(e.target.value) })}
										/>
									</label>
								)}
							</fieldset>
						);
					})}
					<button
						type="button"
						onClick={() =>
							setDrawSettings((s) => ({
								...s,
								items: [...s.items, { title: '', prize: false, remaining: 0, weight: 1, active: true }],
							}))
						}
					>
						결과 항목 추가
					</button>
					<button disabled={busy || !reason.trim()}>행사 설정 저장</button>
				</form>
			</section>
		</div>
	);
}
