/* @vitest-environment jsdom */
import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VotePage from '../pages/VotePage';
import { votingIdentity, stableCandidateOrder } from '../features/voting/participant';
import { votingApi } from '../features/voting/api';
import { MOCK_VOTE_ID } from '../lib/api/mock/voting';
import { resetMockState, reloadMockState, updateMockState, selectMockUser } from '../lib/api/mock/transport';
let lockQueue: Promise<unknown> = Promise.resolve();
beforeEach(async () => {
	vi.stubEnv('VITE_MOCK', 'true');
	vi.stubGlobal('crypto', webcrypto);
	Object.defineProperty(navigator, 'locks', {
		configurable: true,
		value: {
			request: (_name: string, fn: () => unknown) => {
				const next = lockQueue.then(fn);
				lockQueue = next.catch(() => undefined);
				return next;
			},
		},
	});
	Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
		configurable: true,
		value: function (this: HTMLDialogElement) {
			this.open = true;
		},
	});
	Object.defineProperty(HTMLDialogElement.prototype, 'close', {
		configurable: true,
		value: function (this: HTMLDialogElement) {
			this.open = false;
		},
	});
	document.cookie = 'pcu_vote_participant=; Max-Age=0; Path=/';
	await resetMockState();
});
afterEach(() => {
	cleanup();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});
function mount(path = `/votes/${MOCK_VOTE_ID}`) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<Routes>
				<Route path="/votes/:publicId" element={<VotePage />} />
				<Route path="/votes/:publicId/records" element={<VotePage />} />
				<Route path="/votes/:publicId/draw" element={<VotePage />} />
			</Routes>
		</MemoryRouter>,
	);
}
describe('voting browser state and HTTP mock', () => {
	it('coordinates simultaneous identity creation and preserves existing order on refetch', async () => {
		const tokens = await Promise.all(Array.from({ length: 10 }, () => votingIdentity()));
		expect(new Set(tokens).size).toBe(1);
		expect(tokens[0]).toMatch(/^[a-f0-9]{64}$/);
		const first = stableCandidateOrder(['a', 'b', 'c']);
		expect(stableCandidateOrder(['c', 'b', 'a', 'd'], first)).toEqual([...first, 'd']);
		expect(stableCandidateOrder(['b', 'c'], first)).toEqual(first.filter((id) => id !== 'a'));
	});
	it('blocks participation when stable identity cannot be created', async () => {
		Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
		await expect(votingIdentity()).rejects.toThrow('최신 브라우저');
		mount();
		expect(await screen.findByRole('alert')).toBeTruthy();
		expect(screen.queryByText('투표 완료')).toBeNull();
	});
	it('limits selections, retains card order, confirms, and restores the committed result after remount', async () => {
		const mounted = mount();
		await screen.findByRole('button', { name: '작품 1' });
		const order = screen.getAllByRole('button', { name: /작품 \d/ }).map((b) => b.getAttribute('aria-label'));
		fireEvent.click(screen.getByRole('button', { name: '작품 1' }));
		fireEvent.click(screen.getByRole('button', { name: '작품 2' }));
		expect((screen.getByRole('button', { name: '작품 3' }) as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(screen.getByRole('button', { name: '작품 1' }));
		expect((screen.getByRole('button', { name: '작품 3' }) as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(screen.getByRole('button', { name: '작품 1' }));
		await act(async () => {
			window.dispatchEvent(new Event('focus'));
		});
		expect(
			screen.getAllByRole('button', { name: /작품 \d/ }).map((b) => b.getAttribute('aria-label')),
		).toEqual(order);
		fireEvent.click(screen.getByText('투표 완료'));
		expect(await screen.findByRole('dialog')).toBeTruthy();
		fireEvent.click(screen.getByText('최종 제출'));
		expect(await screen.findByText('참여해주셔서 감사합니다!')).toBeTruthy();
		mounted.unmount();
		mount();
		expect(await screen.findByText('참여해주셔서 감사합니다!')).toBeTruthy();
		expect((await reloadMockState()).voting?.ballots[MOCK_VOTE_ID]).toHaveLength(1);
	});
	it('refreshes stale candidates without losing valid selections or committing', async () => {
		mount();
		await screen.findByRole('button', { name: '작품 1' });
		fireEvent.click(screen.getByRole('button', { name: '작품 1' }));
		await updateMockState((s) => {
			s.voting!.votes[0]!.version++;
		});
		fireEvent.click(screen.getByText('투표 완료'));
		fireEvent.click(screen.getByText('최종 제출'));
		expect(await screen.findByRole('alert')).toBeTruthy();
		await waitFor(() =>
			expect(screen.getByRole('button', { name: '작품 1' }).getAttribute('aria-pressed')).toBe('true'),
		);
		expect((await reloadMockState()).voting?.ballots[MOCK_VOTE_ID]).toHaveLength(0);
	});
	it('shares saved draw/receipt results and hides reopened public records', async () => {
		let v = (await votingApi.list())[0]!;
		const e = await votingApi.saveEvent(
			null,
			0,
			{
				title: '경품 행사',
				mode: 'WEIGHTED',
				paused: false,
				items: [{ title: '기념품', prize: true, remaining: null, weight: 1, active: true }],
			},
			'개설',
		);
		v = await votingApi.update(v, { ...v.settings, eventId: e.id }, '연결');
		await votingApi.submit(v.id, v.version, [v.candidates[0]!.id]);
		const d = await votingApi.draw(v.id);
		expect((await votingApi.draw(v.id)).id).toBe(d.id);
		const receipt = await votingApi.receive(v.id);
		expect((await votingApi.receive(v.id)).receipt).toEqual(receipt.receipt);
		v = await votingApi.update(v, { ...v.settings, state: 'CLOSED' }, '마감');
		expect((await votingApi.records(v.id, 1)).total).toBe(1);
		await votingApi.update(v, { ...v.settings, state: 'OPEN' }, '재개');
		await expect(votingApi.records(v.id, 1)).rejects.toMatchObject({ status: 403 });
		await selectMockUser('owner');
		await expect(votingApi.list()).rejects.toMatchObject({ status: 403 });
	});
});
