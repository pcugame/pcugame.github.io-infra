/* @vitest-environment jsdom */
import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { putUploadPart } from '../lib/api/upload-part-transport';
import { uploadDirectAssetFile, type DirectAssetUploadProgress } from '../lib/api/game-upload';
import { createFileSourceIdentity } from '../lib/file-identity';

class Xhr {
 static requests: Xhr[] = [];
 upload = { onprogress: null as null | ((event: { loaded: number }) => void) };
 onload = () => {}; onerror = () => {}; ontimeout = () => {}; onabort = () => {};
 status = 200; responseHeaders = new Headers({ etag: 'etag' });
 headers: Record<string, string> = {}; body?: Blob; url = ''; aborted = false;
 open(method: string, url: string) { expect(method).toBe('PUT'); this.url = url; }
 setRequestHeader(name: string, value: string) { this.headers[name] = value; }
 getResponseHeader(name: string) { return this.responseHeaders.get(name); }
 send(body: Blob) { this.body = body; Xhr.requests.push(this); }
 abort() { this.aborted = true; this.onabort(); }
 progress(loaded: number) { this.upload.onprogress?.({ loaded }); }
 finish() { this.onload(); }
}
const json = (data: unknown) => new Response(JSON.stringify({ ok: true, data }));
beforeEach(() => {
 Xhr.requests = []; vi.stubGlobal('XMLHttpRequest', Xhr); vi.stubGlobal('crypto', webcrypto);
 Object.defineProperty(Blob.prototype, 'arrayBuffer', { configurable: true, value: function(this: Blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = reject; reader.readAsArrayBuffer(this); }); } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (Blob.prototype as Partial<Blob>).arrayBuffer; });

it('uses signed headers, progress, exposed ETag and AbortSignal on storage XHR', async () => {
 const controller = new AbortController(); const progress = vi.fn();
 const response = putUploadPart({ url: 'https://storage.test/part', requiredHeaders: { 'x-amz-checksum-sha256': 'proof' } }, new Blob(['1234']), controller.signal, progress);
 const xhr = Xhr.requests[0]!;
 expect(xhr.headers).toEqual({ 'x-amz-checksum-sha256': 'proof' });
 xhr.progress(2); expect(progress).toHaveBeenLastCalledWith(2);
 xhr.finish(); expect((await response).headers.get('etag')).toBe('etag');
 controller.abort(); expect(xhr.aborted).toBe(false);
 const other = new AbortController();
 const cancelled = putUploadPart({ url: 'https://storage.test/part', requiredHeaders: {} }, new Blob(['1']), other.signal);
 other.abort(); await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' }); expect(Xhr.requests[1]!.aborted).toBe(true);
});

it.each([3, 8, 10])('counts actual bytes for %i bytes, including a short final part and progress before ETag', async size => {
 const file = new File(['x'.repeat(size)], 'game.zip');
 const progress: DirectAssetUploadProgress[] = [];
 const source = await createFileSourceIdentity(file);
 const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url.endsWith('/direct-game-upload-sessions')) return json({ ...JSON.parse(String(init?.body)), owner: { type: 'PROJECT', id: 7 }, kind: 'GAME', sessionId: 's', generation: 1, state: 'UPLOADING', partSizeBytes: 4, totalParts: Math.ceil(size / 4), expiresAt: '2030-01-01T00:00:00.000Z' });
  if (url.endsWith('/part-urls')) return json({ generation: 1, parts: JSON.parse(String(init?.body)).parts.map((part: { partNumber: number }) => ({ partNumber: part.partNumber, url: `https://storage.test/${part.partNumber}`, requiredHeaders: {} })) });
  return json({ status: 'VERIFYING', sessionId: 's', generation: 1, sizeBytes: size });
 });
 vi.stubGlobal('fetch', fetchMock);
 const upload = uploadDirectAssetFile(7, file, 'GAME', event => progress.push(event));
 let confirmed = 0;
 for (let i = 0; i < Math.ceil(size / 4); i++) {
  await vi.waitFor(() => expect(Xhr.requests).toHaveLength(i + 1));
  const xhr = Xhr.requests[i]!;
  xhr.progress(1);
  expect(progress.at(-1)).toMatchObject({ confirmedBytes: confirmed, inFlightBytes: 1, uploadedBytes: confirmed + 1 });
  xhr.progress(xhr.body!.size);
  expect(progress.at(-1)!.percent).toBeLessThan(100);
  xhr.finish(); confirmed += xhr.body!.size;
 }
 await upload;
 expect(progress.at(-1)).toMatchObject({ phase: 'verifying', confirmedBytes: size, inFlightBytes: 0, percent: 100 });
 expect(progress[0]?.phase).toBe('checking'); expect(source.sourceIdentity).toHaveLength(64);
});

