/* @vitest-environment jsdom */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FileUploadQueue, type FileUploadSpec } from '../lib/upload/fileUploadQueue';
import { getDirectUploadTask, resetDirectUploadTasksForTests } from '../lib/upload/directUploadTask';
import { createFileSourceIdentity } from '../lib/file-identity';
import * as api from '../lib/api/game-upload';
vi.mock('../lib/api/game-upload', async importOriginal => ({ ...await importOriginal<typeof api>(),
 uploadDirectAssetFile: vi.fn(), getDirectAssetUploadStatus: vi.fn(), cancelDirectAssetUploadSession: vi.fn(), waitForDirectAssetReady: vi.fn(), getDirectAssetUploadCreation: vi.fn(),
}));
const upload = vi.mocked(api.uploadDirectAssetFile);
const status = vi.mocked(api.getDirectAssetUploadStatus);
const cancel = vi.mocked(api.cancelDirectAssetUploadSession);
const queues: (() => void)[] = [];
const owner = { type: 'PROJECT' as const, id: 7 };
const spec = (id: string, file = new File([id], `${id}.png`)): FileUploadSpec => ({ id, owner, kind: 'IMAGE', file, name: file.name, size: file.size });
function make(specs: FileUploadSpec[]) { const queue = new FileUploadQueue('3', 'admin'); queues.push(queue.attach()); queue.sync(specs); return queue; }
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function session(file: File, id: string): Promise<api.DirectAssetUploadSession> { return { ...await createFileSourceIdentity(file), owner, kind: 'IMAGE', sessionId: id, generation: 1, partSizeBytes: 4, totalParts: 1, expiresAt: '2030-01-01T00:00:00Z' }; }
const ready = (id: string) => ({ status: 'READY' as const, sessionId: id, generation: 1, sizeBytes: 1 });
async function seed(file: File, id: string, state = 'UPLOADING') {
 const saved = await session(file, id);
 const result = { ...saved, state, originalName: file.name, totalBytes: file.size, parts: [] } as Awaited<ReturnType<typeof api.getDirectAssetUploadStatus>>;
 return { saved, result };
}
beforeEach(() => {
 vi.stubGlobal('crypto', webcrypto);
 Object.defineProperty(Blob.prototype, 'arrayBuffer', { configurable: true, value: function(this: Blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsArrayBuffer(this); }); } });
 upload.mockImplementation(async (_owner, _file, _kind, _progress, options) => { const saved = await session(_file, `session-${options?.submissionItem?.id ?? _file.name}`); options?.onSession?.(saved); return ready(saved.sessionId); });
});
afterEach(() => { for (const detach of queues.splice(0)) detach(); resetDirectUploadTasksForTests(); sessionStorage.clear(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); delete (Blob.prototype as Partial<Blob>).arrayBuffer; });

it('keeps three stable rows, continues after the second failure, and retries only it at the tail', async () => {
 upload.mockImplementationOnce(async () => ready('one')).mockRejectedValueOnce(new Error('second failed')).mockImplementationOnce(async () => ready('three'));
 const queue = make([spec('one'), spec('two'), spec('three')]);
 await queue.start();
 expect(queue.getSnapshot().map(row => row.phase)).toEqual(['ready', 'failed', 'ready']);
 expect(upload.mock.calls.map(call => call[1].name)).toEqual(['one.png', 'two.png', 'three.png']);
 queue.retry('two'); await vi.waitFor(() => expect(queue.getSnapshot()[1]!.phase).toBe('ready'));
 expect(upload.mock.calls.map(call => call[1].name)).toEqual(['one.png', 'two.png', 'three.png', 'two.png']);
 expect(queue.getSnapshot().map(row => row.id)).toEqual(['one', 'two', 'three']);
});

it('cancels a waiting file without deleting another session, retaining it for an independent retry', async () => {
 const hold = deferred<ReturnType<typeof ready>>(); upload.mockImplementationOnce(() => hold.promise);
 const queue = make([spec('one'), spec('two'), spec('three')]); const running = queue.start();
 await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
 await queue.cancel('two'); expect(cancel).not.toHaveBeenCalled();
 expect(queue.getSnapshot()[1]!.phase).toBe('cancelled');
 hold.resolve(ready('one')); await running;
 expect(upload.mock.calls.map(call => call[1].name)).toEqual(['one.png', 'three.png']);
 queue.retry('two'); await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
});

it('waits for active cancellation confirmation before advancing, and isolates same-name files', async () => {
 const first = spec('one', new File(['a'], 'same.png')), second = spec('two', new File(['b'], 'same.png'));
 const saved = await session(first.file!, 'one'); const deleted = deferred<void>();
 upload.mockImplementationOnce((_owner, _file, _kind, _progress, options) => { options!.onSession!(saved); return new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))); });
 cancel.mockReturnValueOnce(deleted.promise);
 const queue = make([first, second]); const running = queue.start();
 await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
 const cancellation = queue.cancel('one'); await vi.waitFor(() => expect(cancel).toHaveBeenCalledExactlyOnceWith('one'));
 expect(queue.getSnapshot()[0]!.phase).toBe('cancelling'); expect(upload).toHaveBeenCalledOnce();
 deleted.resolve(); await cancellation; await running;
 expect(upload).toHaveBeenCalledTimes(2); expect(upload.mock.calls[1]![1]).toBe(second.file);
 expect(queue.getSnapshot().map(row => row.phase)).toEqual(['cancelled', 'ready']);
});

