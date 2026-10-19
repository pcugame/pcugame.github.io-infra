import { getProjectSubmitApi } from '../api/project-submit';
import { getApiErrorMessage } from '../api';
import { getDirectAssetUploadStatus, waitForDirectAssetReady, type DirectAssetUploadProgress } from '../api/game-upload';
import { createFileSourceIdentity } from '../file-identity';
import { getDirectUploadTask, sessionOf, type DirectUploadTask, type Locator, type Recovery, type SubmissionBinding } from './directUploadTask';
import type { DirectAssetUploadKind, DirectAssetUploadOwner } from '../../contracts';

export type FileUploadPhase = 'waiting' | 'checking' | 'preparing' | 'uploading' | 'transferred' | 'completing' | 'verifying' | 'ready' | 'failed' | 'cancelled' | 'cancelling' | 'cancel-unconfirmed';
export type FileUploadSpec = {
 id: string; owner: DirectAssetUploadOwner; kind: DirectAssetUploadKind;
 file?: File; name: string; size?: number; binding?: SubmissionBinding; legacyKey?: string;
};
export type FileUploadRowState = FileUploadSpec & {
 phase: FileUploadPhase; progress?: DirectAssetUploadProgress; error?: string;
};
type Job = { spec: FileUploadSpec; task?: DirectUploadTask; detach?: () => void; unsubscribe?: () => void; init?: Promise<void>; cancelled?: boolean; cancellation?: Promise<void>; settleCancel?: () => void; cancelVersion?: number; metadataConfirmed?: boolean; selection?: AbortController };
const terminal = new Set(['CANCELLED', 'REJECTED', 'EXPIRED']);

