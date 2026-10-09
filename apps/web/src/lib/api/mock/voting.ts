import {
	DrawUpdateSchema,
	VoteCandidateInputSchema,
	VoteFlagSchema,
	VoteSettingsSchema,
	VoteSubmitSchema,
	VoteUpdateSchema,
	type DrawAdmin,
	type VoteAdmin,
	type VotePublic,
} from '@pcu/contracts';
import { MockHttpError, UNHANDLED, type MockContext, type MockRequestOptions } from './context';
import { bodyObject, parseInput } from './common';
type Ballot = NonNullable<VotePublic['ballot']> & { hash: string; flagged: boolean; note: string };
type Draw = NonNullable<VotePublic['draw']>;
type State = {
	votes: VoteAdmin[];
	events: DrawAdmin[];
	ballots: Record<string, Ballot[]>;
	draws: Record<string, Record<string, Draw>>;
	closed: Record<string, string>;
	changes: Record<
		string,
		Array<{ id: string; version: number; kind: string; reason: string; createdAt: string }>
	>;
};
export const MOCK_VOTE_ID = '00000000-0000-4000-8000-000000000001';
function state(ctx: MockContext): State {
	return (ctx.state.voting ??= {
		votes: [
			{
				id: MOCK_VOTE_ID,
				version: 1,
				ballotCount: 0,
				settings: {
					exhibitionId: ctx.state.exhibitions[0]?.id ?? 1,
					title: '전시회 인기 작품 투표',
					guidance: '최대 {최대선택수}개 작품을 선택해 주세요.',
					maxSelections: 2,
					state: 'OPEN',
					startsAt: null,
					endsAt: null,
					eventId: null,
				},
				candidates: Array.from({ length: 6 }, (_, i) => ({
					id: `00000000-0000-4000-8000-${String(i + 10).padStart(12, '0')}`,
					title: `작품 ${i + 1}`,
					posterUrl: `/mock/images/${i % 2 ? '540x960' : '400x560'}.png`,
					active: true,
					version: 1,
				})),
			},
		],
		events: [],
		ballots: {},
		draws: {},
		closed: {},
		changes: {},
	});
}
export type MockVotingState = State;
function fail(status: number, message: string): never {
	throw new MockHttpError(
		status,
		status === 409 ? 'CONFLICT' : status === 403 ? 'FORBIDDEN' : 'VALIDATION_ERROR',
		message,
	);
}
function effective(v: VoteAdmin, s: State) {
	const now = Date.now(),
		x = v.settings;
	if (x.state === 'CLOSED') return { state: 'CLOSED' as const, closed: s.closed[v.id] };
	if (x.endsAt && now >= Date.parse(x.endsAt)) return { state: 'CLOSED' as const, closed: x.endsAt };
	if (x.state === 'PAUSED') return { state: 'PAUSED' as const };
	if (x.startsAt && now < Date.parse(x.startsAt)) return { state: 'PREPARING' as const };
	return { state: x.state === 'OPEN' || !!x.startsAt ? ('OPEN' as const) : ('PREPARING' as const) };
}
const cleanBallot = (b: Ballot) => ({ id: b.id, createdAt: b.createdAt, selections: b.selections });
export async function handleVoting(
	ctx: MockContext,
	path: string,
	method: string,
	options: MockRequestOptions,
	fullPath: string,
) {
	if (!/^\/api\/(admin\/(votes|draw-events)|votes)(\/|$)/.test(path)) return UNHANDLED;
	const s = state(ctx),
		admin = path.startsWith('/api/admin/');
	if (admin) ctx.requireAdmin();
	const pieces = path.split('/'),
		kind = pieces[admin ? 3 : 2],
		id = pieces[admin ? 4 : 3],
		action = pieces[admin ? 5 : 4],
		child = pieces[6];
	const raw = method === 'GET' || !options.body ? undefined : bodyObject(options),
		now = ctx.now();
	if (kind === 'draw-events') {
		if (method === 'GET') return s.events;
		const input = parseInput(DrawUpdateSchema, raw),
			old = s.events.find((e) => e.id === id);
		if (input.version !== (old?.version ?? 0)) fail(409, '추첨 설정이 변경되었습니다.');
		if (old && old.mode !== input.settings.mode && (!old.paused || !input.settings.paused))
			fail(409, '먼저 일시 정지해 주세요.');
		const next = {
			id: id ?? crypto.randomUUID(),
			version: (old?.version ?? 0) + 1,
			...input.settings,
			items: input.settings.items.map((i) => ({ ...i, id: i.id ?? crypto.randomUUID() })),
		};
		s.events = s.events.filter((e) => e.id !== id).concat(next);
		return next;
	}
	if (!id && admin) {
		if (method === 'GET') return s.votes;
		const settings = parseInput(VoteSettingsSchema, raw),
			v = { id: crypto.randomUUID(), version: 1, settings, ballotCount: 0, candidates: [] };
		s.votes.push(v);
		if (settings.state === 'CLOSED') s.closed[v.id] = now;
		return v;
	}
	const v = s.votes.find((v) => v.id === id);
	if (!v) fail(404, '투표를 찾을 수 없습니다.');
	const ballots = (s.ballots[v.id] ??= []),
		changes = (s.changes[v.id] ??= []);
	if (admin && !action && method === 'PUT') {
		const input = parseInput(VoteUpdateSchema, raw);
		if (input.version !== v.version) fail(409, '설정이 변경되었습니다.');
		if (ballots.length && v.settings.eventId !== input.settings.eventId)
			fail(409, '접수 후 행사 연결을 변경할 수 없습니다.');
		if (input.settings.state === 'CLOSED') s.closed[v.id] = effective(v, s).closed ?? now;
		v.settings = input.settings;
		v.version++;
		return v;
	}
	if (admin && action === 'posters')
		return Object.values(ctx.state.sessions)
			.filter((u) => u.voteId === v.id && u.state === 'READY')
			.map((u) => ({
				id: u.sessionId,
				posterUrl: '/mock/images/400x560.png',
				createdAt: u.completedAt ?? now,
			}));
	if (admin && action === 'sources')
		return Object.values(ctx.state.projects)
			.filter(
				(p) =>
					p.exhibitionId === v.settings.exhibitionId && p.status === 'PUBLISHED' && p.visibility === 'PUBLIC',
			)
			.map((p) => ({
				projectId: p.id,
				title: p.title,
				representationId: `00000000-0000-4000-8000-${String(p.id).padStart(12, '0')}`,
				posterUrl: '/mock/images/400x560.png',
			}));
	if (admin && action === 'candidates') {
		const input = parseInput(VoteCandidateInputSchema, raw);
		if (input.version !== v.version) fail(409, '후보가 변경되었습니다.');
		const old = v.candidates.find((c) => c.id === child);
		const next = {
			id: child ?? crypto.randomUUID(),
			title: input.title,
			posterUrl: '/mock/images/400x560.png',
			active: input.active,
			version: (old?.version ?? 0) + 1,
		};
		v.candidates = v.candidates.filter((c) => c.id !== child).concat(next);
		v.version++;
		changes.push({
			id: crypto.randomUUID(),
			version: v.version,
			kind: 'CANDIDATE',
			reason: input.reason,
			createdAt: now,
		});
		return v;
	}
	if (action === 'records') {
		if (admin && method === 'PUT') {
			const b = ballots.find((b) => b.id === child);
			if (!b) fail(404, '접수 기록이 없습니다.');
			const input = parseInput(VoteFlagSchema, raw);
			b.flagged = input.flagged;
			b.note = input.note;
			return { saved: true };
		}
		if (!admin && effective(v, s).state !== 'CLOSED') fail(403, '마감 후 공개됩니다.');
		const page = Math.max(1, Number(new URL(fullPath, 'https://mock.test').searchParams.get('page') ?? 1)),
			start = (page - 1) * 50;
		return {
			page,
			total: ballots.length,
			ballots: ballots
				.slice(start, start + 50)
				.map((b) => ({
					...cleanBallot(b),
					...(admin ? { flagged: b.flagged, note: b.note, investigation: null } : {}),
				})),
			totals: v.candidates.map((c) => ({
				id: c.id,
				title: c.title,
				count: ballots.filter((b) => b.selections.some((x) => x.id === c.id)).length,
			})),
			changes: changes.slice(start, start + 50),
			changesTotal: changes.length,
		};
	}
	const token = new Headers(options.headers).get('X-Vote-Participant');
	if (!token || !/^[a-f0-9]{64}$/.test(token)) fail(400, '브라우저 참여 정보가 필요합니다.');
	const hash = Array.from(
		new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))),
		(b) => b.toString(16).padStart(2, '0'),
	).join('');
	const b = ballots.find((b) => b.hash === hash),
		e = s.events.find((e) => e.id === v.settings.eventId);
	const draws = e ? (s.draws[e.id] ??= {}) : {},
		d = draws[hash];
	const eligible =
		!!e &&
		!e.paused &&
		s.votes.some((p) => {
			const status = effective(p, s);
			return (
				p.settings.eventId === e.id &&
				s.ballots[p.id]?.some((b) => b.hash === hash) &&
				(status.state === 'OPEN' ||
					(status.state === 'CLOSED' && !!status.closed && Date.now() < Date.parse(status.closed) + 1800000))
			);
		});
	if (!action && method === 'GET')
		return {
			id: v.id,
			title: v.settings.title,
			guidance: v.settings.guidance.replaceAll('{최대선택수}', String(v.settings.maxSelections)),
			version: v.version,
			maxSelections: v.settings.maxSelections,
			state: effective(v, s).state,
			candidates: v.candidates.filter((c) => c.active),
			ballot: b ? cleanBallot(b) : null,
			draw: d ?? null,
			drawEligible: !d && eligible,
			hasDraw: !!e,
		};
	if (action === 'ballots') {
		if (b) return cleanBallot(b);
		const input = parseInput(VoteSubmitSchema, raw);
		if (effective(v, s).state !== 'OPEN' || input.version !== v.version)
			fail(409, '최신 투표 상태를 확인해 주세요.');
		if (
			new Set(input.candidateIds).size !== input.candidateIds.length ||
			input.candidateIds.length > v.settings.maxSelections ||
			input.candidateIds.some((id) => !v.candidates.some((c) => c.id === id && c.active))
		)
			fail(400, '선택을 확인해 주세요.');
		const result = {
			id: crypto.randomUUID(),
			createdAt: now,
			selections: v.candidates.filter((c) => input.candidateIds.includes(c.id)).map((c) => ({ ...c })),
			hash,
			flagged: false,
			note: '',
		};
		ballots.push(result);
		v.ballotCount++;
		return cleanBallot(result);
	}
	if (action === 'draw') {
		if (d) return d;
		if (!e || !eligible) fail(403, '현재 추첨에 참여할 수 없습니다.');
		const items = e.items.filter((i) => i.active && (i.remaining === null || i.remaining > 0)),
			weights = items.map((i) => (e.mode === 'FINITE' ? i.remaining! : i.weight)),
			total = weights.reduce((a, b) => a + b, 0);
		if (!total) fail(409, '추첨 준비 중입니다. 다시 시도해 주세요.');
		let pick = (crypto.getRandomValues(new Uint32Array(1))[0]! / 4294967296) * total,
			i = 0;
		while (pick >= weights[i]!) {
			pick -= weights[i]!;
			i++;
		}
		const item = items[i]!;
		if (item.remaining !== null) item.remaining--;
		e.version++;
		return (draws[hash] = {
			id: crypto.randomUUID(),
			title: item.title,
			prize: item.prize,
			createdAt: now,
			receipt: null,
		});
	}
	if (action === 'receive') {
		if (!d?.prize) fail(404, '당첨 결과가 없습니다.');
		d.receipt ??= { id: crypto.randomUUID(), createdAt: now };
		return d;
	}
	return UNHANDLED;
}
