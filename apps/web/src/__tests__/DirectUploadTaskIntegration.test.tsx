/* @vitest-environment jsdom */
import { setupFileIdentityEnvironment } from './helpers/file-identity';
setupFileIdentityEnvironment();
import { StrictMode, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminProjectDetail, DirectAssetUploadKind, DirectAssetUploadOwner, DirectAssetUploadStatus } from '../contracts';
import DirectImageUploadWidget from '../components/DirectImageUploadWidget';
import DirectVideoUploadWidget from '../components/DirectVideoUploadWidget';
import GameUploadWidget from '../components/GameUploadWidget';
import { VotePosterUpload } from '../features/voting/VotePosterUpload';
import { getDirectUploadTask, resetDirectUploadTasksForTests, sessionOf, type SubmissionBinding } from '../lib/upload/directUploadTask';
import { createFileSourceIdentity } from '../lib/file-identity';
import { LinearUploadContext } from '../lib/upload/linearPresentation';
import * as fileIdentity from '../lib/file-identity';
import { getClientUploadLimits } from '../lib/upload-limits';
import * as uploadApi from '../lib/api/game-upload';
import { AdminProjectUploadProvider, AdminProjectAssetManager, AdminProjectUploadProgress, useAdminProjectUploadQueue } from '../features/admin/projects/AdminProjectAssetManager';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ ok: status < 400, data }), { status, statusText: status >= 400 ? 'Control request failed' : 'OK', headers: { 'content-type': 'application/json' } });
const binding = { id: 'item', clientToken: 'a'.repeat(32) };
afterEach(() => {
	cleanup(); resetDirectUploadTasksForTests(); sessionStorage.clear();
	vi.unstubAllGlobals(); vi.restoreAllMocks();
});

function network(kind: DirectAssetUploadKind, owner: DirectAssetUploadOwner = { type: 'PROJECT', id: 7 }) {
	const sessions = new Map<string, DirectAssetUploadStatus>();
	const identities = new Map<string, DirectAssetUploadStatus>();
	const createRequests: { clientUploadId: string; originalName: string }[] = [];
	const dispatchedRecords: unknown[] = [];
	const creates: { session: DirectAssetUploadStatus; response: ReturnType<typeof deferred<Response>> }[] = [];
	const statuses: { id: string; response: ReturnType<typeof deferred<Response>> }[] = [];
	const lookups: ReturnType<typeof deferred<Response>>[] = [];
	const rejections: { response: ReturnType<typeof deferred<Response>>; rejection: Response }[] = [];
	const completes: { id: string; response: ReturnType<typeof deferred<Response>> }[] = [];
	const deletes: { id: string; response: ReturnType<typeof deferred<Response>> }[] = [];
	const controls = { holdStatus: false, holdCreate: true, holdComplete: false, holdDelete: false, loseDelete: false, loseCreate: false, rejectCreate: false, rejectName: '', rejectCode: 'ERROR', holdRejection: false, failStatus: false, cancelConflict: false, linked: true, wrongToken: false, failLookup: false, holdLookup: false, missCreate: false, allocating: false, hideCreation: false };
	const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const path = new URL(String(input), 'https://test.invalid').pathname;
		if (/\/direct-\w+-upload-sessions$/.test(path) && init?.method === 'POST') {
			const body = JSON.parse(String(init.body));
			createRequests.push(body);
			dispatchedRecords.push(Object.keys(sessionStorage).filter(key => key.endsWith(':creation'))
				.map(key => JSON.parse(sessionStorage.getItem(key)!)).find(record => record.request?.clientUploadId === body.clientUploadId));
			if (controls.rejectCreate || controls.rejectName === body.originalName) {
				const response = deferred<Response>();
				const rejection = new Response(JSON.stringify({ ok: false, error: { code: controls.rejectCode, message: 'Invalid upload size' } }), { status: controls.rejectCode === 'ERROR' ? 400 : 409 });
				if (controls.holdRejection) { rejections.push({ response, rejection }); return response.promise; }
				return rejection;
			}
			const existing = identities.get(body.clientUploadId);
			if (existing) return json(existing);
			if (controls.missCreate) throw new TypeError('request did not reach server');
			const session: DirectAssetUploadStatus = { ...body, sessionId: `session-${creates.length + 1}`, owner, kind,
				generation: 1, partSizeBytes: 16, totalParts: 1, expiresAt: '2027-01-01T00:00:00.000Z', state: controls.allocating ? 'ALLOCATING' : 'UPLOADING', parts: [] };
			const response = deferred<Response>(); creates.push({ session, response });
			sessions.set(session.sessionId, session); identities.set(body.clientUploadId, session);
			if (controls.loseCreate) throw new TypeError('response lost after server allocation');
			return controls.holdCreate ? response.promise : json(session);
		}
		if (path.includes('/direct-asset-upload-creations/')) {
			if (controls.holdLookup) { const response = deferred<Response>(); lookups.push(response); return response.promise; }
			if (controls.failLookup) return json({}, 503);
			const clientUploadId = path.split('/').at(-1)!;
			const session = controls.hideCreation ? undefined : identities.get(clientUploadId);
			return json(session ? { status: 'OBSERVED', session } : { status: 'NOT_OBSERVED', clientUploadId });
		}
		if (path.endsWith('/submission')) {
			const session = [...sessions.values()].at(-1);
			return json({ projectId: 7, state: 'PENDING', items: [{ ...binding, clientToken: controls.wrongToken ? 'foreign' : binding.clientToken, kind,
				state: session ? 'UPLOADING' : 'EXPECTED', ...(session && controls.linked ? { sessionId: session.sessionId, generation: session.generation } : {}) }] });
		}
		if (path.endsWith('/upload-config')) return json({ materialMaxCount: 10, materialMaxBytes: 1024 * 1024 });
		const match = path.match(/\/direct-asset-upload-sessions\/([^/]+)(.*)$/);
		if (!match) throw new Error(`Unexpected network request: ${path}`);
		const [, id, suffix] = match;
		const session = sessions.get(id!)!;
		if (suffix === '/part-urls') return json({ generation: 1, parts: [{ partNumber: 1, url: `https://test.invalid/api/admin/direct-asset-upload-sessions/${id}/part`, requiredHeaders: {} }] });
		if (suffix === '/part') return new Response(null, { status: 200, headers: { etag: 'part-etag' } });
		if (suffix === '/complete') {
			const response = deferred<Response>(); completes.push({ id: id!, response });
			if (controls.holdComplete) return response.promise;
			session.state = 'READY';
			return json({ status: 'READY', sessionId: id, generation: 1, sizeBytes: session.totalBytes });
		}
		if (init?.method === 'DELETE') {
			const response = deferred<Response>(); deletes.push({ id: id!, response });
			if (controls.holdDelete) return response.promise;
			if (controls.loseDelete) throw new TypeError('DELETE response lost; server may still commit');
			if (controls.cancelConflict) return json({}, 409);
			session.state = 'CANCELLED'; return new Response(null, { status: 204 });
		}
		if (controls.holdStatus) { const response = deferred<Response>(); statuses.push({ id: id!, response }); return response.promise; }
		if (controls.failStatus) return json({}, 503);
		return json(session);
	});
	vi.stubGlobal('fetch', fetcher);
	return { controls, sessions, creates, rejections, lookups, statuses, createRequests, dispatchedRecords, completes, deletes, fetcher,
		async seed(file: File, state: DirectAssetUploadStatus['state'] = 'UPLOADING') {
			const source = await createFileSourceIdentity(file);
			const session: DirectAssetUploadStatus = { ...source, sessionId: 'recovered', owner, kind, generation: 1,
				partSizeBytes: 16, totalParts: 1, expiresAt: '2027-01-01T00:00:00.000Z', state, originalName: file.name, totalBytes: file.size, parts: [] };
			sessions.set(session.sessionId, session); return session;
		},
	};
}
function client(role = 'ADMIN') {
	const value = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	value.setQueryData(['me'], { authenticated: true, user: { id: 9, role, name: 'Admin' } });
	return value;
}
function widget(kind: 'IMAGE' | 'VIDEO' | 'GAME' | 'WEBGL', file: File | undefined, onComplete: () => void, onCancelled: () => void, item?: SubmissionBinding, operationKey?: string, autoStart = Boolean(file)) {
	const props = { operationKey, autoStart, onComplete, onCancelled };
	if (kind === 'GAME' || kind === 'WEBGL') return <GameUploadWidget {...props} uploadKind={kind} projectId={7} initialFile={file} submissionItem={item} />;
	if (kind === 'VIDEO') return <DirectVideoUploadWidget {...props} projectId={7} initialFiles={file ? [file] : []} submissionItems={item ? [item] : []} />;
	return <DirectImageUploadWidget {...props} owner={{ type: 'PROJECT', id: 7 }} kind="IMAGE" initialFiles={file ? [file] : []} submissionItems={item ? [item] : []} />;
}
function mount(kind: 'IMAGE' | 'VIDEO' | 'GAME' | 'WEBGL', file?: File, complete = vi.fn(), cancelled = vi.fn(), item?: SubmissionBinding, operationKey?: string, role = 'ADMIN') {
	return { complete, cancelled, ...render(<StrictMode><QueryClientProvider client={client(role)}>{widget(kind, file, complete, cancelled, item, operationKey)}</QueryClientProvider></StrictMode>) };
}
const cancel = () => fireEvent.click(screen.getByRole('button', { name: /^취소/ }));
const retry = () => fireEvent.click(screen.getByRole('button', { name: /시작|재시도|이어올리기/ }));