/** Stable file IDs own tasks; the FIFO contains IDs only and never changes display order. */
export class FileUploadQueue {
 private jobs = new Map<string, Job>();
 private rows: FileUploadRowState[] = [];
 private listeners = new Set<() => void>();
 private pending: string[] = [];
 private running: Promise<void> | null = null;
 private activeId: string | null = null;
 private attached = false;
 private epoch = 0;
 private idleWaiters: (() => void)[] = [];
 private onReady?: (id: string) => void;
 setOnReady(callback?: (id: string) => void) { this.onReady = callback; }
 onChange?: (row: FileUploadRowState) => void;
 private scope: string;
 private mode: 'user' | 'admin';
 constructor(scope: string, mode: 'user' | 'admin', ownerKey = '') { this.scope = scope; this.mode = mode; this.ownerKey = ownerKey; }
 readonly ownerKey: string;
 getSnapshot = () => this.rows;
 subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
 private key = (spec: FileUploadSpec) => `pcu.file-upload:${this.scope}:${spec.owner.type}:${spec.owner.id}:${spec.kind}:${spec.id}`;
 private publish(id: string, patch: Partial<FileUploadRowState>) {
  this.rows = this.rows.map(row => row.id === id ? { ...row, ...patch } : row);
  for (const fn of this.listeners) fn();
  const row = this.rows.find(row => row.id === id)!;
  this.onChange?.(row);
 }
 sync(specs: FileUploadSpec[]) {
  for (const spec of specs) {
   const job = this.jobs.get(spec.id);
   if (job) {
    job.spec = { ...job.spec, ...spec, ...(job.metadataConfirmed ? { name: job.spec.name, size: job.spec.size } : {}), binding: spec.binding ?? job.spec.binding, legacyKey: spec.legacyKey ?? job.spec.legacyKey, file: job.spec.file ?? spec.file };
    this.rows = this.rows.map(row => row.id === spec.id ? { ...row, ...job.spec } : row);
    continue;
   }
   this.jobs.set(spec.id, { spec });
   window.sessionStorage.setItem(`${this.key(spec)}:file`, JSON.stringify({ ...spec, file: undefined }));
   let phase: FileUploadPhase = spec.binding?.state === 'READY' ? 'ready' : 'waiting';
   // Keep a confirmed local cancellation across React remounts and refreshes.
   if (phase !== 'ready' && window.sessionStorage.getItem(`${this.key(spec)}:outcome`) === 'cancelled') phase = 'cancelled';
   if (window.sessionStorage.getItem(`${this.key(spec)}:outcome`) === 'ready') phase = 'ready';
   this.rows = [...this.rows, { ...spec, phase }];
   if (phase === 'ready' && spec.size === undefined && spec.binding?.sessionId) void getDirectAssetUploadStatus(spec.binding.sessionId).then(status => {
    if (status.sessionId !== spec.binding?.sessionId || status.generation !== spec.binding.generation || status.owner.id !== spec.owner.id || status.owner.type !== spec.owner.type || status.kind !== spec.kind) return;
    this.publish(spec.id, { size: status.totalBytes, name: status.originalName });
   }).catch(() => undefined);
  }
  for (const fn of this.listeners) fn();
 }
 attach = () => {
  this.attached = true;
  for (const row of this.rows) if (['checking', 'preparing', 'uploading', 'transferred', 'completing', 'verifying'].includes(row.phase)) this.enqueue(row.id);
  return () => {
   this.attached = false; this.epoch++;
   for (const job of this.jobs.values()) { job.selection?.abort(); job.detach?.(); job.unsubscribe?.(); job.detach = undefined; job.unsubscribe = undefined; }
  };
 };
 private recovery(job: Job): Recovery {
  const { spec } = job;
  return { owner: spec.owner, kind: spec.kind, items: spec.binding ? [spec.binding] : [], files: spec.file ? [spec.file] : [], mode: this.mode,
   toSaved: (session, status) => ({ session, originalName: status.originalName, totalBytes: status.totalBytes }) };
 }
 private async initialize(job: Job, candidate?: File) {
  if (job.init) return job.init;
  job.init = (async () => {
   if (!job.task) {
    const spec = candidate ? { ...job.spec, file: candidate } : job.spec;
    if (job.spec.binding && job.spec.binding.id !== job.spec.id) await this.migrateLegacy({ ...spec, legacyKey: this.key({ ...job.spec, id: job.spec.binding.id }) });
    await this.migrateLegacy(spec);
    job.task = getDirectUploadTask(this.scope, this.key(job.spec));
    job.task.identify(job.spec.id);
   }
   if (job.detach || !this.attached) return;
   const task = job.task;
   const id = job.spec.id;
   job.detach = task.attach(job, {
    onCancelSettled: () => undefined,
    onCancelled: () => {
     job.settleCancel?.();
     window.sessionStorage.setItem(`${this.key(job.spec)}:outcome`, 'cancelled');
     this.publish(id, { phase: 'cancelled', error: undefined, progress: undefined });
    },
    onCancelReady: (saved, state) => { void this.observeReady(job, saved, state); },
    onCancelError: (error, state) => { job.settleCancel?.(); this.publish(id, { phase: state ? 'failed' : 'cancel-unconfirmed', error: getApiErrorMessage(error) }); },
   });
   let handoff = task.getSnapshot().handoff;
   job.unsubscribe = task.subscribe(() => {
    const snapshot = task.getSnapshot();
    const phase = snapshot.control === 'completion' ? 'completing' : snapshot.control === 'open' ? undefined : snapshot.control;
    if (snapshot.saved) { const session = sessionOf(snapshot.saved); window.sessionStorage.setItem(`${this.key(job.spec)}:proof`, JSON.stringify({ sourceIdentity: session.sourceIdentity, sourceIdentityAlgorithm: session.sourceIdentityAlgorithm })); }
    if (phase) this.publish(id, { phase, error: snapshot.message ?? undefined });
    if (snapshot.handoff !== handoff) {
     handoff = snapshot.handoff;
     if (this.attached && !job.cancelled && snapshot.saved) this.enqueue(id, true);
    }
   });
  })().finally(() => { job.init = undefined; });
  return job.init;
 }
 /** Move all related records together only after binding and source proof. Never discard ambiguity. */
 private async migrateLegacy(spec: FileUploadSpec) {
  if (!spec.legacyKey || ['', ':creation', ':cancellation'].some(suffix => window.sessionStorage.getItem(this.key(spec) + suffix))) return;
  const old = spec.legacyKey;
  if (old === this.key(spec)) return;
  const raws = ['', ':creation', ':cancellation'].map(suffix => window.sessionStorage.getItem(old + suffix));
  if (!raws.some(Boolean)) return;
  const previous = getDirectUploadTask(this.scope, old);
  if (!previous.canMigrate()) throw new Error('이전 업로드 결과를 먼저 확인한 뒤 재시도해 주세요.');
  const saved: Locator | null = raws[0] ? JSON.parse(raws[0]) : null;
  const creation = raws[1] ? JSON.parse(raws[1]) : null;
  if (creation && creation.scope !== this.scope) throw new Error('이전 업로드 계정 정보를 확인해 주세요.');
  const source = saved ? sessionOf(saved) : creation?.request;
  const owner = saved ? sessionOf(saved).owner : creation?.owner;
  const kind = saved ? sessionOf(saved).kind : creation?.kind;
  if (owner?.type !== spec.owner.type || owner?.id !== spec.owner.id || kind !== spec.kind) throw new Error('이전 업로드 대상이 일치하지 않습니다.');
  if (spec.binding) {
   // Other slots must leave this record for its actual owner, including unknown creates.
   if (creation && (creation.request.submissionItem?.id !== spec.binding.id || creation.request.submissionItem?.clientToken !== spec.binding.clientToken)) return;
   if (saved && (spec.binding.sessionId !== sessionOf(saved).sessionId || spec.binding.generation !== sessionOf(saved).generation)) {
    const submission = await getProjectSubmitApi(this.mode).getSubmission(spec.owner.id);
    const linked = submission.items.find(item => item.id === spec.binding!.id && item.clientToken === spec.binding!.clientToken && item.kind === spec.kind);
    if (linked?.sessionId !== sessionOf(saved).sessionId || linked.generation !== sessionOf(saved).generation) return;
   }
  } else {
   if ([...this.jobs.values()].filter(job => job.spec.kind === spec.kind && job.spec.name === spec.name && job.spec.size === spec.size).length > 1) throw new Error('같은 이름의 이전 업로드를 자동 연결할 수 없습니다. 기존 업로드 기록을 확인해 주세요.');
   if (!spec.file || !source?.sourceIdentity) throw new Error('이전 업로드의 원본 파일을 확인해 주세요.');
   const identity = await createFileSourceIdentity(spec.file);
   if (identity.sourceIdentity !== source.sourceIdentity) throw new Error('이전 업로드 기록과 선택한 파일이 다릅니다. 기존 기록을 확인해 주세요.');
  }
  if (creation && spec.file && (creation.request.originalName !== spec.file.name || creation.request.totalBytes !== spec.file.size || (await createFileSourceIdentity(spec.file)).sourceIdentity !== creation.request.sourceIdentity)) throw new Error('동일한 원본 파일을 선택해 주세요.');
  if (saved) {
   const status = await getDirectAssetUploadStatus(sessionOf(saved).sessionId);
   if (status.generation !== sessionOf(saved).generation || status.owner.type !== spec.owner.type || status.owner.id !== spec.owner.id || status.kind !== spec.kind) throw new Error('이전 업로드 세션이 일치하지 않습니다.');
   if (spec.file && (status.originalName !== spec.file.name || status.totalBytes !== spec.file.size || (await createFileSourceIdentity(spec.file)).sourceIdentity !== status.sourceIdentity)) throw new Error('이전 업로드 원본 파일이 일치하지 않습니다.');
  }
  // No await inside the copy/removal boundary; a second file cannot claim these records.
  if (!previous.canMigrate()) throw new Error('이전 업로드 결과를 먼저 확인한 뒤 재시도해 주세요.');
  if (raws.some((raw, index) => raw !== window.sessionStorage.getItem(old + ['', ':creation', ':cancellation'][index]))) throw new Error('이전 업로드 기록이 변경되었습니다. 다시 확인해 주세요.');
  try {
   for (const [index, suffix] of ['', ':creation', ':cancellation'].entries()) {
    const raw = raws[index];
    if (raw) window.sessionStorage.setItem(this.key(spec) + suffix, index === 1 ? JSON.stringify({ ...creation, fileIndex: 0, operationKey: spec.id }) : raw);
   }
  } catch (error) {
   // A quota failure must not leave a resumable locator without its cancel/create fence.
   for (const suffix of ['', ':creation', ':cancellation']) window.sessionStorage.removeItem(this.key(spec) + suffix);
   throw error;
  }
  for (const suffix of ['', ':creation', ':cancellation']) window.sessionStorage.removeItem(old + suffix);
  window.sessionStorage.removeItem(`${old}:file`);
  previous.retireAfterMigration();
 }
 clearRecoveryMetadata() { for (const job of this.jobs.values()) if (this.rows.find(row => row.id === job.spec.id)?.phase === 'ready') window.sessionStorage.removeItem(`${this.key(job.spec)}:file`); }
 order(ids: string[]) {
  this.rows = [...this.rows].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  for (const fn of this.listeners) fn();
 }
 canDiscardUnstarted(id: string) {
  const job = this.jobs.get(id);
  return !job || (!job.task && !job.init && !['', ':creation', ':cancellation'].some(suffix => window.sessionStorage.getItem(this.key(job.spec) + suffix)));
 }
 discardUnstarted(id: string) {
  const job = this.jobs.get(id);
  if (!this.canDiscardUnstarted(id)) return false;
  if (job) window.sessionStorage.removeItem(`${this.key(job.spec)}:file`);
  this.jobs.delete(id); this.pending = this.pending.filter(value => value !== id);
  this.rows = this.rows.filter(row => row.id !== id);
  for (const fn of this.listeners) fn();
  return true;
 }
 private enqueue(id: string, observe = false) {
  const row = this.rows.find(row => row.id === id);
  if (!row || row.phase === 'ready' || row.phase === 'cancel-unconfirmed' || row.phase === 'cancelling') return;
  if (!observe && this.activeId === id && !['failed', 'cancelled'].includes(row.phase)) return;
  if (!this.pending.includes(id)) { if (observe) this.pending.unshift(id); else this.pending.push(id); }
  if (!observe) this.publish(id, { phase: 'waiting', error: undefined });
  this.drain();
 }
 start = (ids = this.rows.filter(row => row.phase === 'waiting').map(row => row.id)) => {
  for (const id of ids) { if (this.rows.find(row => row.id === id)?.phase === 'failed') this.jobs.get(id)!.cancelled = false; this.enqueue(id); }
  return new Promise<void>(resolve => {
   if (!this.running && !this.pending.length) resolve(); else this.idleWaiters.push(resolve);
  });
 };
 retry = (id: string) => {
  const row = this.rows.find(row => row.id === id);
  if (!row || !['failed', 'cancelled'].includes(row.phase)) return;
  this.jobs.get(id)!.cancelled = false;
  this.jobs.get(id)!.cancelVersion = (this.jobs.get(id)!.cancelVersion ?? 0) + 1;
  window.sessionStorage.removeItem(`${this.key(this.jobs.get(id)!.spec)}:outcome`);
  this.enqueue(id);
 };
 select = async (id: string, file: File) => {
  const job = this.jobs.get(id)!;
  const phase = this.rows.find(row => row.id === id)!.phase;
  if (!['waiting', 'failed', 'cancelled'].includes(phase)) return;
  job.selection?.abort();
  const selection = job.selection = new AbortController();
  const current = () => this.attached && job.selection === selection && !selection.signal.aborted;
  this.publish(id, { phase: 'checking', error: undefined });
  try {
   await this.initialize(job, file);
   if (!current()) return;
   if (file.name !== job.spec.name || (job.spec.size !== undefined && file.size !== job.spec.size)) throw new Error('동일한 원본 파일을 선택해 주세요.');
   if ((job.task!.getSaved() || job.task!.hasUnresolved()) && !await job.task!.matchesFile(file, selection.signal)) throw new Error('동일한 원본 파일을 선택해 주세요.');
   const proof = window.sessionStorage.getItem(`${this.key(job.spec)}:proof`);
   if (proof && (await createFileSourceIdentity(file, { signal: selection.signal })).sourceIdentity !== JSON.parse(proof).sourceIdentity) throw new Error('동일한 원본 파일을 선택해 주세요.');
   if (!current()) return;
   job.spec = { ...job.spec, file, size: file.size };
   this.publish(id, { file, size: file.size, phase, error: undefined });
   if (phase !== 'waiting') this.retry(id);
  } catch (error) { if (current()) this.publish(id, { phase, error: getApiErrorMessage(error) }); }
 };