it('blocks a new upload while cancellation is unconfirmed, then reconciles VERIFYING without retransmission', async () => {
 const file = spec('one'); const { saved, result } = await seed(file.file!, 'one');
 upload.mockImplementationOnce((_owner, _file, _kind, _progress, options) => { options!.onSession!(saved); return new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))); });
 cancel.mockRejectedValue(new Error('lost DELETE')); status.mockRejectedValueOnce(new Error('offline'));
 const queue = make([file]); void queue.start(); await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
 await queue.cancel('one'); expect(queue.getSnapshot()[0]!.phase).toBe('cancel-unconfirmed');
 queue.retry('one'); await queue.start(); expect(upload).toHaveBeenCalledOnce();
 status.mockResolvedValue({ ...result, state: 'VERIFYING' }); vi.mocked(api.waitForDirectAssetReady).mockResolvedValue({ ...result, state: 'READY' });
 await queue.cancel('one'); await vi.waitFor(() => expect(queue.getSnapshot()[0]!.phase).toBe('ready'));
 expect(upload).toHaveBeenCalledOnce();
});

it('recovers a saved file after remount, verifies reselection, and resumes only that session', async () => {
 const original = spec('one'); const { saved, result } = await seed(original.file!, 'existing');
 sessionStorage.setItem('pcu.file-upload:3:PROJECT:7:IMAGE:one', JSON.stringify({ session: saved, originalName: original.name, totalBytes: original.size }));
 status.mockResolvedValue(result);
 const queue = make([{ ...original, file: undefined }]); await queue.start();
 expect(queue.getSnapshot()[0]!.phase).toBe('failed'); expect(upload).not.toHaveBeenCalled();
 await queue.select('one', new File(['bad'], original.name)); expect(upload).not.toHaveBeenCalled();
 await queue.select('one', new File(['one'], original.name));
 await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
 expect(upload.mock.calls[0]![4]?.resume?.sessionId).toBe('existing');
});

it('migrates a legacy record only into its matching submission item, preserving another slot', async () => {
 const one = spec('one'), two = spec('two'); const { saved, result } = await seed(two.file!, 'old');
 const legacyKey = 'pcu.direct-image-upload:PROJECT:7';
 sessionStorage.setItem(legacyKey, JSON.stringify({ session: saved, originalName: two.name, totalBytes: two.size, completed: 1 }));
 status.mockResolvedValue(result);
 const queue = make([{ ...two, legacyKey, binding: { id: 'two', clientToken: 'token', sessionId: 'old', generation: 1, state: 'UPLOADING' } }, one]);
 await queue.start();
 expect(sessionStorage.getItem(legacyKey)).toBeNull();
 expect(upload.mock.calls[0]![4]?.resume?.sessionId).toBe('old');
 expect(upload.mock.calls[1]![4]?.resume).toBeUndefined();
});

it('does not drop or reassign an ambiguous legacy creation belonging to another owner', async () => {
 const legacyKey = 'pcu.direct-image-upload:PROJECT:7'; const record = JSON.stringify({ scope: '99', request: { clientUploadId: 'old' }, owner, kind: 'IMAGE' }); sessionStorage.setItem(`${legacyKey}:creation`, record);
 const queue = make([{ ...spec('one'), legacyKey }]); await queue.start();
 expect(upload).not.toHaveBeenCalled(); expect(sessionStorage.getItem(`${legacyKey}:creation`)).toBe(record);
 expect(queue.getSnapshot()[0]!.phase).toBe('failed');
});

it('retains delayed creation responsibility after cancellation and rejects late completion for another row', async () => {
 const file = spec('one'); const saved = await session(file.file!, 'late'); const delayed = deferred<ReturnType<typeof ready>>();
 let options: Parameters<typeof api.uploadDirectAssetFile>[4];
 upload.mockImplementationOnce((_owner, _file, _kind, _progress, next) => { options = next; return delayed.promise; });
 cancel.mockResolvedValue();
 const queue = make([file, spec('two')]); const running = queue.start(); await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
 await queue.cancel('one');
 expect(queue.getSnapshot()[0]!.phase).toBe('cancelling');
 options!.onSession!(saved); delayed.resolve(ready('late'));
 await running; await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('late'));
 expect(queue.getSnapshot().map(row => row.phase)).toEqual(['cancelled', 'ready']);
});