describe.each(['IMAGE', 'VIDEO', 'GAME'] as const)('%s job handoff through React and production multipart client', kind => {
	const file = () => new File(['same-file'], kind === 'GAME' ? 'game.zip' : kind === 'VIDEO' ? 'video.mp4' : 'cover.png');
	const storageKey = () => kind === 'GAME' ? 'pcu.direct-asset-upload:7:GAME' : kind === 'IMAGE' ? 'pcu.direct-image-upload:PROJECT:7' : 'pcu.direct-video-upload:7';
	async function pausedSession() {
		const net = network(kind); const chosen = file(); const view = mount(kind, chosen);
		await waitFor(() => expect(net.creates).toHaveLength(1));
		fireEvent.click(screen.getByRole('button', { name: '일시 정지' }));
		await act(async () => net.creates[0]!.response.resolve(json(net.creates[0]!.session)));
		await screen.findByRole('button', { name: '이어올리기' });
		return { net, chosen, view, task: getDirectUploadTask('9', storageKey()) };
	}
	function expectResumeBlocked(task: ReturnType<typeof getDirectUploadTask>) {
		expect((screen.getByRole('button', { name: /시작|재시도|이어올리기/ }) as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByText(/이어올릴 수 없습니다/)).toBeTruthy();
		expect(task.beginRun()).toBeNull();
		expect(task.forget(task.getSaved() ? sessionOf(task.getSaved()!).sessionId : '')).toBe(false);
	}
	it('resumes a paused upload through the real client onSession without adding DELETE', async () => {
		const { net, view, task } = await pausedSession();
		const sessionCallback = vi.spyOn(task, 'remember');
		retry(); await waitFor(() => expect(view.complete).toHaveBeenCalledOnce());
		// transfer invokes remember only through onSession; resume must exercise it too.
		expect(sessionCallback).toHaveBeenCalled(); expect(net.deletes).toHaveLength(0);
		expect(net.creates).toHaveLength(1); expect(view.cancelled).not.toHaveBeenCalled();
	});
	it('keeps cancellation of a legacy known session blocked across reload without a creation record', async () => {
		const net = network(kind); const chosen = file(); const saved = await net.seed(chosen);
		const task = getDirectUploadTask('9', storageKey()); task.remember(saved);
		net.controls.loseDelete = true; await task.cancel(); resetDirectUploadTasksForTests();
		const restored = getDirectUploadTask('9', storageKey());
		const cancelled = vi.fn(); const detach = restored.attach({}, { onCancelled: cancelled, onCancelSettled: vi.fn(), onCancelReady: vi.fn(), onCancelError: vi.fn() });
		expect(restored.getSnapshot().control).toBe('cancel-unconfirmed'); expect(restored.beginRun()).toBeNull();
		expect(sessionStorage.getItem(`${storageKey()}:creation`)).toBeNull();
		net.controls.loseDelete = false; await restored.cancel();
		expect(cancelled).toHaveBeenCalledOnce(); expect(net.deletes).toHaveLength(2); detach();
	});
	it('fences a late resumed onSession during cancellation and after a new logical job starts', async () => {
		const net = network(kind); const chosen = file(); const saved = await net.seed(chosen);
		const task = getDirectUploadTask('9', storageKey()); task.remember(saved);
		const cancelled = vi.fn(); const detach = task.attach({}, { onCancelled: cancelled, onCancelSettled: vi.fn(), onCancelReady: vi.fn(), onCancelError: vi.fn() });
		type Result = Awaited<ReturnType<typeof uploadApi.uploadDirectAssetFile>>;
		const transfers: { options: NonNullable<Parameters<typeof uploadApi.uploadDirectAssetFile>[4]>; result: ReturnType<typeof deferred<Result>> }[] = [];
		// Supplement the real-client tests with a transport that ignores abort and
		// invokes onSession after its run has lost ownership.
		vi.spyOn(uploadApi, 'uploadDirectAssetFile').mockImplementation(async (_owner, _file, _kind, _progress, options = {}) => {
			const result = deferred<Result>(); transfers.push({ options, result }); return result.promise;
		});
		const oldRun = task.beginRun()!;
		const oldTransfer = task.transfer(oldRun, [saved.owner, chosen, kind, undefined, { resume: saved }], session => session);
		net.controls.loseDelete = true; await task.cancel();
		transfers[0]!.options.onSession!(saved);
		expect(net.deletes).toHaveLength(1); expect(task.beginRun()).toBeNull();
		net.controls.loseDelete = false; await task.cancel(); expect(cancelled).toHaveBeenCalledOnce();
		const nextRun = task.beginRun()!;
		const nextTransfer = task.transfer(nextRun, [saved.owner, chosen, kind], session => session);
		const next = { ...saved, sessionId: 'next-session' }; transfers[1]!.options.onSession!(next);
		transfers[0]!.options.onSession!(saved);
		transfers[0]!.result.resolve({ status: 'READY', sessionId: saved.sessionId, generation: saved.generation, sizeBytes: chosen.size });
		await oldTransfer;
		expect(task.getSaved()).toEqual(next); expect(task.isCurrentRun(nextRun.token)).toBe(true); expect(net.deletes).toHaveLength(2);
		expect(task.acceptReady(oldRun, saved.sessionId, saved.generation)).toBe(false);
		transfers[1]!.result.resolve({ status: 'READY', sessionId: next.sessionId, generation: next.generation, sizeBytes: chosen.size });
		await nextTransfer; expect(task.acceptReady(nextRun, next.sessionId, next.generation)).toBe(true);
		expect(cancelled).toHaveBeenCalledOnce(); detach();
	});
	it.each(['status-known', 'status-unavailable'] as const)('blocks resume after a failed DELETE (%s), survives reentry/reload and retries cancellation', async failure => {
		const { net, chosen, view: old, task } = await pausedSession();
		net.controls.loseDelete = true; net.controls.failStatus = failure === 'status-unavailable';
		cancel(); await screen.findByText(/취소 결과가 미확정/);
		expectResumeBlocked(task); retry(); expect(net.deletes).toHaveLength(1); expect(net.completes).toHaveLength(0);
		old.unmount();
		const reentry = mount(kind, chosen); expectResumeBlocked(task); reentry.unmount();
		resetDirectUploadTasksForTests();
		const view = mount(kind, chosen); const restored = getDirectUploadTask('9', storageKey());
		expectResumeBlocked(restored); expect(net.deletes).toHaveLength(1);
		net.controls.failStatus = false;
		// One UPLOADING observation is still no guarantee that the old DELETE is gone.
		await act(async () => restored.restore()); expectResumeBlocked(restored);
		net.controls.loseDelete = false; cancel();
		await waitFor(() => expect(view.cancelled).toHaveBeenCalledOnce());
		expect(net.deletes).toHaveLength(2); expect(view.complete).not.toHaveBeenCalled();
		expect(old.cancelled).not.toHaveBeenCalled(); expect(sessionStorage.getItem(`${storageKey()}:cancellation`)).toBeNull();
		net.controls.holdCreate = false; retry(); await waitFor(() => expect(view.complete).toHaveBeenCalledOnce());
		expect(net.createRequests).toHaveLength(2);
		expect(net.createRequests[1]!.clientUploadId).not.toBe(net.createRequests[0]!.clientUploadId);
		expect(net.deletes).toHaveLength(2);
	});
	it('blocks resume and duplicate cancellation during DELETE, delivering the late result only to the reattached view', async () => {
		const { net, chosen, view: old, task } = await pausedSession(); net.controls.holdDelete = true;
		cancel(); await waitFor(() => expect(net.deletes).toHaveLength(1));
		expectResumeBlocked(task);
		expect((screen.getByRole('button', { name: /^취소/ }) as HTMLButtonElement).disabled).toBe(true);
		retry(); cancel(); old.unmount(); const view = mount(kind, chosen);
		expectResumeBlocked(task); expect(net.deletes).toHaveLength(1);
		await act(async () => net.deletes[0]!.response.resolve(new Response(null, { status: 204 })));
		await waitFor(() => expect(view.cancelled).toHaveBeenCalledOnce());
		expect(view.complete).not.toHaveBeenCalled(); expect(old.cancelled).not.toHaveBeenCalled(); expect(net.creates).toHaveLength(1);
	});
	it.each(['READY', 'CANCELLED', 'UPLOADING'] as const)('observes COMPLETING after failed cancellation until %s without resuming transfer', async outcome => {
		const { net, chosen, view: old, task } = await pausedSession();
		net.controls.loseDelete = true; net.creates[0]!.session.state = 'COMPLETING'; cancel();
		await screen.findByText(/서버에서 완료 처리 중/);
		expect(task.beginRun()).toBeNull();
		expect((screen.getByRole('button', { name: /시작|재시도|이어올리기/ }) as HTMLButtonElement).disabled).toBe(true);
		old.unmount(); const view = mount(kind, chosen);
		net.creates[0]!.session.state = outcome;
		if (outcome === 'READY') await waitFor(() => expect(view.complete).toHaveBeenCalledOnce(), { timeout: 2500 });
		else if (outcome === 'CANCELLED') await waitFor(() => expect(view.cancelled).toHaveBeenCalledOnce(), { timeout: 2500 });
		else { await screen.findByText(/취소 결과가 미확정/, {}, { timeout: 2500 }); expectResumeBlocked(task); }
		expect(view.complete).toHaveBeenCalledTimes(outcome === 'READY' ? 1 : 0);
		expect(view.cancelled).toHaveBeenCalledTimes(outcome === 'CANCELLED' ? 1 : 0);
		expect(old.complete).not.toHaveBeenCalled(); expect(old.cancelled).not.toHaveBeenCalled();
		expect(net.deletes).toHaveLength(1); expect(net.completes).toHaveLength(0);
	});
	it.each(['resume', 'cancel'] as const)('blocks a second create across reentry and exposes the late session for %s', async action => {
		const net = network(kind); net.controls.failLookup = true; const chosen = file(); const old = mount(kind, chosen);
		await waitFor(() => expect(net.creates).toHaveLength(1)); old.unmount();
		const view = mount(kind, chosen); await screen.findByRole('button', { name: /시작/ }); retry();
		await act(async () => { await Promise.resolve(); }); expect(net.creates).toHaveLength(1);
		await act(async () => { net.creates[0]!.response.resolve(json(net.creates[0]!.session)); });
		await screen.findByRole('button', { name: '이어올리기' });
		if (action === 'cancel') { cancel(); await waitFor(() => expect(view.cancelled).toHaveBeenCalledOnce()); expect(view.complete).not.toHaveBeenCalled(); }
		else { retry(); await waitFor(() => expect(view.complete).toHaveBeenCalledOnce()); expect(view.cancelled).not.toHaveBeenCalled(); }
		expect(net.creates).toHaveLength(1); expect(old.complete).not.toHaveBeenCalled(); expect(old.cancelled).not.toHaveBeenCalled();
	});
	it('carries cancellation intent through reentry until late create and DELETE both settle', async () => {
		const net = network(kind); net.controls.holdDelete = true; const chosen = file(); const old = mount(kind, chosen);
		await waitFor(() => expect(net.creates).toHaveLength(1)); cancel(); old.unmount();
		const view = mount(kind, chosen); retry(); expect(net.creates).toHaveLength(1);
		await act(async () => net.creates[0]!.response.resolve(json(net.creates[0]!.session)));
		await waitFor(() => expect(net.deletes).toHaveLength(1)); expect(view.cancelled).not.toHaveBeenCalled();
		await act(async () => net.deletes[0]!.response.resolve(new Response(null, { status: 204 })));
		await waitFor(() => expect(view.cancelled).toHaveBeenCalledOnce()); expect(view.complete).not.toHaveBeenCalled();
	});

 it('retains cancellation outcome while no view is attached and delivers it without auto-recreating the job', async () => {
  const net = network(kind); const chosen = file(); const old = mount(kind, chosen);
  await waitFor(() => expect(net.creates).toHaveLength(1)); cancel(); old.unmount();
  await act(async () => net.creates[0]!.response.resolve(json(net.creates[0]!.session)));
  await waitFor(() => expect(net.deletes).toHaveLength(1));
  const view = mount(kind, chosen);
  await waitFor(() => expect(view.cancelled).toHaveBeenCalledOnce());
  await act(async () => { await Promise.resolve(); });
  expect(view.complete).not.toHaveBeenCalled(); expect(old.cancelled).not.toHaveBeenCalled(); expect(net.creates).toHaveLength(1);
 });
	it('finishes cancellation after a persistent pre-creation rejection without replaying the rejected create', async () => {
		const net = network(kind); net.controls.rejectCreate = true; const view = mount(kind, file());
		await screen.findByRole('alert');
		expect(view.cancelled).not.toHaveBeenCalled(); expect(view.complete).not.toHaveBeenCalled();
		cancel(); await waitFor(() => expect(view.cancelled).toHaveBeenCalledOnce());
		cancel(); await act(async () => { await Promise.resolve(); });
		expect(view.cancelled).toHaveBeenCalledOnce();
		expect(net.createRequests).toHaveLength(1); expect(net.deletes).toHaveLength(0);
		expect(sessionStorage.getItem(`${storageKey()}:creation`)).toBeNull();
		view.unmount(); resetDirectUploadTasksForTests(); const reentry = mount(kind);
		await act(async () => { await Promise.resolve(); });
		expect(getDirectUploadTask('9', storageKey()).hasUnresolved()).toBe(false);
		expect(reentry.cancelled).not.toHaveBeenCalled(); expect(reentry.complete).not.toHaveBeenCalled();
		expect(net.createRequests).toHaveLength(1);
	});
	it.each([false, true])('uploads replacement B with a new identity while A remains rejected (reload=%s)', async reload => {
		const net = network(kind); net.controls.rejectName = file().name; net.controls.holdCreate = false;
		const old = mount(kind, file()); await screen.findByRole('alert');
		expect(sessionStorage.getItem(`${storageKey()}:creation`)).toBeNull();
		expect(old.cancelled).not.toHaveBeenCalled();
		old.unmount(); if (reload) resetDirectUploadTasksForTests();
		const replacement = new File(['B'], `small.${kind === 'GAME' ? 'zip' : kind === 'VIDEO' ? 'mp4' : 'png'}`);
		const view = mount(kind, replacement, vi.fn(), vi.fn(), undefined, 'replacement');
		await waitFor(() => expect(view.complete).toHaveBeenCalledOnce());
		expect(net.createRequests).toHaveLength(2);
		expect(net.createRequests[1]!.originalName).toBe(replacement.name);
		expect(net.createRequests[1]!.clientUploadId).not.toBe(net.createRequests[0]!.clientUploadId);
		expect(net.deletes).toHaveLength(0); expect(view.cancelled).not.toHaveBeenCalled();
	});
	it('uses a fresh identity for every explicit retry while the server keeps rejecting', async () => {
		const net = network(kind); net.controls.rejectCreate = true; const view = mount(kind, file());
		await screen.findByRole('alert'); retry(); await waitFor(() => expect(net.createRequests).toHaveLength(2));
		await screen.findByRole('alert');
		expect(net.createRequests[1]!.clientUploadId).not.toBe(net.createRequests[0]!.clientUploadId);
		expect(sessionStorage.getItem(`${storageKey()}:creation`)).toBeNull();
		expect(view.cancelled).not.toHaveBeenCalled(); expect(view.complete).not.toHaveBeenCalled();
	});
	it('lets the actual file picker replace a persistently rejected A with B', async () => {
		const net = network(kind); net.controls.rejectName = file().name; net.controls.holdCreate = false;
		const completed = vi.fn(); const cancelled = vi.fn(); const props = { onComplete: completed, onCancelled: cancelled };
		render(<QueryClientProvider client={client()}>{kind === 'GAME' ? <GameUploadWidget {...props} projectId={7} />
			: kind === 'VIDEO' ? <DirectVideoUploadWidget {...props} projectId={7} />
			: <DirectImageUploadWidget {...props} owner={{ type: 'PROJECT', id: 7 }} kind="IMAGE" />}</QueryClientProvider>);
		fireEvent.change(await screen.findByLabelText(/파일 선택/), { target: { files: [file()] } }); retry();
		await screen.findByRole('alert'); expect(cancelled).not.toHaveBeenCalled();
		const replacement = new File(['B'], `small.${kind === 'GAME' ? 'zip' : kind === 'VIDEO' ? 'mp4' : 'png'}`);
		fireEvent.change(screen.getByLabelText(/파일 선택/), { target: { files: [replacement] } }); retry();
		await waitFor(() => expect(completed).toHaveBeenCalledOnce());
		expect(net.createRequests).toHaveLength(2); expect(net.createRequests[1]!.originalName).toBe(replacement.name);
		expect(net.createRequests[1]!.clientUploadId).not.toBe(net.createRequests[0]!.clientUploadId);
		expect(cancelled).not.toHaveBeenCalled(); expect(net.deletes).toHaveLength(0);
	});
	it.each(['reentry', 'cancel'] as const)('settles a late first-attempt rejection across %s without replay or a false completion', async action => {
		const net = network(kind); net.controls.rejectCreate = true; net.controls.holdRejection = true;
		const chosen = file(); const old = mount(kind, chosen, vi.fn(), vi.fn(), undefined, 'first');
		await waitFor(() => expect(net.rejections).toHaveLength(1));
		if (action === 'cancel') {
			cancel(); await waitFor(() => expect(net.fetcher.mock.calls.some(([url]) => String(url).includes('/direct-asset-upload-creations/'))).toBe(true));
		}
		old.unmount(); const view = mount(kind, chosen, vi.fn(), vi.fn(), undefined, 'first');
		await act(async () => net.rejections[0]!.response.resolve(net.rejections[0]!.rejection));
		expect(sessionStorage.getItem(`${storageKey()}:creation`)).toBeNull();
		expect(net.createRequests).toHaveLength(1); expect(view.complete).not.toHaveBeenCalled();
		expect(view.cancelled).toHaveBeenCalledTimes(action === 'cancel' ? 1 : 0);
		expect(old.cancelled).not.toHaveBeenCalled(); expect(old.complete).not.toHaveBeenCalled();
	});
	it.each(['ERROR', 'CONFLICT', 'IDEMPOTENCY_CONFLICT', 'OPERATION_IN_PROGRESS'] as const)('preserves an earlier lost creation after NOT_OBSERVED and a later %s', async code => {
		const net = network(kind); net.controls.loseCreate = true; net.controls.failLookup = true; net.controls.hideCreation = true;
		const chosen = file(); const old = mount(kind, chosen); await screen.findByRole('alert');
		const request = net.createRequests[0]!;
		net.controls.failLookup = false; net.controls.rejectCreate = true; net.controls.rejectCode = code;
		retry(); await waitFor(() => expect(net.createRequests).toHaveLength(2));
		await screen.findByRole('alert');
		expect(net.createRequests[1]).toEqual(request);
		expect(sessionStorage.getItem(`${storageKey()}:creation`)).toContain(request.clientUploadId);
		expect(getDirectUploadTask('9', storageKey()).hasUnresolved()).toBe(true);
		cancel(); await screen.findByRole('alert');
		expect(old.cancelled).not.toHaveBeenCalled(); expect(old.complete).not.toHaveBeenCalled();
		expect(sessionStorage.getItem(`${storageKey()}:creation`)).toContain(request.clientUploadId);
		old.unmount(); resetDirectUploadTasksForTests();
		const replacement = new File(['B'], `small.${kind === 'GAME' ? 'zip' : kind === 'VIDEO' ? 'mp4' : 'png'}`);
		const next = mount(kind, replacement, vi.fn(), vi.fn(), undefined, 'replacement');
		await screen.findByRole('alert'); retry(); await act(async () => { await Promise.resolve(); });
		expect(net.createRequests.every(value => value.clientUploadId === request.clientUploadId)).toBe(true);
		expect(next.complete).not.toHaveBeenCalled(); expect(next.cancelled).not.toHaveBeenCalled();
		expect(sessionStorage.getItem(`${storageKey()}:creation`)).toContain(request.clientUploadId);
		if (code === 'IDEMPOTENCY_CONFLICT') expect(JSON.parse(sessionStorage.getItem(`${storageKey()}:creation`)!)).toMatchObject({ conflict: true });
	});
	it.each(['resume', 'cancel'] as const)('recovers a lost published-project create response and actually completes %s', async action => {
		const net = network(kind); net.controls.loseCreate = true; net.controls.failLookup = true;
		const chosen = file(); const old = mount(kind, chosen);
		await screen.findByRole('alert'); old.unmount(); const view = mount(kind, chosen);
		await screen.findByRole('alert'); net.controls.failLookup = false;
		if (action === 'cancel') { cancel(); await waitFor(() => expect(view.cancelled).toHaveBeenCalledOnce()); expect(net.deletes).toHaveLength(1); expect(view.complete).not.toHaveBeenCalled(); }
		else { retry(); await waitFor(() => expect(view.complete).toHaveBeenCalledOnce()); expect(net.completes).toHaveLength(1); expect(view.cancelled).not.toHaveBeenCalled(); }
		expect(net.creates).toHaveLength(1);
	});
	it('retries a request that never reached the server with the persisted identity and finishes uploading', async () => {
		const net = network(kind); net.controls.missCreate = true; net.controls.holdCreate = false;
		const view = mount(kind, file()); await screen.findByRole('alert');
		await waitFor(() => expect(net.createRequests).toHaveLength(1));
		const request = net.createRequests[0]!;
		expect(net.dispatchedRecords[0]).toMatchObject({ request });
		const key = kind === 'GAME' ? 'pcu.direct-asset-upload:7:GAME' : kind === 'IMAGE' ? 'pcu.direct-image-upload:PROJECT:7' : 'pcu.direct-video-upload:7';
		expect(JSON.parse(sessionStorage.getItem(`${key}:creation`)!)).toMatchObject({ request: { clientUploadId: request.clientUploadId } });
		expect(view.cancelled).not.toHaveBeenCalled();
		net.controls.missCreate = false; retry();
		await waitFor(() => expect(view.complete).toHaveBeenCalledOnce());
		expect(net.createRequests).toHaveLength(2); expect(net.createRequests[1]).toEqual(request);
		expect(net.completes).toHaveLength(1); expect(sessionStorage.getItem(`${key}:creation`)).toBeNull();
	});
	it('recovers a delayed in-flight create on retry and fences its response from the next operation', async () => {
		const net = network(kind); const chosen = file(); const first = mount(kind, chosen, vi.fn(), vi.fn(), undefined, 'first');
		await waitFor(() => expect(net.creates).toHaveLength(1));
		fireEvent.click(screen.getByRole('button', { name: '일시 정지' }));
		net.creates[0]!.session.state = 'ALLOCATING'; retry(); await screen.findByRole('alert');
		expect(net.createRequests).toHaveLength(1); expect(first.complete).not.toHaveBeenCalled();
		net.creates[0]!.session.state = 'UPLOADING'; retry();
		await waitFor(() => expect(first.complete).toHaveBeenCalledOnce()); expect(net.completes).toHaveLength(1);
		first.unmount(); const next = mount(kind, chosen, vi.fn(), vi.fn(), undefined, 'next');
		await waitFor(() => expect(net.creates).toHaveLength(2));
		await act(async () => net.creates[0]!.response.resolve(json(net.creates[0]!.session)));
		expect(next.complete).not.toHaveBeenCalled(); expect(next.cancelled).not.toHaveBeenCalled();
		expect(first.complete).toHaveBeenCalledOnce();
		await act(async () => net.creates[1]!.response.resolve(json(net.creates[1]!.session)));
		await waitFor(() => expect(next.complete).toHaveBeenCalledOnce());
		expect(net.createRequests[0]!.clientUploadId).not.toBe(net.createRequests[1]!.clientUploadId);
	});

	it('does not let a mismatched-file retry redefine the source of an unresolved creation', async () => {
		const net = network(kind); net.controls.loseCreate = true; net.controls.hideCreation = true;
		const chosen = file(); const old = mount(kind, chosen); await screen.findByRole('alert'); old.unmount();
		const replacement = new File(['diff-file'], chosen.name); expect(replacement.size).toBe(chosen.size);
		const view = mount(kind, replacement);
		await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('선택한 파일이 다릅니다'));
		expect(net.createRequests).toHaveLength(1);
		net.controls.hideCreation = false; net.creates[0]!.session.state = 'READY'; retry();
		const key = kind === 'GAME' ? 'pcu.direct-asset-upload:7:GAME' : kind === 'IMAGE' ? 'pcu.direct-image-upload:PROJECT:7' : 'pcu.direct-video-upload:7';
		await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('원본과 일치'));
		expect(sessionStorage.getItem(`${key}:creation`)).toContain(net.createRequests[0]!.clientUploadId);
		expect(view.complete).not.toHaveBeenCalled(); expect(view.cancelled).not.toHaveBeenCalled();
	});

	it('preserves a confirmed failed operation until an explicit new upload gets a fresh identity', async () => {
		const net = network(kind); net.controls.loseCreate = true; net.controls.failLookup = true;
		const view = mount(kind, file()); await screen.findByRole('alert');
		net.creates[0]!.session.state = 'REJECTED'; net.controls.failLookup = false; retry();
		const startNew = await screen.findByRole('button', { name: '새 업로드 시작' });
		expect(net.createRequests).toHaveLength(1); expect(view.complete).not.toHaveBeenCalled();
		net.controls.loseCreate = false; net.controls.holdCreate = false; fireEvent.click(startNew);
		await waitFor(() => expect(view.complete).toHaveBeenCalledOnce());
		expect(net.createRequests).toHaveLength(2);
		expect(net.createRequests[1]!.clientUploadId).not.toBe(net.createRequests[0]!.clientUploadId);
	});

	it('returns from ALLOCATING to an explicit retry and resumes once the server confirms the session', async () => {
		const net = network(kind); net.controls.holdCreate = false; net.controls.allocating = true;
		const view = mount(kind, file()); await screen.findByRole('alert');
		retry(); await act(async () => { await Promise.resolve(); });
		expect(view.complete).not.toHaveBeenCalled(); expect(net.completes).toHaveLength(0);
		expect(net.createRequests).toHaveLength(1);
		net.creates[0]!.session.state = 'UPLOADING'; retry();
		await waitFor(() => expect(view.complete).toHaveBeenCalledOnce()); expect(net.completes).toHaveLength(1);
		expect(net.createRequests).toHaveLength(1);
	});
	it.each(['resume', 'cancel'] as const)('restores only the durable pre-create record after memory loss and completes %s', async action => {
		const net = network(kind); net.controls.loseCreate = true; net.controls.failLookup = true;
		const chosen = file(); const old = mount(kind, chosen, vi.fn(), vi.fn(), undefined, 'published-change');
		await screen.findByRole('alert'); old.unmount(); resetDirectUploadTasksForTests();
		net.controls.failLookup = false;
		const view = mount(kind, action === 'resume' ? chosen : undefined, vi.fn(), vi.fn(), undefined, 'published-change');
		if (action === 'resume') await waitFor(() => expect(view.complete).toHaveBeenCalledOnce());
		else { await screen.findByRole('button', { name: /^취소/ }); cancel(); await waitFor(() => expect(view.cancelled).toHaveBeenCalledOnce()); expect(net.deletes).toHaveLength(1); }
		expect(net.creates).toHaveLength(1); expect(old.complete).not.toHaveBeenCalled();
	});
	it('cancels an unobserved create using its original request without requiring the original File', async () => {
		const net = network(kind); net.controls.missCreate = true; net.controls.holdCreate = false;
		const old = mount(kind, file()); await screen.findByRole('alert');
		const request = net.createRequests[0]!;
		old.unmount(); resetDirectUploadTasksForTests();
		const view = mount(kind); await screen.findByRole('button', { name: /^취소/ });
		cancel(); await screen.findByRole('alert'); expect(view.cancelled).not.toHaveBeenCalled();
		net.controls.missCreate = false; cancel();
		await waitFor(() => expect(view.cancelled).toHaveBeenCalledOnce());
		expect(net.createRequests.every(value => value.clientUploadId === request.clientUploadId)).toBe(true);
		expect(net.creates).toHaveLength(1); expect(net.deletes).toHaveLength(1); expect(view.complete).not.toHaveBeenCalled();
	});
	it('stops before POST when the pre-create recovery record cannot be stored', async () => {
		const net = network(kind); net.controls.holdCreate = false;
		const original = Storage.prototype.setItem;
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
			if (key.endsWith(':creation')) throw new DOMException('Quota exceeded', 'QuotaExceededError');
			return original.call(this, key, value);
		});
		const view = mount(kind, file()); await screen.findByRole('alert');
		expect(net.createRequests).toHaveLength(0); expect(view.complete).not.toHaveBeenCalled();
	});

	it('retains unsupported legacy records without claiming cancellation or creating a replacement', async () => {
		const key = kind === 'GAME' ? 'pcu.direct-asset-upload:7:GAME' : kind === 'IMAGE' ? 'pcu.direct-image-upload:PROJECT:7' : 'pcu.direct-video-upload:7';
		const raw = JSON.stringify({ uncertain: true, originalName: file().name }); sessionStorage.setItem(key, raw);
		const net = network(kind); const view = mount(kind, file()); await screen.findByRole('alert');
		cancel(); retry(); await act(async () => { await Promise.resolve(); });
		expect(sessionStorage.getItem(key)).toBe(raw); expect(net.createRequests).toHaveLength(0);
		expect(view.cancelled).not.toHaveBeenCalled(); expect(view.complete).not.toHaveBeenCalled();
	});

	it('recovers an ambiguous create from its server submission binding', async () => {
		const net = network(kind); net.controls.loseCreate = true; const view = mount(kind, file(), vi.fn(), vi.fn(), { ...binding, state: 'EXPECTED' });
		await waitFor(() => expect(net.creates).toHaveLength(1)); await screen.findByRole('button', { name: '이어올리기' });
		retry(); await waitFor(() => expect(view.complete).toHaveBeenCalledOnce()); expect(net.creates).toHaveLength(1);
	});
	it('recovers a linked server session with no local locator', async () => {
		const net = network(kind); const chosen = file(); const session = await net.seed(chosen);
		const view = mount(kind, chosen, vi.fn(), vi.fn(), { ...binding, sessionId: session.sessionId, generation: 1, state: 'UPLOADING' });
		await waitFor(() => expect(view.complete).toHaveBeenCalledOnce()); expect(net.creates).toHaveLength(0);
	});
	it('retains recovery responsibility when a linked session status is unavailable', async () => {
		const net = network(kind); const chosen = file(); const session = await net.seed(chosen); net.controls.failStatus = true;
		const view = mount(kind, chosen, vi.fn(), vi.fn(), { ...binding, sessionId: session.sessionId, generation: 1, state: 'UPLOADING' });
		await screen.findByRole('alert'); expect(net.creates).toHaveLength(0); expect(view.complete).not.toHaveBeenCalled();
		net.controls.failStatus = false; retry(); await waitFor(() => expect(view.complete).toHaveBeenCalledOnce()); expect(net.creates).toHaveLength(0);
	});
	it.each(['token', 'file', 'generation', 'owner'] as const)('does not recover a mismatching %s', async mismatch => {
		const net = network(kind); const chosen = file(); const session = await net.seed(chosen);
		if (mismatch === 'token') net.controls.wrongToken = true;
		if (mismatch === 'file') session.originalName = 'different-file';
		if (mismatch === 'generation') session.generation = 2;
		if (mismatch === 'owner') session.owner = { type: 'PROJECT', id: 99 };
		const item = mismatch === 'token' ? binding : { ...binding, sessionId: session.sessionId, generation: 1, state: 'UPLOADING' };
		const view = mount(kind, chosen, vi.fn(), vi.fn(), item);
		await screen.findByRole('alert'); expect(net.creates).toHaveLength(0); expect(view.complete).not.toHaveBeenCalled(); expect(view.cancelled).not.toHaveBeenCalled();
	});
	it('converges cancel versus READY to one completion after reentry', async () => {
		const net = network(kind); net.controls.failLookup = true; const chosen = file(); const old = mount(kind, chosen);
		await waitFor(() => expect(net.creates).toHaveLength(1)); old.unmount(); const view = mount(kind, chosen);
		await screen.findByRole('button', { name: /시작/ }); cancel(); net.controls.cancelConflict = true; net.creates[0]!.session.state = 'READY';
		await act(async () => net.creates[0]!.response.resolve(json(net.creates[0]!.session)));
		await waitFor(() => expect(view.complete).toHaveBeenCalledOnce()); expect(view.cancelled).not.toHaveBeenCalled(); expect(net.creates).toHaveLength(1);
	});

	it('keeps a lost allocation recoverable through failed status and later cancellation', async () => {
		const net = network(kind); net.controls.loseCreate = true; net.controls.failStatus = true;
		const view = mount(kind, file(), vi.fn(), vi.fn(), { ...binding, state: 'EXPECTED' });
		await screen.findByRole('alert');
		await waitFor(() => expect(net.fetcher.mock.calls.some(([url]) => String(url).includes('/direct-asset-upload-creations/'))).toBe(true));
		cancel(); await act(async () => { await Promise.resolve(); });
		expect(view.cancelled).not.toHaveBeenCalled(); expect(view.complete).not.toHaveBeenCalled(); expect(net.creates).toHaveLength(1);
		net.controls.failStatus = false; cancel();
		await waitFor(() => expect(view.cancelled).toHaveBeenCalledOnce()); expect(net.creates).toHaveLength(1);
	});
	it('does not complete a different same-name and same-size file on a late READY', async () => {
		const net = network(kind); const chosen = file(); const old = mount(kind, chosen);
		await waitFor(() => expect(net.creates).toHaveLength(1)); old.unmount();
		const replacement = new File(['diff-file'], chosen.name); expect(replacement.size).toBe(chosen.size);
		const view = mount(kind, replacement); await screen.findByRole('button', { name: /시작/ });
		net.creates[0]!.session.state = 'READY';
		await act(async () => net.creates[0]!.response.resolve(json(net.creates[0]!.session)));
		await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('원본과 일치'));
		expect(sessionStorage.getItem(storageKey())).toContain(net.creates[0]!.session.sessionId);
		expect(view.complete).not.toHaveBeenCalled(); expect(view.cancelled).not.toHaveBeenCalled();
	});
	it('does not deliver the previous queue item completion to a new item with the same file', async () => {
		const net = network(kind); const chosen = file(); const old = mount(kind, chosen, vi.fn(), vi.fn(), undefined, 'queue:item-1');
		await waitFor(() => expect(net.creates).toHaveLength(1)); old.unmount();
		const view = mount(kind, chosen, vi.fn(), vi.fn(), undefined, 'queue:item-2');
		await screen.findByRole('button', { name: /시작/ }); net.creates[0]!.session.state = 'READY';
		await act(async () => net.creates[0]!.response.resolve(json(net.creates[0]!.session)));
		await screen.findByRole('alert'); expect(view.complete).not.toHaveBeenCalled(); expect(net.creates).toHaveLength(1);
		net.controls.holdCreate = false; retry();
		await waitFor(() => expect(view.complete).toHaveBeenCalledOnce()); expect(net.creates).toHaveLength(2);
	});
	it('fences a late old complete response while the next job owns the record and UI', async () => {
		const net = network(kind); net.controls.holdCreate = false; net.controls.holdComplete = true; const view = mount(kind, file());
		await waitFor(() => expect(net.completes).toHaveLength(1)); cancel(); await waitFor(() => expect(view.cancelled).toHaveBeenCalledOnce());
		retry(); await waitFor(() => expect(net.completes).toHaveLength(2));
		await act(async () => net.completes[0]!.response.resolve(json({ status: 'READY', sessionId: 'session-1', generation: 1, sizeBytes: 9 })));
		expect(view.complete).not.toHaveBeenCalled(); expect(sessionStorage.getItem(kind === 'GAME' ? 'pcu.direct-asset-upload:7:GAME' : kind === 'IMAGE' ? 'pcu.direct-image-upload:PROJECT:7' : 'pcu.direct-video-upload:7')).toContain('session-2');
		await act(async () => net.completes[1]!.response.resolve(json({ status: 'READY', sessionId: 'session-2', generation: 1, sizeBytes: 9 })));
		await waitFor(() => expect(view.complete).toHaveBeenCalledOnce()); expect(view.cancelled).toHaveBeenCalledOnce();
	});
});

