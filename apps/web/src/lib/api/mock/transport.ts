import { cloneMockValue, createMockContext, createMockState, MockHttpError, UNHANDLED } from './context';
import type { MockControls, MockRequestOptions, MockState, MockUserSelection } from './context';
import { dispatchMockRequest } from './handler';

const DATABASE = 'pcu-development-mock-v1';
const STORE = 'snapshots';
let database: Promise<IDBDatabase> | undefined;
let cached: MockState | undefined;
let memory: MockState | undefined;
let queue: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();
const externalListeners = new Set<() => void>();
let channel: BroadcastChannel | undefined;

function notify(): void {
  for (const listener of listeners) listener();
  channel?.postMessage('changed');
}
function memoryStorageAllowed(): boolean {
  if (typeof indexedDB !== 'undefined') return false;
  if (typeof window !== 'undefined' && !import.meta.env.VITEST) throw new MockHttpError(500, 'MOCK_STORAGE_UNAVAILABLE', 'IndexedDB is unavailable. Enable browser storage to use the mock environment.');
  return true;
}
function db(): Promise<IDBDatabase> {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Mock database upgrade blocked by another tab'));
  });
  return database;
}
async function read(): Promise<MockState | undefined> {
  if (memoryStorageAllowed()) return memory && cloneMockValue(memory);
  const connection = await db();
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).get('current');
    transaction.oncomplete = () => {
      const value = request.result as MockState | undefined;
      resolve(value);
    };
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Mock snapshot read aborted'));
  });
}
async function write(state: MockState, revision: number | undefined): Promise<void> {
  if (memoryStorageAllowed()) {
    if (memory?.revision !== revision) throw new MockHttpError(409, 'MOCK_REVISION_CONFLICT', 'Mock state changed in another request. Retry.');
    memory = cloneMockValue(state); return;
  }
  const connection = await db();
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const request = store.get('current');
    let conflict = false;
    request.onsuccess = () => {
      if ((request.result as MockState | undefined)?.revision !== revision) { conflict = true; transaction.abort(); return; }
      try { store.put(state, 'current'); } catch (error) { reject(error); transaction.abort(); }
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(conflict
      ? new MockHttpError(409, 'MOCK_REVISION_CONFLICT', 'Mock state changed in another tab. Retry.')
      : transaction.error ?? new Error('Mock snapshot write aborted'));
  });
}
function equalStateValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (left instanceof Blob || right instanceof Blob) return false;
  if (left instanceof Map || right instanceof Map) {
    if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) return false;
    return [...left].every(([key, value]) => right.has(key) && equalStateValue(value, right.get(key)));
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left), other = Object.keys(right);
  return keys.length === other.length && keys.every(key => Object.hasOwn(right, key)
    && equalStateValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}