it('cancels a recovered waiting submission session before its row has run', async () => {
 const original = spec('one'); const { result } = await seed(original.file!, 'linked');
 status.mockResolvedValue(result); cancel.mockResolvedValue();
 const queue = make([{ ...original, file: undefined, binding: { id: 'one', clientToken: 'token', sessionId: 'linked', generation: 1, state: 'UPLOADING' } }]);
 await queue.cancel('one');
 expect(cancel).toHaveBeenCalledExactlyOnceWith('linked'); expect(upload).not.toHaveBeenCalled();
 expect(queue.getSnapshot()[0]!.phase).toBe('cancelled');
});

it('recreates a terminal session, while a valid session resumes with its original identity', async () => {
 const original = spec('one'); const { saved, result } = await seed(original.file!, 'expired', 'EXPIRED');
 sessionStorage.setItem('pcu.file-upload:3:PROJECT:7:IMAGE:one', JSON.stringify({ session: saved, originalName: original.name, totalBytes: original.size }));
 status.mockResolvedValue(result);
 const queue = make([original]); await queue.start();
 expect(upload).toHaveBeenCalledOnce(); expect(upload.mock.calls[0]![4]?.resume).toBeUndefined();
 expect(queue.getSnapshot()[0]!.phase).toBe('ready');
});

it('puts a retry after the still-running third file without changing display order', async () => {
 const third = deferred<ReturnType<typeof ready>>();
 upload.mockImplementationOnce(async () => ready('one')).mockRejectedValueOnce(new Error('failed')).mockImplementationOnce(() => third.promise);
 const queue = make([spec('one'), spec('two'), spec('three')]); const run = queue.start();
 await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(3)); queue.retry('two');
 expect(queue.getSnapshot().map(row => row.id)).toEqual(['one', 'two', 'three']); expect(upload).toHaveBeenCalledTimes(3);
 third.resolve(ready('three')); await run;
 expect(upload.mock.calls.map(call => call[1].name)).toEqual(['one.png', 'two.png', 'three.png', 'two.png']);
});

it('preserves legacy ownership while the old view still owns its session', async () => {
 const original = spec('one'); const { saved } = await seed(original.file!, 'owned'); const legacyKey = 'pcu.direct-image-upload:PROJECT:7';
 const raw = JSON.stringify({ session: saved, originalName: original.name, totalBytes: original.size }); sessionStorage.setItem(legacyKey, raw);
 const previous = getDirectUploadTask('3', legacyKey);
 const detach = previous.attach({}, { onCancelReady: vi.fn(), onCancelError: vi.fn(), onCancelSettled: vi.fn() }); queues.push(detach);
 const queue = make([{ ...original, legacyKey }]); await queue.start();
 expect(upload).not.toHaveBeenCalled(); expect(sessionStorage.getItem(legacyKey)).toBe(raw);
 expect(queue.getSnapshot()[0]!.error).toContain('이전 업로드 결과');
});

it('accepts original reselection when legacy migration was waiting for missing source proof', async () => {
 const original = spec('one'); const { saved, result } = await seed(original.file!, 'legacy'); const legacyKey = 'pcu.direct-image-upload:PROJECT:7';
 sessionStorage.setItem(legacyKey, JSON.stringify({ session: saved, originalName: original.name, totalBytes: original.size })); status.mockResolvedValue(result);
 const queue = make([{ ...original, file: undefined, legacyKey }]); await queue.start();
 expect(queue.getSnapshot()[0]!.phase).toBe('failed'); expect(upload).not.toHaveBeenCalled();
 await queue.select('one', new File(['one'], original.name));
 await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce()); expect(upload.mock.calls[0]![4]?.resume?.sessionId).toBe('legacy');
});

it('rolls back a partial legacy copy so storage failure cannot lose its cancellation fence', async () => {
 const original = spec('one'); const { saved, result } = await seed(original.file!, 'legacy'); const legacyKey = 'pcu.direct-image-upload:PROJECT:7';
 const raw = JSON.stringify({ session: saved, originalName: original.name, totalBytes: original.size });
 sessionStorage.setItem(legacyKey, raw); sessionStorage.setItem(`${legacyKey}:cancellation`, JSON.stringify({ scope: '3', sessionId: 'legacy', generation: 1 }));
 status.mockResolvedValue(result);
 const store = Storage.prototype.setItem;
 vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(this: Storage, key, value) {
  if (key === 'pcu.file-upload:3:PROJECT:7:IMAGE:one:cancellation') throw new DOMException('full', 'QuotaExceededError');
  store.call(this, key, value);
 });
 const queue = make([{ ...original, legacyKey }]); await queue.start();
 expect(upload).not.toHaveBeenCalled(); expect(sessionStorage.getItem(legacyKey)).toBe(raw);
 expect(sessionStorage.getItem(`${legacyKey}:cancellation`)).toBeTruthy();
 expect(sessionStorage.getItem('pcu.file-upload:3:PROJECT:7:IMAGE:one')).toBeNull();
});