it('blocks voting poster retry and file selection while cancellation is unconfirmed', async () => {
	const net = network('POSTER', { type: 'EXHIBITION', id: 7 });
	net.controls.holdCreate = false; net.controls.holdComplete = true;
	const ready = vi.fn();
	render(<QueryClientProvider client={client()}><VotePosterUpload voteId="vote" exhibitionId={7} onReady={ready} /></QueryClientProvider>);
	const input = screen.getByLabelText('투표 전용 포스터 업로드') as HTMLInputElement;
	fireEvent.change(input, { target: { files: [new File(['poster'], 'poster.png')] } });
	await waitFor(() => expect(net.completes).toHaveLength(1));
	net.controls.loseDelete = true; cancel();
	await screen.findByText(/취소 결과가 미확정/);
	expect(input.disabled).toBe(true);
	expect((screen.getByRole('button', { name: '재시도' }) as HTMLButtonElement).disabled).toBe(true);
	fireEvent.click(screen.getByRole('button', { name: '재시도' }));
	expect(net.deletes).toHaveLength(1); expect(net.creates).toHaveLength(1); expect(ready).not.toHaveBeenCalled();
	net.controls.loseDelete = false; cancel();
	await screen.findByText('업로드가 취소되었습니다.'); expect(input.disabled).toBe(false);
	await act(async () => net.completes[0]!.response.resolve(json({ status: 'READY', sessionId: 'session-1', generation: 1, sizeBytes: 6 })));
	expect(ready).not.toHaveBeenCalled(); expect(net.deletes).toHaveLength(2);
});

