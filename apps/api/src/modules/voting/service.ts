import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto';
import {
	VoteSettingsSchema,
	VoteUpdateSchema,
	VoteCandidateInputSchema,
	VoteSubmitSchema,
	DrawUpdateSchema,
	VoteFlagSchema,
} from '@pcu/contracts';
import type { VoteSettings } from '@pcu/contracts';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import type { VotingRepository, VotingUnit } from './repository.js';

type Vote = NonNullable<Awaited<ReturnType<VotingUnit['vote']>>>;
type Candidate = Vote['candidates'][number];
type Ballot = NonNullable<Awaited<ReturnType<VotingUnit['ballot']>>>;
type Draw = NonNullable<Awaited<ReturnType<VotingUnit['draw']>>>;
type TimedVote = { state: string; startsAt: Date | null; endsAt: Date | null; closedAt: Date | null };
export function effectiveVote(
	v: TimedVote,
	now: Date,
): { state: VoteSettings['state']; closedAt: Date | null } {
	if (v.state === 'CLOSED') return { state: 'CLOSED', closedAt: v.closedAt };
	if (v.endsAt && now >= v.endsAt) return { state: 'CLOSED', closedAt: v.endsAt };
	if (v.state === 'PAUSED') return { state: 'PAUSED', closedAt: null };
	if (v.startsAt && now < v.startsAt) return { state: 'PREPARING', closedAt: null };
	if (v.state === 'OPEN' || (v.state === 'PREPARING' && v.startsAt && now >= v.startsAt))
		return { state: 'OPEN', closedAt: null };
	return { state: 'PREPARING', closedAt: null };
}
export function canDraw(v: TimedVote, now: Date) {
	const state = effectiveVote(v, now);
	return (
		state.state === 'OPEN' ||
		(state.state === 'CLOSED' &&
			state.closedAt !== null &&
			now.getTime() < state.closedAt.getTime() + 30 * 60_000)
	);
}
export function participantHash(token: unknown) {
	if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
		throw badRequest('참여 정보를 저장할 수 없습니다. 브라우저 쿠키 설정을 확인해 주세요.');
	return createHash('sha256').update(token).digest('hex');
}
export function environment(ua: string) {
	return {
		browser: /Edg\//.test(ua)
			? 'Edge'
			: /Firefox|FxiOS/.test(ua)
				? 'Firefox'
				: /Chrome|CriOS/.test(ua)
					? 'Chrome'
					: /Safari/.test(ua)
						? 'Safari'
						: 'Other',
		os: /Android/.test(ua)
			? 'Android'
			: /iPhone|iPad/.test(ua)
				? 'iOS'
				: /Windows/.test(ua)
					? 'Windows'
					: /Mac OS/.test(ua)
						? 'macOS'
						: /Linux/.test(ua)
							? 'Linux'
							: 'Other',
		mobile: /Mobile|Android|iPhone|iPad/.test(ua),
	};
}
export function createVotingService(
	repository: VotingRepository,
	config: {
		publicOrigin: string;
		publicBucket: string;
		investigationSecret?: string;
		privacyNotice?: string;
	},
) {
	const url = (p: { bucket: string; objectKey: string }) =>
		config.publicOrigin + '/' + p.objectKey.split('/').map(encodeURIComponent).join('/');
	const candidate = (c: Candidate) => ({
		id: c.id,
		title: c.title,
		posterUrl: url(c.poster),
		active: c.active,
		version: c.version,
	});
	// Selection snapshots are immutable; resolve their durable poster, not the current candidate poster.
	const ballot = (b: Ballot) => ({
		id: b.id,
		createdAt: b.createdAt.toISOString(),
		selections: b.selections.map((s) => ({
			id: s.candidateId,
			title: s.title,
			posterUrl: url(s.poster),
			active: false,
			version: s.version,
		})),
	});
	const draw = (d: Draw | null) =>
		d && {
			id: d.id,
			title: d.title,
			prize: d.prize,
			createdAt: d.createdAt.toISOString(),
			receipt: d.receipt && { id: d.receipt.id, createdAt: d.receipt.createdAt.toISOString() },
		};
	async function load(db: VotingUnit, id: string) {
		const v = await db.vote(id);
		if (!v) throw notFound('투표를 찾을 수 없습니다.');
		return v;
	}
	async function eligibility(db: VotingUnit, eventId: string, hash: string, now: Date) {
		const event = await db.event(eventId);
		return !!event && !event.paused && (await db.eligibleVotes(eventId, hash)).some((v) => canDraw(v, now));
	}
	const settings = (v: Vote): VoteSettings => ({
		exhibitionId: v.exhibitionId,
		title: v.title,
		guidance: v.guidance,
		maxSelections: v.maxSelections,
		state: VoteSettingsSchema.shape.state.parse(v.state),
		startsAt: v.startsAt?.toISOString() ?? null,
		endsAt: v.endsAt?.toISOString() ?? null,
		eventId: v.eventId,
	});
	const admin = (v: Vote) => ({
		id: v.id,
		version: v.version,
		settings: settings(v),
		candidates: v.candidates.map(candidate),
		ballotCount: v._count.ballots,
	});
	const eventView = (
		e:
			| NonNullable<Awaited<ReturnType<VotingUnit['event']>>>
			| Awaited<ReturnType<VotingUnit['events']>>[number],
	) => ({
		id: e.id,
		title: e.title,
		mode: e.mode,
		paused: e.paused,
		version: e.version,
		items: e.items.map((i) => ({
			id: i.id,
			title: i.title,
			prize: i.prize,
			remaining: i.remaining,
			weight: i.weight,
			active: i.active,
		})),
	});
	return {
		list: () => repository.transaction(async (db) => (await db.votes()).map(admin)),
		posters: (id: string) =>
			repository.transaction(async (db) => {
				await load(db, id);
				return (await db.posters(id)).map((p) => ({
					id: p.id,
					posterUrl: url(p),
					createdAt: p.createdAt.toISOString(),
				}));
			}),
		events: () => repository.transaction(async (db) => (await db.events()).map(eventView)),
		sources: (id: string) =>
			repository.transaction(async (db) => {
				const v = await load(db, id);
				return (await db.sources(v.exhibitionId)).flatMap((p) => {
					const r =
						p.poster?.status === 'READY'
							? p.poster.representations.find(
									(r) => r.state === 'READY' && r.role === 'DISPLAY_960' && r.bucket === config.publicBucket,
								)
							: undefined;
					return r ? [{ projectId: p.id, title: p.title, representationId: r.id, posterUrl: url(r) }] : [];
				});
			}),
		create: (raw: unknown, actorId: number) =>
			repository.transaction(async (db, now) => {
				const s = VoteSettingsSchema.parse(raw);
				if (!(await db.exhibition(s.exhibitionId))) throw notFound('전시회를 찾을 수 없습니다.');
				if (s.eventId && !(await db.event(s.eventId))) throw notFound('추첨 행사를 찾을 수 없습니다.');
				const v = await db.createVote({
					...s,
					startsAt: s.startsAt,
					endsAt: s.endsAt,
					closedAt: s.state === 'CLOSED' ? now : null,
				});
				await db.change({ voteId: v.id, version: 1, kind: 'SETTINGS', actorId, reason: '개설', detail: s });
				return admin(await load(db, v.id));
			}),
		update: (id: string, raw: unknown, actorId: number) =>
			repository.transaction(async (db, now) => {
				const input = VoteUpdateSchema.parse(raw),
					v = await load(db, id),
					s = input.settings;
				if (v.version !== input.version) throw conflict('설정이 변경되었습니다. 새로고침해 주세요.');
				if (s.exhibitionId !== v.exhibitionId) throw badRequest('전시회는 변경할 수 없습니다.');
				if (v._count.ballots && v.eventId !== s.eventId)
					throw conflict('접수 후 추첨 행사 연결은 변경할 수 없습니다.');
				if (s.eventId && !(await db.event(s.eventId))) throw notFound('추첨 행사를 찾을 수 없습니다.');
				if (s.state === 'OPEN' && s.endsAt && new Date(s.endsAt) <= now)
					throw badRequest('재개하려면 예약 마감을 지우거나 연장해 주세요.');
				const version = v.version + 1;
				const previous = effectiveVote(v, now);
				await db.updateVote(id, {
					...s,
					version,
					closedAt: s.state === 'CLOSED' ? (previous.closedAt ?? now) : null,
				});
				await db.change({ voteId: id, version, kind: 'SETTINGS', actorId, reason: input.reason, detail: s });
				return admin(await load(db, id));
			}),
		candidate: (id: string, candidateId: string | null, raw: unknown, actorId: number) =>
			repository.transaction(async (db) => {
				const input = VoteCandidateInputSchema.parse(raw),
					v = await load(db, id);
				if (v.version !== input.version) throw conflict('후보가 변경되었습니다. 새로고침해 주세요.');
				const old = candidateId ? await db.candidate(candidateId) : null;
				if (candidateId && (!old || old.voteId !== id)) throw notFound();
				let posterId = old?.posterId;
				if (input.posterId) {
					if ((await db.retainedPoster(input.posterId))?.voteId !== id)
						throw badRequest('투표용 포스터 처리가 완료되지 않았습니다.');
					posterId = input.posterId;
				}
				if (input.representationId) {
					const r = await db.representation(input.representationId);
					const a = r?.asset;
					if (
						!r ||
						!a ||
						r.state !== 'READY' ||
						a.status !== 'READY' ||
						r.role !== 'DISPLAY_960' ||
						r.bucket !== config.publicBucket ||
						!r.mimeType.startsWith('image/')
					)
						throw badRequest('처리가 완료된 공개 포스터가 필요합니다.');
					const p = a.project;
					// Explicitly deny automatic publication of private/staged project bytes.
					if (
						p
							? p.visibility !== 'PUBLIC' || p.exhibition.visibility !== 'PUBLIC' || p.status !== 'PUBLISHED'
							: a.exhibition?.visibility !== 'PUBLIC'
					)
						throw forbidden('공개 승인이 완료된 이미지만 사용할 수 있습니다.');
					if (input.sourceProjectId && (p?.id !== input.sourceProjectId || p.exhibitionId !== v.exhibitionId))
						throw badRequest('전시회 작품과 포스터가 일치하지 않습니다.');
					posterId = (await db.poster(id, r.bucket, r.objectKey)).id;
				}
				if (!posterId) throw badRequest('포스터를 등록해 주세요.');
				const version = v.version + 1;
				const c = await db.saveCandidate(candidateId, {
					voteId: id,
					title: input.title,
					sourceProjectId: old?.sourceProjectId ?? input.sourceProjectId,
					active: input.active,
					posterId,
					version: (old?.version ?? 0) + 1,
				});
				await db.updateVote(id, { version });
				await db.change({
					voteId: id,
					version,
					kind: 'CANDIDATE',
					actorId,
					reason: input.reason,
					detail: {
						candidateId: c.id,
						title: c.title,
						active: c.active,
						posterId,
						candidateVersion: c.version,
					},
				});
				return admin(await load(db, id));
			}),
		view: (id: string, hash: string) =>
			repository.transaction(async (db, now) => {
				const v = await load(db, id),
					b = await db.ballot(id, hash),
					d = v.eventId ? await db.draw(v.eventId, hash) : null;
				return {
					privacyNotice: config.investigationSecret ? (config.privacyNotice ?? null) : null,
					id: v.id,
					title: v.title,
					guidance: v.guidance.replaceAll('{최대선택수}', String(v.maxSelections)),
					maxSelections: v.maxSelections,
					version: v.version,
					state: effectiveVote(v, now).state,
					candidates: v.candidates.filter((c) => c.active).map(candidate),
					ballot: b ? ballot(b) : null,
					draw: draw(d),
					hasDraw: !!v.eventId,
					drawEligible: !!v.eventId && !d && (await eligibility(db, v.eventId, hash, now)),
				};
			}),
		submit: (id: string, hash: string, raw: unknown, ip: string, ua: string) =>
			repository.transaction(async (db, now) => {
				const input = VoteSubmitSchema.parse(raw),
					v = await load(db, id),
					existing = await db.ballot(id, hash);
				if (existing) return ballot(existing);
				if (effectiveVote(v, now).state !== 'OPEN') throw conflict('현재 투표를 접수하지 않습니다.');
				if (input.version !== v.version)
					throw conflict('후보 또는 선택 수가 변경되었습니다. 최신 화면을 확인해 주세요.');
				const ids = new Set(input.candidateIds);
				if (
					ids.size !== input.candidateIds.length ||
					ids.size > v.maxSelections ||
					[...ids].some((id) => !v.candidates.some((c) => c.id === id && c.active))
				)
					throw badRequest('선택한 작품을 다시 확인해 주세요.');
				await db.participant(hash);
				const b = await db.createBallot({
					voteId: id,
					participantHash: hash,
					version: v.version,
					createdAt: now,
					selections: {
						create: v.candidates
							.filter((c) => ids.has(c.id))
							.map((c) => ({ candidateId: c.id, title: c.title, posterId: c.posterId, version: c.version })),
					},
					...(config.investigationSecret
						? {
								investigation: {
									create: {
										ipHash: createHmac('sha256', config.investigationSecret).update(ip).digest('hex'),
										...environment(ua),
										expiresAt: new Date(now.getTime() + 30 * 86400000),
									},
								},
							}
						: {}),
				});
				await db.change({
					voteId: id,
					version: v.version,
					kind: 'BALLOT',
					reason: '접수',
					detail: { ballotId: b.id },
				});
				return ballot(b);
			}),
		records: (id: string, page: number, isAdmin = false) =>
			repository.transaction(async (db, now) => {
				const v = await load(db, id);
				if (!isAdmin && effectiveVote(v, now).state !== 'CLOSED') throw forbidden('마감 후 공개됩니다.');
				await db.purge();
				const ballots = await db.ballots(id, (page - 1) * 50, 50),
					total = await db.countBallots(id);
				if (isAdmin)
					return {
						page,
						total,
						ballots: ballots.map((b) => ({
							...ballot(b),
							flagged: b.flagged,
							note: b.note,
							investigation: b.investigation && {
								...b.investigation,
								expiresAt: b.investigation.expiresAt.toISOString(),
							},
						})),
					};
				const totals = await db.totals(id),
					changes = await db.changes(id, (page - 1) * 50, 50);
				return {
					page,
					total,
					ballots: ballots.map(ballot),
					totals: v.candidates.map((c) => ({
						id: c.id,
						title: c.title,
						count: totals.find((t) => t.candidateId === c.id)?._count ?? 0,
					})),
					changes: await Promise.all(
						changes.map(async (c) => {
							const detail =
								c.detail && typeof c.detail === 'object' && !Array.isArray(c.detail) ? c.detail : {};
							const poster =
								typeof detail.posterId === 'string' ? await db.retainedPoster(detail.posterId) : null;
							const snapshot =
								poster &&
								typeof detail.candidateId === 'string' &&
								typeof detail.title === 'string' &&
								typeof detail.active === 'boolean' &&
								typeof detail.candidateVersion === 'number'
									? {
											id: detail.candidateId,
											title: detail.title,
											active: detail.active,
											version: detail.candidateVersion,
											posterUrl: url(poster),
										}
									: null;
							return {
								id: c.id,
								version: c.version,
								kind: c.kind,
								reason: c.reason,
								createdAt: c.createdAt.toISOString(),
								candidate: snapshot,
							};
						}),
					),
					changesTotal: await db.countChanges(id),
				};
			}),
		flag: (id: string, ballotId: string, raw: unknown, actorId: number) =>
			repository.transaction(async (db) => {
				const input = VoteFlagSchema.parse(raw),
					v = await load(db, id);
				await db.flag(ballotId, id, input.flagged, input.note);
				await db.change({
					voteId: id,
					version: v.version,
					actorId,
					kind: 'FLAG',
					reason: input.reason,
					detail: { ballotId, flagged: input.flagged, note: input.note },
				});
				return { saved: true };
			}),
		saveEvent: (id: string | null, raw: unknown, actorId: number) =>
			repository.transaction(async (db) => {
				const input = DrawUpdateSchema.parse(raw),
					old = id ? await db.event(id) : null,
					s = input.settings;
				if (id && !old) throw notFound();
				if (input.version !== (old?.version ?? 0)) throw conflict('추첨 설정이 변경되었습니다.');
				if (old && old._count.draws && old.mode !== s.mode && (!old.paused || !s.paused))
					throw conflict('방식 변경은 일시 정지 상태에서 적용해 주세요.');
				const ids = s.items.flatMap((i) => (i.id ? [i.id] : []));
				if (new Set(ids).size !== ids.length || ids.some((i) => !old?.items.some((o) => o.id === i)))
					throw badRequest('결과 항목 식별자가 올바르지 않습니다.');
				if (old?.items.some((o) => !ids.includes(o.id)))
					throw badRequest('과거 항목은 삭제 대신 비활성화해 주세요.');
				const eventId = id ?? randomUUID(),
					version = (old?.version ?? 0) + 1;
				await db.saveEvent(eventId, { title: s.title, mode: s.mode, paused: s.paused, version });
				for (const i of s.items) await db.saveItem(i.id ?? randomUUID(), { ...i, eventId });
				const result = (await db.event(eventId))!;
				await db.eventChange({
					eventId,
					version,
					actorId,
					reason: input.reason,
					configuration: {
						before: old ? { mode: old.mode, items: old.items } : null,
						after: { mode: result.mode, items: result.items },
					},
				});
				return eventView(result);
			}),
		draw: (id: string, hash: string) =>
			repository.transaction(async (db, now) => {
				const v = await load(db, id);
				if (!v.eventId) throw notFound();
				const existing = await db.draw(v.eventId, hash);
				if (existing) return draw(existing)!;
				if (!(await eligibility(db, v.eventId, hash, now)))
					throw forbidden('현재 추첨에 참여할 수 없습니다.');
				const e = (await db.event(v.eventId))!;
				const items = e.items.filter((i) => i.active && (i.remaining === null || i.remaining > 0));
				const weights = items.map((i) => (e.mode === 'FINITE' ? i.remaining! : i.weight));
				const total = weights.reduce((a, b) => a + b, 0);
				if (!total) throw conflict('추첨 준비 중입니다. 기한 안에 다시 시도해 주세요.');
				const ticket = randomInt(total);
				let offset = ticket,
					selected = items[0]!;
				for (let i = 0; i < items.length; i++) {
					selected = items[i]!;
					if (offset < weights[i]!) break;
					offset -= weights[i]!;
				}
				if (selected.remaining !== null) await db.decrement(selected.id);
				await db.saveEvent(e.id, { title: e.title, mode: e.mode, paused: e.paused, version: e.version + 1 });
				await db.eventChange({
					eventId: e.id,
					version: e.version + 1,
					reason: '추첨 재고 확보',
					configuration: {
						itemId: selected.id,
						remainingBefore: selected.remaining,
						remainingAfter: selected.remaining === null ? null : selected.remaining - 1,
					},
				});
				return draw(
					await db.createDraw({
						eventId: e.id,
						participantHash: hash,
						title: selected.title,
						prize: selected.prize,
						itemId: selected.id,
						version: e.version,
						createdAt: now,
						calculation: {
							mode: e.mode,
							items: items.map((i, n) => ({ id: i.id, remaining: i.remaining, weight: weights[n]! })),
							total,
							ticket,
						},
					}),
				)!;
			}),
		receive: (id: string, hash: string) =>
			repository.transaction(async (db) => {
				const v = await load(db, id),
					d = v.eventId ? await db.draw(v.eventId, hash) : null;
				if (!d || !d.prize) throw notFound();
				await db.receive(d.id);
				return draw(await db.draw(d.eventId, hash))!;
			}),
	};
}