 cancel = (id: string): Promise<void> => {
  const job = this.jobs.get(id)!;
  if (job.cancellation) return job.cancellation;
  const settled = new Promise<void>(resolve => { job.settleCancel = resolve; });
  const version = job.cancelVersion = (job.cancelVersion ?? 0) + 1;
  job.cancellation = Promise.race([this.cancelJob(id, version), settled]).finally(() => { job.cancellation = undefined; job.settleCancel = undefined; });
  return job.cancellation;
 };
 private cancelJob = async (id: string, version: number) => {
  const job = this.jobs.get(id)!;
  const row = this.rows.find(row => row.id === id)!;
  if (['ready', 'cancelled', 'transferred', 'completing', 'verifying', 'cancelling'].includes(row.phase)) return;
  job.cancelled = true;
  job.selection?.abort();
  this.pending = this.pending.filter(value => value !== id);
  this.publish(id, { phase: 'cancelling', error: undefined });
  try {
   await this.initialize(job);
   // Record intent before any lookup: a late create/rejection must see cancellation.
   await job.task!.cancel(this.recovery(job));
  } catch (error) { if (job.cancelVersion === version && this.rows.find(row => row.id === id)?.phase !== 'cancelled' && this.rows.find(row => row.id === id)?.phase !== 'ready') this.publish(id, { phase: 'cancel-unconfirmed', error: getApiErrorMessage(error) }); }
 };
 cancelAll = () => Promise.all(this.rows.filter(row => row.phase !== 'ready').map(row => this.cancel(row.id)));
 private drain() {
  if (this.running || !this.attached) return;
  const epoch = this.epoch;
  this.running = (async () => {
   while (this.attached && epoch === this.epoch && this.pending.length) {
    const id = this.pending.shift()!;
    if (this.jobs.get(id)!.cancelled || this.rows.find(row => row.id === id)?.phase === 'ready') continue;
    this.activeId = id;
    const job = this.jobs.get(id)!;
    await this.run(job, epoch);
    await job.cancellation;
    this.activeId = null;
   }
  })().finally(() => {
   this.running = null;
   if (this.pending.length && this.attached) this.drain();
   else { for (const resolve of this.idleWaiters.splice(0)) resolve(); }
  });
 }
 private async observeReady(job: Job, saved: Locator, state: 'READY' | 'COMPLETING' | 'VERIFYING') {
  const task = job.task!;
  const session = sessionOf(saved);
  const epoch = this.epoch;
  const run = task.beginRun();
  if (!run) { this.publish(job.spec.id, { phase: 'failed', error: '완료 결과를 다시 확인해 주세요.' }); job.settleCancel?.(); return; }
  job.cancelled = false;
  this.publish(job.spec.id, { phase: state === 'COMPLETING' ? 'completing' : 'verifying', error: undefined });
  try {
   if (job.spec.file && !await task.matchesFile(job.spec.file)) throw new Error('동일한 원본 파일을 선택해 주세요.');
   if (state !== 'READY') await waitForDirectAssetReady(session.sessionId, { signal: run.controller.signal,
    onStatus: status => { if (epoch === this.epoch) this.publish(job.spec.id, { phase: status.state === 'COMPLETING' ? 'completing' : 'verifying' }); } });
   if (epoch !== this.epoch || !this.attached || !task.acceptReady(run, session.sessionId, session.generation)) return;
   window.sessionStorage.setItem(`${this.key(job.spec)}:outcome`, 'ready');
   this.publish(job.spec.id, { phase: 'ready', error: undefined });
   this.onReady?.(job.spec.id);
  } catch (error) { if (epoch === this.epoch && !run.controller.signal.aborted) this.publish(job.spec.id, { phase: 'failed', error: getApiErrorMessage(error) }); }
  finally { task.finishRun(run.token); job.settleCancel?.(); }
 }
 private async run(job: Job, epoch: number) {
  const id = job.spec.id;
  let run: ReturnType<DirectUploadTask['beginRun']> = null;
  const current = () => this.attached && epoch === this.epoch && !job.cancelled;
  try {
   this.publish(id, { phase: 'preparing', error: undefined });
   await this.initialize(job);
   if (!current()) return;
   const task = job.task!;
   let saved = await task.restore(this.recovery(job));
   if (!current()) return;
   if (saved === undefined) throw new Error('업로드 생성 결과를 확인한 뒤 재시도해 주세요.');
   run = task.beginRun();
   if (!run) throw new Error(task.getSnapshot().message ?? '기존 업로드 결과를 확인해 주세요.');
   const signal = run.controller.signal;
   let ready: { sessionId: string; generation: number } | undefined;
   if (saved) {
    const session = sessionOf(saved);
    const status = await getDirectAssetUploadStatus(session.sessionId, signal);
    if (!current() || !task.isCurrentRun(run.token)) return;
    if (status.sessionId !== session.sessionId || status.generation !== session.generation || status.owner.type !== job.spec.owner.type || status.owner.id !== job.spec.owner.id || status.kind !== job.spec.kind) throw new Error('파일 업로드 세션이 일치하지 않습니다.');
    job.metadataConfirmed = true;
    job.spec = { ...job.spec, name: status.originalName, size: status.totalBytes };
    window.sessionStorage.setItem(`${this.key(job.spec)}:file`, JSON.stringify({ ...job.spec, file: undefined }));
    this.publish(id, { name: status.originalName, size: status.totalBytes });
    if (status.state === 'UPLOADING') {
     const confirmedBytes = status.parts.reduce((sum, part) => sum + part.sizeBytes, 0);
     this.publish(id, { progress: { phase: 'checking', uploadedBytes: confirmedBytes, confirmedBytes, inFlightBytes: 0, totalBytes: status.totalBytes, uploadedChunks: status.parts.length, totalChunks: status.totalParts, percent: Math.min(99, Math.floor(confirmedBytes / status.totalBytes * 100)) } });
    }
    if (job.spec.file && !await task.matchesFile(job.spec.file)) throw new Error('동일한 원본 파일을 선택해 주세요.');
    if (status.state === 'READY' || status.state === 'VERIFYING' || status.state === 'COMPLETING') {
     this.publish(id, { phase: status.state === 'COMPLETING' ? 'completing' : 'verifying' });
     if (status.state !== 'READY') await waitForDirectAssetReady(session.sessionId, { signal, onStatus: status => { if (current()) this.publish(id, { phase: status.state === 'COMPLETING' ? 'completing' : 'verifying' }); } });
     ready = session;
    } else if (terminal.has(status.state)) {
     if (!task.forget(session.sessionId)) throw new Error('취소 결과를 먼저 확인해 주세요.');
     saved = null;
    } else if (status.state !== 'UPLOADING') throw new Error('서버에서 업로드 준비 중입니다. 잠시 후 재시도해 주세요.');
   }
   if (!ready) {
    const file = job.spec.file;
    if (!file) throw new Error('동일한 원본 파일을 다시 선택해 주세요.');
    const completion = await task.transfer(run, [job.spec.owner, file, job.spec.kind, progress => {
     if (current()) this.publish(id, { progress, phase: progress.phase === 'ready' ? 'verifying' : progress.phase ?? 'uploading' });
    }, { ...(saved ? { resume: sessionOf(saved) } : {}), ...(job.spec.binding ? { submissionItem: { id: job.spec.binding.id, clientToken: job.spec.binding.clientToken } } : {}) }], session => ({ session, originalName: file.name, totalBytes: file.size }), id);
    if (!current() || !task.isCurrentRun(run.token)) return;
    if (completion.status !== 'READY') {
     this.publish(id, { phase: 'verifying' });
     await waitForDirectAssetReady(completion.sessionId, { signal, onStatus: status => { if (current()) this.publish(id, { phase: status.state === 'COMPLETING' ? 'completing' : 'verifying' }); } });
    }
    ready = completion;
   }
   if (!current() || !task.acceptReady(run, ready.sessionId, ready.generation)) return;
   window.sessionStorage.setItem(`${this.key(job.spec)}:outcome`, 'ready');
   this.publish(id, { phase: 'ready', error: undefined });
   this.onReady?.(id);
  } catch (error) {
   if (current() && (!run || (job.task?.isCurrentRun(run.token) && !run.controller.signal.aborted))) {
    const control = job.task?.getSnapshot().control;
    this.publish(id, { phase: control === 'cancel-unconfirmed' ? control : 'failed', error: getApiErrorMessage(error) });
   }
  } finally { if (run) job.task?.finishRun(run.token); }
 }
}