it('uses the user submission endpoint to recover a lost user create', async () => {
 const net = network('GAME'); net.controls.loseCreate = true;
 const view = mount('GAME', new File(['game'], 'game.zip'), vi.fn(), vi.fn(), { ...binding, state: 'EXPECTED' }, undefined, 'USER');
 await screen.findByRole('button', { name: '이어올리기' }); retry();
 await waitFor(() => expect(view.complete).toHaveBeenCalledOnce()); expect(net.creates).toHaveLength(1);
 expect(net.fetcher.mock.calls.some(([url]) => String(url).includes('/direct-asset-upload-creations/'))).toBe(true);
 expect(net.fetcher.mock.calls.some(([url]) => String(url).endsWith('/api/admin/projects/7/submission'))).toBe(false);
});

it.each(['IMAGE', 'VIDEO'] as const)('restores the persisted %s queue position after the second create response is lost', async kind => {
	const net = network(kind); net.controls.holdCreate = false; net.controls.failLookup = true;
	const transport = net.fetcher.getMockImplementation()!;
	net.fetcher.mockImplementation(async (url, init) => {
		const response = await transport(url, init);
		if (String(url).endsWith('/complete') && net.completes.length === 1) net.controls.loseCreate = true;
		return response;
	});
	const chosen = [new File(['first'], kind === 'IMAGE' ? 'first.png' : 'first.mp4'), new File(['second'], kind === 'IMAGE' ? 'second.png' : 'second.mp4')];
	const complete = vi.fn();
	const element = () => <QueryClientProvider client={client()}>{kind === 'IMAGE'
		? <DirectImageUploadWidget owner={{ type: 'PROJECT', id: 7 }} kind="IMAGE" initialFiles={chosen} autoStart onComplete={complete} />
		: <DirectVideoUploadWidget projectId={7} initialFiles={chosen} autoStart onComplete={complete} />}</QueryClientProvider>;
	const old = render(element()); await waitFor(() => expect(net.creates).toHaveLength(2)); await screen.findByRole('alert');
	expect(net.completes).toHaveLength(1);
	old.unmount(); resetDirectUploadTasksForTests(); net.controls.failLookup = false;
	render(element()); await waitFor(() => expect(complete).toHaveBeenCalledOnce());
	expect(net.creates).toHaveLength(2); expect(net.completes).toHaveLength(2);
	expect(net.completes.map(value => value.id)).toEqual(['session-1', 'session-2']);
});