it('restores server-confirmed bytes immediately and never adds a failed attempt twice', async () => {
 const file = new File(['abcdefghij'], 'game.zip'); const source = await createFileSourceIdentity(file);
 const session = { sessionId: 's', generation: 1, owner: { type: 'PROJECT' as const, id: 7 }, kind: 'GAME' as const, partSizeBytes: 4, totalParts: 3, expiresAt: '2030-01-01T00:00:00Z', ...source };
 vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
  if (url.endsWith('/s')) return json({ ...session, originalName: file.name, totalBytes: file.size, state: 'UPLOADING', parts: [{ partNumber: 1, etag: 'old', sizeBytes: 4 }] });
  if (url.endsWith('/part-urls')) return json({ generation: 1, parts: JSON.parse(String(init?.body)).parts.map((part: { partNumber: number }) => ({ partNumber: part.partNumber, url: `https://storage.test/${part.partNumber}`, requiredHeaders: {} })) });
  return json({ status: 'READY', sessionId: 's', generation: 1 });
 }));
 const progress: DirectAssetUploadProgress[] = [];
 const upload = uploadDirectAssetFile(7, file, 'GAME', event => progress.push(event), { resume: session });
 await vi.waitFor(() => expect(Xhr.requests).toHaveLength(1));
 expect(progress.some(event => event.confirmedBytes === 4 && event.percent === 40)).toBe(true);
 Xhr.requests[0]!.progress(4); Xhr.requests[0]!.status = 429; Xhr.requests[0]!.responseHeaders.set('retry-after', '0.001'); Xhr.requests[0]!.finish();
 await vi.waitFor(() => expect(Xhr.requests).toHaveLength(2));
 expect(progress.at(-1)).toMatchObject({ uploadedBytes: 4, inFlightBytes: 0 });
 Xhr.requests[1]!.progress(2); expect(progress.at(-1)?.uploadedBytes).toBe(6); Xhr.requests[1]!.finish();
 await vi.waitFor(() => expect(Xhr.requests).toHaveLength(3));
 Xhr.requests[2]!.finish(); await upload;
 expect(progress.at(-1)).toMatchObject({ uploadedBytes: 10, percent: 100 });
});

it('never reports confirmed completion when the successful HTTP response omits ETag', async () => {
 const file = new File(['abc'], 'game.zip'); const source = await createFileSourceIdentity(file);
 const session = { sessionId: 's', generation: 1, owner: { type: 'PROJECT' as const, id: 7 }, kind: 'GAME' as const, partSizeBytes: 4, totalParts: 1, expiresAt: '2030-01-01T00:00:00Z', ...source };
 vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/s') ? json({ ...session, originalName: file.name, totalBytes: 3, state: 'UPLOADING', parts: [] }) : json({ generation: 1, parts: [{ partNumber: 1, url: 'https://storage.test/1', requiredHeaders: {} }] })));
 const progress: DirectAssetUploadProgress[] = [];
 const upload = uploadDirectAssetFile(7, file, 'GAME', event => progress.push(event), { resume: session });
 const failed = expect(upload).rejects.toThrow('ETag');
 await vi.waitFor(() => expect(Xhr.requests).toHaveLength(1));
 Xhr.requests[0]!.progress(3); Xhr.requests[0]!.responseHeaders.delete('etag'); Xhr.requests[0]!.finish();
 await failed; expect(progress.every(event => event.percent < 100)).toBe(true);
});