function semanticallyChanged(previous: MockState, next: MockState): boolean {
  return !equalStateValue({ ...previous, revision: 0 }, { ...next, revision: 0 });
}
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.catch(() => undefined);
  return result;
}
async function load(): Promise<MockState> {
  const saved = await read();
  if (saved) {
    if (Number(saved.version) === 0) {
      const migrated: MockState = { ...createMockState(), ...saved, version: 1, revision: saved.revision + 1 };
      await write(migrated, saved.revision); cached = migrated; return migrated;
    }
    if (saved.version !== 1) throw new MockHttpError(500, 'MOCK_STORAGE_VERSION', 'Unsupported mock snapshot version. Reset local mock data to recover.');
    cached = saved; return saved;
  }
  const seeded = createMockState();
  await write(seeded, undefined); cached = seeded; return seeded;
}
function aborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  aborted(signal);
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
function successStatus(pathname: string, method: string): number {
  if (method !== 'POST') return 200;
  return /^\/api\/(admin|me)\/projects\/submit$/.test(pathname)
    || /^\/api\/me\/projects\/\d+\/(change-requests|webgl-network-requests)$/.test(pathname)
    || /^\/api\/admin\/projects\/\d+\/members$/.test(pathname)
    || pathname === '/api/admin/banned-ips'
    || /^\/api\/admin\/(projects|exhibitions)\/\d+\/direct-(game|webgl|video|image|poster|document|attachment)-upload-sessions$/.test(pathname)
    ? 201 : 200;
}
function responseError(error: MockHttpError, headers?: HeadersInit): Response {
  return Response.json({ ok: false, error: { code: error.code, message: error.message } }, {
    status: error.status, statusText: ({400:'Bad Request',401:'Unauthorized',403:'Forbidden',404:'Not Found',405:'Method Not Allowed',409:'Conflict',429:'Too Many Requests',500:'Internal Server Error',503:'Service Unavailable'} as Record<number,string>)[error.status] ?? 'Mock Error', headers,
  });
}
export async function mockFetch(path: string, options: MockRequestOptions = {}): Promise<Response> {
  aborted(options.signal);
  return serialized(async () => {
    aborted(options.signal);
    try {
      const previous = await load();
      const draft = cloneMockValue(previous);
      const method = (options.method ?? 'GET').toUpperCase();
      const pathname = new URL(path, 'http://mock.local').pathname;
      await delay(draft.controls.delayMs, options.signal);
      const fault = draft.controls.fault;
      if (fault && (!fault.method || fault.method.toUpperCase() === method) && (!fault.path || path.includes(fault.path))) {
        draft.controls.fault = null; draft.revision += 1;
        aborted(options.signal); await write(draft, previous.revision); cached = draft; notify();
        return responseError(new MockHttpError(fault.status, fault.code, fault.message), fault.retryAfter ? { 'Retry-After': fault.retryAfter } : undefined);
      }
      const result = await dispatchMockRequest(createMockContext(draft), pathname, method, options, path);
      if (result === UNHANDLED) throw new MockHttpError(404, 'NOT_FOUND', `No mock route for ${method} ${pathname}`);
      aborted(options.signal);
      // Serialize before committing: malformed domain output cannot leave a successful mutation behind.
      const response = result instanceof Response ? result : result === undefined
        ? new Response(null, { status: 204 }) : Response.json({ ok: true, data: result }, { status: successStatus(pathname, method) });
      if (semanticallyChanged(previous, draft)) {
        draft.revision += 1;
        await write(draft, previous.revision); cached = draft; notify();
      }
      return response;
    } catch (error) {
      aborted(options.signal);
      if (error instanceof MockHttpError) return responseError(error);
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      return responseError(new MockHttpError(500, 'MOCK_STORAGE_OR_HANDLER_ERROR', error instanceof Error ? error.message : 'Mock request failed'));
    }
  });
}
export function subscribeMockState(listener: () => void): () => void {
  listeners.add(listener);
  if (!channel && typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(DATABASE);
    channel.onmessage = () => {
      void reloadMockState().then(() => { for (const listener of externalListeners) listener(); })
        .catch(() => { for (const item of listeners) item(); });
    };
  }
  return () => listeners.delete(listener);
}
export function subscribeMockExternalChanges(listener: () => void): () => void {
  externalListeners.add(listener);
  const unsubscribe = subscribeMockState(() => undefined);
  return () => { externalListeners.delete(listener); unsubscribe(); };
}
export function getMockState(): MockState | undefined { return cached && cloneMockValue(cached); }
export function reloadMockState(): Promise<MockState> {
  return serialized(async () => { const state = await load(); for (const listener of listeners) listener(); return cloneMockValue(state); });
}
export const getMockSnapshot = reloadMockState;
export function updateMockState(update: (state: MockState) => void): Promise<MockState> {
  return serialized(async () => {
    const previous = await load(); const draft = cloneMockValue(previous); update(draft);
    if (semanticallyChanged(previous, draft)) {
      draft.revision = previous.revision + 1; await write(draft, previous.revision); cached = draft; notify();
    }
    return cloneMockValue(draft);
  });
}
export function resetMockState(): Promise<MockState> {
  return serialized(async () => {
    const previous = await read(); const seeded = createMockState(); seeded.revision = (previous?.revision ?? -1) + 1;
    await write(seeded, previous?.revision); cached = seeded; notify(); return cloneMockValue(seeded);
  });
}
export function selectMockUser(user: MockUserSelection): Promise<MockState> {
  return updateMockState((state) => { state.authUser = user; delete state.authExpiresAt; });
}
export function setMockControls(controls: Partial<MockControls>): Promise<MockState> {
  return updateMockState((state) => Object.assign(state.controls, controls));
}
export function applyMockScenario(scenario: 'default' | 'empty' | 'delayed' | 'failed-worker'): Promise<MockState> {
  return updateMockState((state) => {
    if (scenario === 'default') Object.assign(state, createMockState());
    if (scenario === 'empty') { state.projects = {}; state.exhibitions = []; }
    if (scenario === 'delayed') state.controls.delayMs = 800;
    if (scenario === 'failed-worker') state.controls.worker = 'fail';
  });
}
/** Test-only reload simulation: discard process cache while retaining the database. */
export async function forgetMockCacheForTests(): Promise<void> {
  await queue; cached = undefined;
  if (database) (await database).close(); database = undefined;
}