it.each(['resume', 'cancel'] as const)('recovers voting poster creation through the shared task and completes %s', async action => {
	const net = network('POSTER', { type: 'EXHIBITION', id: 3 }); net.controls.loseCreate = true; net.controls.failLookup = true;
	const onReady = vi.fn();
	const view = render(<QueryClientProvider client={client()}><VotePosterUpload voteId="vote-1" exhibitionId={3} onReady={onReady} /></QueryClientProvider>);
	fireEvent.change(screen.getByLabelText('투표 전용 포스터 업로드'), { target: { files: [new File(['poster'], 'poster.png', { type: 'image/png' })] } });
	await screen.findByRole('alert'); net.controls.failLookup = false;
	if (action === 'resume') { fireEvent.click(screen.getByRole('button', { name: '재시도' })); await waitFor(() => expect(onReady).toHaveBeenCalledOnce()); expect(net.completes).toHaveLength(1); }
	else { view.unmount(); resetDirectUploadTasksForTests();
		render(<QueryClientProvider client={client()}><VotePosterUpload voteId="vote-1" exhibitionId={3} onReady={onReady} /></QueryClientProvider>);
		fireEvent.click(await screen.findByRole('button', { name: '취소' })); await waitFor(() => expect(net.deletes).toHaveLength(1));
		await waitFor(() => expect(sessionStorage.getItem('pcu.vote-poster:vote-1:creation')).toBeNull()); expect(onReady).not.toHaveBeenCalled();
	}
	expect(net.creates).toHaveLength(1);
});

