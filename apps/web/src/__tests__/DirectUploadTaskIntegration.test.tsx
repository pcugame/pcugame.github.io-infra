/* @vitest-environment jsdom */
import { webcrypto } from 'node:crypto';
import { StrictMode, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminProjectDetail, DirectAssetUploadKind, DirectAssetUploadStatus } from '../contracts';
import DirectImageUploadWidget from '../components/DirectImageUploadWidget';
import DirectVideoUploadWidget from '../components/DirectVideoUploadWidget';
import GameUploadWidget from '../components/GameUploadWidget';
import { resetDirectUploadTasksForTests, type SubmissionBinding } from '../lib/upload/directUploadTask';
import { createFileSourceIdentity } from '../lib/file-identity';
import { getClientUploadLimits } from '../lib/upload-limits';
import { AdminProjectUploadProvider, AdminProjectAssetManager, AdminProjectUploadProgress, useAdminProjectUploadQueue } from '../features/admin/projects/AdminProjectAssetManager';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ ok: status < 400, data }), { status, statusText: status >= 400 ? 'Control request failed' : 'OK', headers: { 'content-type': 'application/json' } });
const binding = { id: 'item', clientToken: 'a'.repeat(32) };
let installedArrayBuffer = false;
beforeEach(() => {
	vi.stubGlobal('crypto', webcrypto);
	if (!Blob.prototype.arrayBuffer) {
		installedArrayBuffer = true;
		Object.defineProperty(Blob.prototype, 'arrayBuffer', { configurable: true, value(this: Blob) {
			return new Promise<ArrayBuffer>((resolve, reject) => {
				const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer);
				reader.onerror = () => reject(reader.error); reader.readAsArrayBuffer(this);
			});
		} });
	}
});
afterEach(() => {
	cleanup(); resetDirectUploadTasksForTests(); sessionStorage.clear();
	if (installedArrayBuffer) { delete (Blob.prototype as Partial<Blob>).arrayBuffer; installedArrayBuffer = false; }
	vi.unstubAllGlobals(); vi.restoreAllMocks();
});

