import { describe, expect, it } from 'vitest';
import { canDraw, effectiveVote, environment, participantHash } from '../modules/voting/service.js';
import { DrawSettingsSchema, VoteSettingsSchema } from '@pcu/contracts';
const time = new Date('2026-10-08T12:00:00Z');
const vote = {
	state: 'PREPARING',
	startsAt: new Date('2026-10-08T12:00:00Z'),
	endsAt: new Date('2026-10-08T13:00:00Z'),
	closedAt: null,
};
describe('voting time and input policy', () => {
	it('starts/closes exactly at the database timestamp and measures grace from the deadline', () => {
		expect(effectiveVote(vote, new Date(time.getTime() - 1)).state).toBe('PREPARING');
		expect(effectiveVote(vote, time).state).toBe('OPEN');
		expect(effectiveVote(vote, vote.endsAt)).toEqual({ state: 'CLOSED', closedAt: vote.endsAt });
		expect(canDraw(vote, new Date('2026-10-08T13:29:59.999Z'))).toBe(true);
		expect(canDraw(vote, new Date('2026-10-08T13:30:00Z'))).toBe(false);
	});
	it('blocks paused eligibility and restores it on reopen without shifting an explicit close', () => {
		expect(canDraw({ ...vote, state: 'PAUSED' }, time)).toBe(false);
		expect(canDraw({ ...vote, state: 'OPEN' }, time)).toBe(true);
		expect(
			effectiveVote({ ...vote, state: 'CLOSED', closedAt: time }, new Date('2026-10-08T13:20:00Z')),
		).toEqual({ state: 'CLOSED', closedAt: time });
	});
	it('stores only a digest and coarse environment families', () => {
		const token = 'a'.repeat(64);
		expect(participantHash(token)).not.toBe(token);
		expect(participantHash(token)).toHaveLength(64);
		for (const invalid of [undefined, 'a', Array(2).fill(token), 'x'.repeat(64)])
			expect(() => participantHash(invalid)).toThrow();
		expect(
			environment(
				'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
			),
		).toEqual({ browser: 'Safari', os: 'iOS', mobile: true });
	});
	it('rejects invalid draw capacity and invalid scheduled intervals', () => {
		expect(
			DrawSettingsSchema.safeParse({
				title: 'test',
				mode: 'FINITE',
				paused: false,
				items: [{ title: 'blank', prize: false, remaining: null, weight: 1, active: true }],
			}).success,
		).toBe(false);
		expect(
			DrawSettingsSchema.safeParse({
				title: 'test',
				mode: 'WEIGHTED',
				paused: false,
				items: [{ title: 'blank', prize: false, remaining: null, weight: 0, active: true }],
			}).success,
		).toBe(false);
		expect(
			VoteSettingsSchema.safeParse({
				exhibitionId: 1,
				title: 'test',
				guidance: '',
				maxSelections: 1,
				state: 'PREPARING',
				startsAt: '2026-10-08T13:00:00Z',
				endsAt: '2026-10-08T12:00:00Z',
				eventId: null,
			}).success,
		).toBe(false);
	});
});