const project: AdminProjectDetail = { id: 7, title: 'Project', slug: 'project', year: 2026, platforms: [], isIncomplete: false, video: null, videos: [], status: 'PUBLISHED', sortOrder: 0, members: [], assets: [], visibility: 'PUBLIC', exhibitionVisibility: 'PUBLIC', canChangeVisibility: false };
function QueueControls() {
	const queue = useAdminProjectUploadQueue(); const [visible, setVisible] = useState(true);
	return <><button onClick={() => void queue.applyChanges().catch(() => undefined)}>적용</button>
		<button onClick={() => setVisible(value => !value)}>화면 전환</button>
		<output data-testid="queue">{queue.entries.map(entry => `${entry.file.name}:${entry.status}`).join(',')}</output>
		{visible && <AdminProjectUploadProgress />}</>;
}
it('keeps the real parent queue on B when a rejected A cancellation lookup arrives late', async () => {
	const net = network('IMAGE'); net.controls.rejectName = 'first.png'; net.controls.holdRejection = true;
	net.controls.holdLookup = true; net.controls.holdCreate = false; net.controls.holdComplete = true;
	render(<QueryClientProvider client={client()}><AdminProjectUploadProvider project={project} projectId={7} limits={getClientUploadLimits('ADMIN')} canEditContent>
		<AdminProjectAssetManager canEditContent /><QueueControls />
	</AdminProjectUploadProvider></QueryClientProvider>);
	fireEvent.drop(screen.getByRole('button', { name: '게임·미디어·자료 선택' }).parentElement!, { dataTransfer: { files: [new File(['first'], 'first.png', { type: 'image/png' }), new File(['B'], 'second.png', { type: 'image/png' })], types: ['Files'] } });
	fireEvent.click(screen.getByRole('button', { name: '적용' })); await waitFor(() => expect(net.rejections).toHaveLength(1));
	const list = await screen.findByRole('list', { name: '변경 파일 업로드 진행' });
	fireEvent.click(within(list).getByRole('button', { name: '취소' }));
	await waitFor(() => expect(net.lookups).toHaveLength(1));
	fireEvent.click(screen.getByRole('button', { name: '화면 전환' }));
	await act(async () => net.rejections[0]!.response.resolve(net.rejections[0]!.rejection));
	fireEvent.click(screen.getByRole('button', { name: '화면 전환' }));
	await waitFor(() => expect(screen.getByTestId('queue').textContent).toBe('first.png:cancelled,second.png:pending'));
	fireEvent.click(screen.getByRole('button', { name: '적용' })); await waitFor(() => expect(net.completes).toHaveLength(1));
	await act(async () => net.lookups[0]!.resolve(json({}, 503)));
	expect(screen.getByTestId('queue').textContent).toBe('first.png:cancelled,second.png:active');
	expect(net.createRequests).toHaveLength(2); expect(net.createRequests[1]!.originalName).toBe('second.png');
	expect(net.createRequests[1]!.clientUploadId).not.toBe(net.createRequests[0]!.clientUploadId);
	await act(async () => net.completes[0]!.response.resolve(json({ status: 'READY', sessionId: net.completes[0]!.id, generation: 1, sizeBytes: 1 })));
	await waitFor(() => expect(screen.getByTestId('queue').textContent).toBe('first.png:cancelled,second.png:done'));
	expect(net.createRequests).toHaveLength(2); expect(net.deletes).toHaveLength(0);
});

it.each(['READY', 'CANCELLED'] as const)('real parent queue reconciles %s once across a pending-create view handoff', async outcome => {
	const net = network('IMAGE'); net.controls.failLookup = true;
	render(<QueryClientProvider client={client()}><AdminProjectUploadProvider project={project} projectId={7} limits={getClientUploadLimits('ADMIN')} canEditContent>
		<AdminProjectAssetManager canEditContent /><QueueControls />
	</AdminProjectUploadProvider></QueryClientProvider>);
	fireEvent.drop(screen.getByRole('button', { name: '게임·미디어·자료 선택' }).parentElement!, { dataTransfer: { files: [new File(['first'], 'first.png', { type: 'image/png' }), new File(['second'], 'second.png', { type: 'image/png' })], types: ['Files'] } });
	fireEvent.click(screen.getByRole('button', { name: '적용' })); await waitFor(() => expect(net.creates).toHaveLength(1));
	fireEvent.click(screen.getByRole('button', { name: '화면 전환' })); fireEvent.click(screen.getByRole('button', { name: '화면 전환' }));
	const list = await screen.findByRole('list', { name: '변경 파일 업로드 진행' });
	fireEvent.click(within(list).getByRole('button', { name: '취소' }));
	expect(net.creates).toHaveLength(1); net.controls.cancelConflict = outcome === 'READY'; net.creates[0]!.session.state = outcome;
	await act(async () => net.creates[0]!.response.resolve(json(net.creates[0]!.session)));
	if (outcome === 'READY') {
		await waitFor(() => expect(net.creates).toHaveLength(2)); expect(screen.getByTestId('queue').textContent).toBe('first.png:done,second.png:active');
		expect(net.creates[1]!.session.originalName).toBe('second.png');
	} else {
		await waitFor(() => expect(screen.getByTestId('queue').textContent).toBe('first.png:cancelled,second.png:pending'));
		expect(net.creates).toHaveLength(1);
	}
	expect(net.deletes).toHaveLength(1);
});

describe.each(['IMAGE', 'VIDEO'] as const)('%s saved-only file verification', kind => {
	const storageKey = () => kind === 'IMAGE' ? 'pcu.direct-image-upload:PROJECT:7' : 'pcu.direct-video-upload:7';
	const file = (contents = 'same-file') => new File([contents], kind === 'IMAGE' ? 'cover.png' : 'video.mp4');
	async function storedSession(state: DirectAssetUploadStatus['state'] = 'READY', legacy = false) {
		const net = network(kind);
		const original = file();
		const session = await net.seed(original, state);
		const saved = { session: { ...session }, originalName: original.name, totalBytes: original.size, completed: 0 };
		if (legacy) { Reflect.deleteProperty(saved.session, 'sourceIdentity'); Reflect.deleteProperty(saved.session, 'sourceIdentityAlgorithm'); }
		// No transfer or task has ever held the original File. Only JSON survives reload.
		sessionStorage.setItem(storageKey(), JSON.stringify(saved));
		resetDirectUploadTasksForTests();
		return { net, original, session };
	}
	it('hashes a restored selection and rejects different bytes despite identical name and size and READY', async () => {
		const { net, original } = await storedSession();
		const selected = file('diff-file');
		expect(selected.name).toBe(original.name); expect(selected.size).toBe(original.size);
		const identity = vi.spyOn(fileIdentity, 'createFileSourceIdentity');
		const task = getDirectUploadTask('9', storageKey());
		const matches = vi.spyOn(task, 'matchesFile');
		const view = mount(kind, selected);
		await waitFor(() => expect(matches).toHaveBeenCalledWith(selected));
		await act(async () => { await Promise.all(matches.mock.results.map(result => result.value)); });
		expect(identity).toHaveBeenCalledWith(selected);
		for (const result of matches.mock.results) expect(await result.value).toBe(false);
		expect(view.complete).not.toHaveBeenCalled(); expect(view.cancelled).not.toHaveBeenCalled();
		expect(sessionStorage.getItem(storageKey())).toContain('recovered');
		expect(net.creates).toHaveLength(0); expect(net.completes).toHaveLength(0);
	});
	it('accepts a new File with matching content from a stored READY session without another upload', async () => {
		const { net, original } = await storedSession();
		const selected = file(); expect(selected).not.toBe(original);
		const identity = vi.spyOn(fileIdentity, 'createFileSourceIdentity');
		const view = mount(kind, selected);
		await waitFor(() => expect(view.complete).toHaveBeenCalledOnce());
		expect(identity).toHaveBeenCalledWith(selected);
		expect(sessionStorage.getItem(storageKey())).toBeNull();
		expect(net.creates).toHaveLength(0); expect(net.completes).toHaveLength(0);
	});
	it.each(['READY', 'UPLOADING'] as const)('preserves a legacy %s locator until its server outcome is reconciled', async state => {
		const { net } = await storedSession(state, true);
		const view = mount(kind, file('diff-file'));
		await screen.findByRole('alert');
		expect(view.complete).not.toHaveBeenCalled(); expect(sessionStorage.getItem(storageKey())).toContain('recovered');
		if (state === 'UPLOADING') {
			cancel(); await waitFor(() => expect(view.cancelled).toHaveBeenCalledOnce());
			expect(net.deletes).toHaveLength(1); expect(net.sessions.get('recovered')?.state).toBe('CANCELLED');
			expect(sessionStorage.getItem(storageKey())).toBeNull();
		} else {
			// Production refuses cancellation of READY. Do not simulate a successful
			// DELETE here or silently remove the only original-result locator.
			net.controls.cancelConflict = true;
			const task = getDirectUploadTask('9', storageKey());
			const matches = vi.spyOn(task, 'matchesFile');
			cancel(); await waitFor(() => expect(matches).toHaveBeenCalled());
			await act(async () => { await Promise.all(matches.mock.results.map(result => result.value)); });
			expect(net.deletes).toHaveLength(1); expect(sessionStorage.getItem(storageKey())).toContain('recovered');
			expect(view.complete).not.toHaveBeenCalled(); expect(view.cancelled).not.toHaveBeenCalled();
			view.unmount(); resetDirectUploadTasksForTests();
			const originalResult = mount(kind);
			await waitFor(() => expect(originalResult.complete).toHaveBeenCalledOnce());
			expect(sessionStorage.getItem(storageKey())).toBeNull();
		}
		expect(net.creates).toHaveLength(0);
	});

	it('resumes a legacy UPLOADING locator only after the real client verifies the server source identity', async () => {
		const { net } = await storedSession('UPLOADING', true);
		const selected = file();
		const identity = vi.spyOn(fileIdentity, 'createFileSourceIdentity');
		const view = mount(kind, selected);
		await waitFor(() => expect(view.complete).toHaveBeenCalledOnce());
		expect(identity).toHaveBeenCalledWith(selected, { signal: expect.any(AbortSignal) });
		expect(net.creates).toHaveLength(0); expect(net.completes).toHaveLength(1);
		expect(sessionStorage.getItem(storageKey())).toBeNull();
	});
	it.each([false, true])('recovers the original READY result without reselecting a file (legacy=%s)', async legacy => {
		const { net } = await storedSession('READY', legacy);
		const identity = vi.spyOn(fileIdentity, 'createFileSourceIdentity');
		const view = mount(kind);
		await waitFor(() => expect(view.complete).toHaveBeenCalledOnce());
		expect(identity).not.toHaveBeenCalled(); expect(sessionStorage.getItem(storageKey())).toBeNull();
		expect(net.creates).toHaveLength(0); expect(net.completes).toHaveLength(0);
	});
	it('preserves a READY locator when the selected file cannot be read for identity verification', async () => {
		const { net } = await storedSession();
		vi.spyOn(Blob.prototype, 'arrayBuffer').mockRejectedValue(new Error('file read failed'));
		const view = mount(kind, file());
		await screen.findByRole('button', { name: /이어올리기|재시도/ });
		expect(view.complete).not.toHaveBeenCalled(); expect(sessionStorage.getItem(storageKey())).toContain('recovered');
		expect(net.creates).toHaveLength(0); expect(net.completes).toHaveLength(0);
	});
	it.each([false, true])('verifies selected contents when restored VERIFYING converges to READY (matching=%s)', async matching => {
		const { net, session } = await storedSession('VERIFYING');
		const transport = net.fetcher.getMockImplementation()!;
		net.fetcher.mockImplementation(async (url, init) => {
			const response = await transport(url, init);
			if (String(url).endsWith('/direct-asset-upload-sessions/recovered')) session.state = 'READY';
			return response;
		});
		const selected = file(matching ? 'same-file' : 'diff-file');
		const identity = vi.spyOn(fileIdentity, 'createFileSourceIdentity');
		const view = mount(kind, selected);
		if (matching) {
			await waitFor(() => expect(view.complete).toHaveBeenCalledOnce());
			expect(sessionStorage.getItem(storageKey())).toBeNull();
		} else {
			await screen.findByRole('alert');
			expect(view.complete).not.toHaveBeenCalled(); expect(sessionStorage.getItem(storageKey())).toContain('recovered');
		}
		expect(identity).toHaveBeenCalledWith(selected);
		expect(net.creates).toHaveLength(0); expect(net.completes).toHaveLength(0);
	});
	it('verifies an input selection before accepting READY, then permits the original file to be reselected', async () => {
		const { net, session } = await storedSession('UPLOADING');
		const view = mount(kind);
		const input = await screen.findByLabelText(/파일 선택/);
		await screen.findByText(/중단된 .*업로드가 있습니다/);
		session.state = 'READY';
		const selected = file('diff-file');
		const identity = vi.spyOn(fileIdentity, 'createFileSourceIdentity');
		fireEvent.change(input, { target: { files: [selected] } }); retry();
		await screen.findByRole('alert'); expect(identity).toHaveBeenCalledWith(selected);
		expect(view.complete).not.toHaveBeenCalled(); expect(sessionStorage.getItem(storageKey())).toContain('recovered');
		fireEvent.change(screen.getByLabelText(/파일 선택/), { target: { files: [file()] } }); retry();
		await waitFor(() => expect(view.complete).toHaveBeenCalledOnce());
		expect(net.creates).toHaveLength(0); expect(net.completes).toHaveLength(0);
	});
});