function network(kind: DirectAssetUploadKind) {
	const sessions = new Map<string, DirectAssetUploadStatus>();
	const creates: { session: DirectAssetUploadStatus; response: ReturnType<typeof deferred<Response>> }[] = [];
	const completes: { id: string; response: ReturnType<typeof deferred<Response>> }[] = [];
	const deletes: { id: string; response: ReturnType<typeof deferred<Response>> }[] = [];
	const controls = { holdCreate: true, holdComplete: false, holdDelete: false, loseCreate: false, rejectCreate: false, failStatus: false, cancelConflict: false, linked: true, wrongToken: false };
	const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const path = new URL(String(input), 'https://test.invalid').pathname;
		if (/\/direct-\w+-upload-sessions$/.test(path) && init?.method === 'POST') {
			const body = JSON.parse(String(init.body));
			const session: DirectAssetUploadStatus = { ...body, sessionId: `session-${creates.length + 1}`, owner: { type: 'PROJECT', id: 7 }, kind,
				generation: 1, partSizeBytes: 16, totalParts: 1, expiresAt: '2027-01-01T00:00:00.000Z', state: 'UPLOADING', parts: [] };
			const response = deferred<Response>(); creates.push({ session, response });
			if (controls.rejectCreate) return json({}, 400);
			sessions.set(session.sessionId, session);
			if (controls.loseCreate) throw new TypeError('response lost after server allocation');
			return controls.holdCreate ? response.promise : json(session);
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
			if (controls.cancelConflict) return json({}, 409);
			session.state = 'CANCELLED'; return new Response(null, { status: 204 });
		}
		if (controls.failStatus) return json({}, 503);
		return json(session);
	});
	vi.stubGlobal('fetch', fetcher);
	return { controls, sessions, creates, completes, deletes, fetcher,
		async seed(file: File, state: DirectAssetUploadStatus['state'] = 'UPLOADING') {
			const source = await createFileSourceIdentity(file);
			const session: DirectAssetUploadStatus = { ...source, sessionId: 'recovered', owner: { type: 'PROJECT', id: 7 }, kind, generation: 1,
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
function widget(kind: 'IMAGE' | 'VIDEO' | 'GAME', file: File | undefined, onComplete: () => void, onCancelled: () => void, item?: SubmissionBinding, operationKey?: string) {
	const props = { operationKey, autoStart: Boolean(file), onComplete, onCancelled };
	if (kind === 'GAME') return <GameUploadWidget {...props} projectId={7} initialFile={file} submissionItem={item} />;
	if (kind === 'VIDEO') return <DirectVideoUploadWidget {...props} projectId={7} initialFiles={file ? [file] : []} submissionItems={item ? [item] : []} />;
	return <DirectImageUploadWidget {...props} owner={{ type: 'PROJECT', id: 7 }} kind="IMAGE" initialFiles={file ? [file] : []} submissionItems={item ? [item] : []} />;
}
function mount(kind: 'IMAGE' | 'VIDEO' | 'GAME', file?: File, complete = vi.fn(), cancelled = vi.fn(), item?: SubmissionBinding, operationKey?: string, role = 'ADMIN') {
	return { complete, cancelled, ...render(<StrictMode><QueryClientProvider client={client(role)}>{widget(kind, file, complete, cancelled, item, operationKey)}</QueryClientProvider></StrictMode>) };
}
const cancel = () => fireEvent.click(screen.getByRole('button', { name: /^취소/ }));
const retry = () => fireEvent.click(screen.getByRole('button', { name: /시작|재시도|이어올리기/ }));

describe.each(['IMAGE', 'VIDEO', 'GAME'] as const)('%s job handoff through React and production multipart client', kind => {
	const file = () => new File(['same-file'], kind === 'GAME' ? 'game.zip' : kind === 'VIDEO' ? 'video.mp4' : 'cover.png');
	it.each(['resume', 'cancel'] as const)('blocks a second create across reentry and exposes the late session for %s', async action => {
		const net = network(kind); const chosen = file(); const old = mount(kind, chosen);
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
	it('allows retry after a definite create rejection', async () => {
		const net = network(kind); net.controls.rejectCreate = true; const view = mount(kind, file());
		await screen.findByRole('alert'); net.controls.rejectCreate = false; net.controls.holdCreate = false; retry();
		await waitFor(() => expect(view.complete).toHaveBeenCalledOnce()); expect(net.creates).toHaveLength(2);
	});
	it('retains an ambiguous allocation without issuing another create or reporting cancellation', async () => {
		const net = network(kind); net.controls.loseCreate = true; const chosen = file(); const old = mount(kind, chosen);
		await screen.findByRole('alert'); old.unmount(); const view = mount(kind, chosen);
		await screen.findByRole('alert'); retry(); cancel();
		await act(async () => { await Promise.resolve(); }); expect(net.creates).toHaveLength(1);
		expect(view.cancelled).not.toHaveBeenCalled(); expect(view.complete).not.toHaveBeenCalled();
		expect(screen.getByRole('alert').textContent).toContain('확인');
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
		const net = network(kind); const chosen = file(); const old = mount(kind, chosen);
		await waitFor(() => expect(net.creates).toHaveLength(1)); old.unmount(); const view = mount(kind, chosen);
		await screen.findByRole('button', { name: /시작/ }); cancel(); net.controls.cancelConflict = true; net.creates[0]!.session.state = 'READY';
		await act(async () => net.creates[0]!.response.resolve(json(net.creates[0]!.session)));
		await waitFor(() => expect(view.complete).toHaveBeenCalledOnce()); expect(view.cancelled).not.toHaveBeenCalled(); expect(net.creates).toHaveLength(1);
	});

	it('keeps a lost allocation recoverable through failed status and later cancellation', async () => {
		const net = network(kind); net.controls.loseCreate = true; net.controls.failStatus = true;
		const view = mount(kind, file(), vi.fn(), vi.fn(), { ...binding, state: 'EXPECTED' });
		await screen.findByRole('alert');
		await waitFor(() => expect(net.fetcher.mock.calls.some(([url]) => String(url).endsWith('/submission'))).toBe(true));
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
		await waitFor(() => expect(sessionStorage.getItem(kind === 'GAME' ? 'pcu.direct-asset-upload:7:GAME' : kind === 'IMAGE' ? 'pcu.direct-image-upload:PROJECT:7' : 'pcu.direct-video-upload:7')).toBeNull());
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


it('uses the user submission endpoint to recover a lost user create', async () => {
 const net = network('GAME'); net.controls.loseCreate = true;
 const view = mount('GAME', new File(['game'], 'game.zip'), vi.fn(), vi.fn(), { ...binding, state: 'EXPECTED' }, undefined, 'USER');
 await screen.findByRole('button', { name: '이어올리기' }); retry();
 await waitFor(() => expect(view.complete).toHaveBeenCalledOnce()); expect(net.creates).toHaveLength(1);
 expect(net.fetcher.mock.calls.some(([url]) => String(url).endsWith('/api/me/projects/7/submission'))).toBe(true);
 expect(net.fetcher.mock.calls.some(([url]) => String(url).endsWith('/api/admin/projects/7/submission'))).toBe(false);
});

const project: AdminProjectDetail = { id: 7, title: 'Project', slug: 'project', year: 2026, platforms: [], isIncomplete: false, video: null, videos: [], status: 'PUBLISHED', sortOrder: 0, members: [], assets: [], visibility: 'PUBLIC', exhibitionVisibility: 'PUBLIC', canChangeVisibility: false };
function QueueControls() {
	const queue = useAdminProjectUploadQueue(); const [visible, setVisible] = useState(true);
	return <><button onClick={() => void queue.applyChanges().catch(() => undefined)}>적용</button>
		<button onClick={() => setVisible(value => !value)}>화면 전환</button>
		<output data-testid="queue">{queue.entries.map(entry => `${entry.file.name}:${entry.status}`).join(',')}</output>
		{visible && <AdminProjectUploadProgress />}</>;
}
it.each(['READY', 'CANCELLED'] as const)('real parent queue reconciles %s once across a pending-create view handoff', async outcome => {
	const net = network('IMAGE');
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