describe.each(['IMAGE', 'VIDEO'] as const)('%s real parent queue with a saved READY result', kind => {
	it.each(['matching', 'different', 'legacy'] as const)('accepts only a proven matching selection (%s)', async selection => {
		const net = network(kind);
		const name = kind === 'IMAGE' ? 'cover.png' : 'video.mp4';
		const original = new File(['same-file'], name);
		const session = await net.seed(original, 'READY');
		const saved = { ...session };
		if (selection === 'legacy') { Reflect.deleteProperty(saved, 'sourceIdentity'); Reflect.deleteProperty(saved, 'sourceIdentityAlgorithm'); }
		const storageKey = kind === 'IMAGE' ? 'pcu.direct-image-upload:PROJECT:7' : 'pcu.direct-video-upload:7';
		sessionStorage.setItem(storageKey, JSON.stringify({ session: saved, originalName: name, totalBytes: original.size, completed: 0 }));
		resetDirectUploadTasksForTests();
		const identity = vi.spyOn(fileIdentity, 'createFileSourceIdentity');
		render(<QueryClientProvider client={client()}><AdminProjectUploadProvider project={project} projectId={7} limits={getClientUploadLimits('ADMIN')} canEditContent>
			<AdminProjectAssetManager canEditContent /><QueueControls />
		</AdminProjectUploadProvider></QueryClientProvider>);
		const selected = new File([selection === 'different' ? 'diff-file' : 'same-file'], name, { type: kind === 'IMAGE' ? 'image/png' : 'video/mp4' });
		fireEvent.drop(screen.getByRole('button', { name: '게임·미디어·자료 선택' }).parentElement!, { dataTransfer: { files: [selected], types: ['Files'] } });
		fireEvent.click(screen.getByRole('button', { name: '적용' }));
		if (selection === 'matching') {
			await waitFor(() => expect(screen.getByTestId('queue').textContent).toBe(`${name}:done`));
			expect(sessionStorage.getItem(storageKey)).toBeNull();
		} else {
			await screen.findByRole('alert');
			expect(screen.getByTestId('queue').textContent).not.toContain(':done');
			expect(sessionStorage.getItem(storageKey)).toContain('recovered');
		}
		if (selection !== 'legacy') expect(identity).toHaveBeenCalledWith(selected);
		expect(net.creates).toHaveLength(0); expect(net.completes).toHaveLength(0);
	});
});

describe.each(['IMAGE', 'VIDEO', 'GAME', 'WEBGL'] as const)('%s selection during saved session restoration', kind => {
	const storageKey = () => kind === 'IMAGE' ? 'pcu.direct-image-upload:PROJECT:7'
		: kind === 'VIDEO' ? 'pcu.direct-video-upload:7' : `pcu.direct-asset-upload:7:${kind}`;
	const file = (contents = 'same-file', name?: string) => new File([contents], name ?? (kind === 'IMAGE' ? 'cover.png' : kind === 'VIDEO' ? 'video.mp4' : 'game.zip'));
	async function storedSession(original = file()) {
		const net = network(kind); const session = await net.seed(original, 'READY');
		sessionStorage.setItem(storageKey(), JSON.stringify(kind === 'IMAGE' || kind === 'VIDEO'
			? { session, originalName: original.name, totalBytes: original.size, completed: 0 } : session));
		resetDirectUploadTasksForTests();
		return { net, original, session };
	}
	it.each(['other-name', 'same-name-size'] as const)('does not complete B when A returns READY after an actual input selection (%s)', async variant => {
		const { net, session } = await storedSession(); net.controls.holdStatus = true;
		const view = mount(kind);
		await waitFor(() => expect(net.statuses.length).toBeGreaterThan(0));
		const identity = vi.spyOn(fileIdentity, 'createFileSourceIdentity');
		const selected = file('diff-file', variant === 'other-name' ? 'other-file.zip' : undefined);
		fireEvent.change(screen.getByLabelText(/파일 선택/), { target: { files: [selected] } });
		net.controls.holdStatus = false;
		await act(async () => { for (const request of net.statuses) request.response.resolve(json(session)); });
		expect(view.complete).not.toHaveBeenCalled(); expect(view.cancelled).not.toHaveBeenCalled();
		expect(sessionStorage.getItem(storageKey())).toContain('recovered');
		expect(net.creates).toHaveLength(0); expect(net.completes).toHaveLength(0);
		retry(); await screen.findByRole('alert');
		if (variant === 'same-name-size') expect(identity).toHaveBeenCalledWith(selected);
		expect(view.complete).not.toHaveBeenCalled(); expect(sessionStorage.getItem(storageKey())).toContain('recovered');
		fireEvent.change(screen.getByLabelText(/파일 선택/), { target: { files: [file()] } }); retry();
		await waitFor(() => expect(view.complete).toHaveBeenCalledOnce());
		expect(sessionStorage.getItem(storageKey())).toBeNull();
		expect(net.creates).toHaveLength(0); expect(net.completes).toHaveLength(0);
	});
	it.each(['none', 'identical'] as const)('recovers the original READY result with selection=%s exactly once', async selection => {
		const { net } = await storedSession();
		const view = mount(kind, selection === 'none' ? undefined : file());
		await waitFor(() => expect(view.complete).toHaveBeenCalledOnce());
		expect(sessionStorage.getItem(storageKey())).toBeNull();
		expect(net.creates).toHaveLength(0); expect(net.completes).toHaveLength(0);
	});
	it.each(['selection', 'unmount'] as const)('revokes a real in-progress file hash on %s without consuming the original result', async change => {
		// Real FileReader/WebCrypto work yields between blocks; no hash result or
		// production client is mocked. Wait for an observed, still-pending hash.
		const original = new File(['x'.repeat(2 * 1024 * 1024)], file().name);
		const { net } = await storedSession(original);
		const task = getDirectUploadTask('9', storageKey()); const matches = vi.spyOn(task, 'matchesFile');
		const complete = vi.fn(); const cancelled = vi.fn();
		const view = render(<QueryClientProvider client={client()}>{widget(kind, original, complete, cancelled, undefined, undefined, false)}</QueryClientProvider>);
		await waitFor(() => expect(matches).toHaveBeenCalledWith(original), { interval: 1 });
		const checking = matches.mock.results[0]!.value as Promise<boolean>;
		let finished = false; void checking.then(() => { finished = true; });
		await Promise.resolve(); expect(finished).toBe(false);
		if (change === 'unmount') view.unmount();
		else fireEvent.change(screen.getByLabelText(/파일 선택/), { target: { files: [file('diff-file')] } });
		await act(async () => { await checking; });
		expect(complete).not.toHaveBeenCalled(); expect(cancelled).not.toHaveBeenCalled();
		expect(sessionStorage.getItem(storageKey())).toContain('recovered');
		if (change === 'selection') {
			expect(screen.queryByRole('alert')?.textContent ?? '').not.toContain('원본과 일치');
			fireEvent.change(screen.getByLabelText(/파일 선택/), { target: { files: [original] } }); retry();
			await waitFor(() => expect(complete).toHaveBeenCalledOnce());
		} else {
			const restored = mount(kind);
			await waitFor(() => expect(restored.complete).toHaveBeenCalledOnce());
		}
		expect(net.creates).toHaveLength(0); expect(net.completes).toHaveLength(0);
	});

	it('does not treat an explicitly cleared selection as file-less original recovery', async () => {
		const { net, session } = await storedSession(); net.controls.holdStatus = true;
		const view = mount(kind); await waitFor(() => expect(net.statuses.length).toBeGreaterThan(0));
		fireEvent.change(screen.getByLabelText(/파일 선택/), { target: { files: [file('diff-file')] } });
		fireEvent.change(screen.getByLabelText(/파일 선택/), { target: { files: [] } });
		net.controls.holdStatus = false;
		await act(async () => { for (const request of net.statuses) request.response.resolve(json(session)); });
		net.controls.cancelConflict = true; cancel();
		await screen.findByRole('alert'); expect(view.complete).not.toHaveBeenCalled(); expect(view.cancelled).not.toHaveBeenCalled();
		expect(sessionStorage.getItem(storageKey())).toContain('recovered');
		view.unmount(); const original = mount(kind);
		await waitFor(() => expect(original.complete).toHaveBeenCalledOnce());
		expect(sessionStorage.getItem(storageKey())).toBeNull(); expect(net.creates).toHaveLength(0);
	});

	it('validates the current selection when task recovery finishes before a view run exists', async () => {
		const net = network(kind); net.controls.loseCreate = true; net.controls.failLookup = true;
		const old = mount(kind, file()); await screen.findByRole('alert'); old.unmount(); resetDirectUploadTasksForTests();
		net.creates[0]!.session.state = 'READY'; net.controls.failLookup = false; net.controls.holdStatus = true;
		const view = mount(kind); await waitFor(() => expect(net.statuses.length).toBeGreaterThan(0));
		const selected = file('diff-file');
		const identity = vi.spyOn(fileIdentity, 'createFileSourceIdentity');
		fireEvent.change(screen.getByLabelText(/파일 선택/), { target: { files: [selected] } });
		net.controls.holdStatus = false;
		await act(async () => { for (const request of net.statuses) request.response.resolve(json(net.creates[0]!.session)); });
		await screen.findByRole('alert'); expect(identity).toHaveBeenCalledWith(selected);
		expect(view.complete).not.toHaveBeenCalled(); expect(sessionStorage.getItem(storageKey())).toContain('session-1');
		expect(sessionStorage.getItem(`${storageKey()}:creation`)).toContain(net.createRequests[0]!.clientUploadId);
		fireEvent.change(screen.getByLabelText(/파일 선택/), { target: { files: [file()] } }); retry();
		await waitFor(() => expect(view.complete).toHaveBeenCalledOnce()); expect(net.creates).toHaveLength(1);
	});

});

it.each(['IMAGE', 'VIDEO'] as const)('keeps the real %s parent queue pending after selection invalidates restored READY', async kind => {
	const net = network(kind); const type = kind === 'IMAGE' ? 'image/png' : 'video/mp4';
	const original = new File(['same-file'], kind === 'IMAGE' ? 'cover.png' : 'video.mp4', { type });
	const next = new File(['next-file'], kind === 'IMAGE' ? 'next.png' : 'next.mp4', { type });
	const session = await net.seed(original, 'READY');
	const key = kind === 'IMAGE' ? 'pcu.direct-image-upload:PROJECT:7' : 'pcu.direct-video-upload:7';
	sessionStorage.setItem(key, JSON.stringify({ session, originalName: original.name, totalBytes: original.size, completed: 0 }));
	resetDirectUploadTasksForTests(); net.controls.holdStatus = true; net.controls.holdCreate = false; net.controls.holdComplete = true;
	render(<QueryClientProvider client={client()}><LinearUploadContext.Provider value><AdminProjectUploadProvider project={project} projectId={7} limits={getClientUploadLimits('ADMIN')} canEditContent>
		<AdminProjectAssetManager canEditContent /><QueueControls />
	</AdminProjectUploadProvider></LinearUploadContext.Provider></QueryClientProvider>);
	fireEvent.drop(screen.getByRole('button', { name: '게임·미디어·자료 선택' }).parentElement!, { dataTransfer: { files: [original, next], types: ['Files'] } });
	fireEvent.click(screen.getByRole('button', { name: '적용' })); await waitFor(() => expect(net.statuses.length).toBeGreaterThan(0));
	const list = screen.getByRole('list', { name: '변경 파일 업로드 진행' });
	fireEvent.change(within(list).getByLabelText(/파일 선택/), { target: { files: [new File(['diff-file'], original.name, { type })] } });
	net.controls.holdStatus = false;
	await act(async () => { for (const request of net.statuses) request.response.resolve(json(session)); });
	expect(screen.getByTestId('queue').textContent).toBe(`${original.name}:active,${next.name}:pending`);
	expect(net.creates).toHaveLength(0); expect(sessionStorage.getItem(key)).toContain('recovered');
	fireEvent.change(within(list).getByLabelText(/파일 선택/), { target: { files: [original] } });
	fireEvent.click(within(list).getByRole('button', { name: /재시도|이어올리기/ }));
	await waitFor(() => expect(net.completes).toHaveLength(1));
	expect(screen.getByTestId('queue').textContent).toBe(`${original.name}:done,${next.name}:active`);
	expect(net.createRequests.map(request => request.originalName)).toEqual([next.name]);
	await act(async () => net.completes[0]!.response.resolve(json({ status: 'READY', sessionId: net.completes[0]!.id, generation: 1, sizeBytes: next.size })));
	await waitFor(() => expect(screen.getByTestId('queue').textContent).toBe(`${original.name}:done,${next.name}:done`));
	expect(net.createRequests).toHaveLength(1);
});

it('voting poster does not credit a new input selection with a delayed original READY', async () => {
	const net = network('POSTER', { type: 'EXHIBITION', id: 3 });
	const original = new File(['same-file'], 'poster.png', { type: 'image/png' });
	const session = await net.seed(original, 'READY');
	sessionStorage.setItem('pcu.vote-poster:vote-1', JSON.stringify(session)); resetDirectUploadTasksForTests();
	net.controls.holdStatus = true; const onReady = vi.fn();
	render(<QueryClientProvider client={client()}><VotePosterUpload voteId="vote-1" exhibitionId={3} onReady={onReady} /></QueryClientProvider>);
	await waitFor(() => expect(net.statuses.length).toBeGreaterThan(0));
	fireEvent.change(screen.getByLabelText('투표 전용 포스터 업로드'), { target: { files: [new File(['diff-file'], original.name, { type: 'image/png' })] } });
	net.controls.holdStatus = false;
	await act(async () => { for (const request of net.statuses) request.response.resolve(json(session)); });
	await screen.findByRole('alert'); expect(onReady).not.toHaveBeenCalled();
	expect(sessionStorage.getItem('pcu.vote-poster:vote-1')).toContain('recovered');
	fireEvent.change(screen.getByLabelText('투표 전용 포스터 업로드'), { target: { files: [original] } });
	await waitFor(() => expect(onReady).toHaveBeenCalledExactlyOnceWith(session.sessionId));
	expect(sessionStorage.getItem('pcu.vote-poster:vote-1')).toBeNull();
	expect(net.creates).toHaveLength(0); expect(net.completes).toHaveLength(0);
});


it.each(['IMAGE', 'VIDEO'] as const)('ignores the real %s client late complete response while the parent queue uploads its next file', async kind => {
	const net = network(kind); net.controls.holdCreate = false; net.controls.holdComplete = true;
	const type = kind === 'IMAGE' ? 'image/png' : 'video/mp4';
	const original = new File(['same-file'], kind === 'IMAGE' ? 'cover.png' : 'video.mp4', { type });
	const next = new File(['next-file'], kind === 'IMAGE' ? 'next.png' : 'next.mp4', { type });
	render(<QueryClientProvider client={client()}><AdminProjectUploadProvider project={project} projectId={7} limits={getClientUploadLimits('ADMIN')} canEditContent>
		<AdminProjectAssetManager canEditContent /><QueueControls />
	</AdminProjectUploadProvider></QueryClientProvider>);
	fireEvent.drop(screen.getByRole('button', { name: '게임·미디어·자료 선택' }).parentElement!, { dataTransfer: { files: [original, next], types: ['Files'] } });
	fireEvent.click(screen.getByRole('button', { name: '적용' })); await waitFor(() => expect(net.completes).toHaveLength(1));
	// The server committed A, but its complete response is still in transit.
	net.creates[0]!.session.state = 'READY'; net.controls.cancelConflict = true;
	const list = screen.getByRole('list', { name: '변경 파일 업로드 진행' });
	fireEvent.click(within(list).getByRole('button', { name: /^취소/ }));
	await waitFor(() => expect(net.completes).toHaveLength(2));
	expect(screen.getByTestId('queue').textContent).toBe(`${original.name}:done,${next.name}:active`);
	await act(async () => net.completes[0]!.response.resolve(json({ status: 'READY', sessionId: net.completes[0]!.id, generation: 1, sizeBytes: original.size })));
	expect(screen.getByTestId('queue').textContent).toBe(`${original.name}:done,${next.name}:active`);
	expect(net.createRequests.map(request => request.originalName)).toEqual([original.name, next.name]);
	await act(async () => net.completes[1]!.response.resolve(json({ status: 'READY', sessionId: net.completes[1]!.id, generation: 1, sizeBytes: next.size })));
	await waitFor(() => expect(screen.getByTestId('queue').textContent).toBe(`${original.name}:done,${next.name}:done`));
	expect(net.creates).toHaveLength(2); expect(net.deletes).toHaveLength(1);
});
