import {
	cancelDirectAssetUploadSession, getDirectAssetUploadStatus, uploadDirectAssetFile,
	type DirectAssetUploadSession, type DirectAssetUploadProgress,
} from '../api/game-upload';
import { getProjectSubmitApi } from '../api/project-submit';
import { createFileSourceIdentity } from '../file-identity';
import type { DirectAssetUploadKind, DirectAssetUploadOwner } from '../../contracts';

export type UploadRun = { token: number; controller: AbortController };
export type Locator = DirectAssetUploadSession | { session: DirectAssetUploadSession };
type Status = Awaited<ReturnType<typeof getDirectAssetUploadStatus>>;
export type SubmissionBinding = { id: string; clientToken: string; sessionId?: string; generation?: number; state?: string };
export type Recovery = {
	owner: DirectAssetUploadOwner; kind: DirectAssetUploadKind;
	items: readonly SubmissionBinding[]; files: readonly File[];
	toSaved: (session: DirectAssetUploadSession, status: Status, index: number) => Locator;
	mode: 'admin' | 'user';
};
export type TaskCallbacks<Saved> = {
	onCancelled?: () => void;
	onCancelReady: (saved: Saved, state: 'READY' | 'COMPLETING' | 'VERIFYING', status: Status) => void;
	onCancelError: (cause: unknown, terminalState?: 'REJECTED' | 'EXPIRED', status?: Status) => void;
	onCancelSettled: () => void;
};
export const sessionOf = (value: Locator): DirectAssetUploadSession => 'session' in value ? value.session : value;
const tasks = new Map<string, DirectUploadTask>();
const recoveryMessage = '업로드 생성 결과를 확인 중입니다. 결과가 확인되면 이어올리기 또는 취소할 수 있습니다.';

/** One in-memory job owns the unresolved control request, independently of React. */
export class DirectUploadTask {
	private listeners = new Set<() => void>();
	private observers = new Map<object, TaskCallbacks<Locator>>();
	private serial = 0;
	private active: UploadRun | null = null;
	private pending = false;
	private uncertain = false;
	private recoveryBlocked = false;
	private deleting = false;
	private cancellation = false;
	private epoch = 0;
	private sourceFile: File | null = null;
	private operationKey: string | undefined;
	private identityAssigned = false;
	private bindingId: string | undefined;
	private closed = new Set<string>();
	private accepted = new Set<string>();
	private recoveryRequest: Promise<Locator | null> | null = null;
	private outcome: { saved: Locator; state: 'READY' | 'COMPLETING' | 'VERIFYING'; status: Status } | 'cancelled' | null = null;
	private snapshot: { saved: Locator | null; message: string | null; progress: DirectAssetUploadProgress | null; handoff: number } = {
		saved: null, message: null, progress: null, handoff: 0,
	};
	private key: string;
	private storageKey: string;
	constructor(key: string, storageKey: string) {
		this.key = key; this.storageKey = storageKey;
		const raw = window.sessionStorage.getItem(storageKey);
		if (raw) {
			try {
				const value = JSON.parse(raw) as Locator;
				const session = value && typeof value === 'object' ? sessionOf(value) : null;
				if (session && typeof session.sessionId === 'string' && Number.isSafeInteger(session.generation)
					&& session.owner && ['PROJECT', 'EXHIBITION'].includes(session.owner.type) && typeof session.kind === 'string') this.snapshot.saved = value;
			} catch { /* Invalid local data grants no session authority. */ }
		}
	}
	disposeForTests = () => { this.epoch++; this.pause(); };
	getSnapshot = () => this.snapshot;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};
	private publish = (patch: Partial<typeof this.snapshot> = {}) => {
		this.snapshot = { ...this.snapshot, ...patch };
		for (const listener of this.listeners) listener();
	};
	attach = (id: object, callbacks: TaskCallbacks<Locator>) => {
		if (!tasks.has(this.key)) tasks.set(this.key, this);
		this.observers.set(id, callbacks);
		this.deliver();
		return () => {
			this.observers.delete(id);
			if (!this.observers.size) this.pause();
			this.release();
		};
	};
	private observer = () => [...this.observers.values()].at(-1);
	private release = () => {
		if (!this.observers.size && !this.pending && !this.deleting && !this.uncertain && !this.recoveryBlocked && !this.snapshot.saved && !this.recoveryRequest && !this.outcome) {
			if (tasks.get(this.key) === this) tasks.delete(this.key);
		}
	};
	private deliver = () => {
		const observer = this.observer();
		if (!observer || !this.outcome) return;
		const outcome = this.outcome;
		this.outcome = null;
		if (outcome === 'cancelled') {
			observer.onCancelSettled();
			observer.onCancelled?.();
		} else observer.onCancelReady(outcome.saved, outcome.state, outcome.status);
	};
	identify = (operationKey?: string) => {
		if (!this.identityAssigned) { this.operationKey = operationKey; this.identityAssigned = true; }
	};
	matchesOperation = (operationKey?: string) => this.operationKey === operationKey;
	matchesFile = async (file: File) => {
		if (!this.sourceFile || this.sourceFile === file) return true;
		if (file.name !== this.sourceFile.name || file.size !== this.sourceFile.size) return false;
		const saved = this.snapshot.saved;
		if (!saved) return false;
		try { return (await createFileSourceIdentity(file)).sourceIdentity === sessionOf(saved).sourceIdentity; }
		catch { return false; }
	};
	getSaved = () => this.snapshot.saved;
	isPendingCreate = () => this.pending;
	hasUnresolved = () => this.pending || this.uncertain || this.recoveryBlocked;
	remember = (saved: Locator) => {
		const session = sessionOf(saved);
		if (this.closed.has(`${session.sessionId}:${session.generation}`)) return;
		this.uncertain = false;
		this.recoveryBlocked = false;
		window.sessionStorage.setItem(this.storageKey, JSON.stringify(saved));
		this.publish({ saved, message: null });
	};
	forget = (sessionId: string) => {
		const saved = this.snapshot.saved;
		if (!saved || sessionOf(saved).sessionId !== sessionId) return false;
		this.closed.add(`${sessionId}:${sessionOf(saved).generation}`);
		if (window.sessionStorage.getItem(this.storageKey) === JSON.stringify(saved)) window.sessionStorage.removeItem(this.storageKey);
		this.sourceFile = null;
		this.publish({ saved: null, progress: null });
		this.release();
		return true;
	};
	beginRun = (): UploadRun | null => {
		if (this.active || this.pending || this.deleting || ((this.uncertain || this.recoveryBlocked) && !this.snapshot.saved) || !this.observers.size) return null;
		const run = { token: ++this.serial, controller: new AbortController() };
		this.active = run;
		return run;
	};
	isCurrentRun = (token: number) => this.active?.token === token;
	finishRun = (token: number) => { if (this.isCurrentRun(token)) this.active = null; };
	pause = () => {
		const run = this.active;
		this.active = null;
		run?.controller.abort();
	};
	acceptReady = (run: UploadRun, sessionId: string, generation: number) => {
		const key = `${sessionId}:${generation}`;
		const current = this.snapshot.saved ? sessionOf(this.snapshot.saved) : null;
		if (!this.isCurrentRun(run.token) || this.accepted.has(key) || this.closed.has(key)
			|| (current && (current.sessionId !== sessionId || current.generation !== generation))) return false;
		this.accepted.add(key);
		this.epoch++;
		this.cancellation = false;
		this.forget(sessionId);
		return true;
	};
	private finishCancellation = () => {
		if (!this.cancellation || this.pending || this.deleting || this.uncertain || this.recoveryBlocked || this.snapshot.saved) return;
		this.cancellation = false;
		this.epoch++;
		this.publish({ message: null, progress: null });
		this.outcome = 'cancelled';
		this.deliver();
		this.release();
	};
	private cancelSaved = async (candidate: Locator) => {
		if (this.deleting) return;
		this.deleting = true;
		const epoch = this.epoch;
		const session = sessionOf(candidate);
		const current = () => epoch === this.epoch && this.snapshot.saved !== null
			&& sessionOf(this.snapshot.saved).sessionId === session.sessionId;
		try {
			await cancelDirectAssetUploadSession(session.sessionId);
			if (current()) this.forget(session.sessionId);
		} catch (cause) {
			try {
				const status = await getDirectAssetUploadStatus(session.sessionId);
				if (!current()) return;
				if (status.sessionId !== session.sessionId || status.generation !== session.generation
					|| status.kind !== session.kind || status.owner.type !== session.owner.type || status.owner.id !== session.owner.id) throw cause;
				if (status.state === 'CANCELLED') this.forget(session.sessionId);
				else if (status.state === 'READY' || status.state === 'COMPLETING' || status.state === 'VERIFYING') {
					this.cancellation = false;
					this.outcome = { saved: candidate, state: status.state, status };
				} else {
					this.publish({ message: '취소를 확인하지 못했습니다. 세션 상태를 확인하고 다시 시도해 주세요.' });
					this.observer()?.onCancelError(cause, status.state === 'REJECTED' || status.state === 'EXPIRED' ? status.state : undefined, status);
				}
			} catch {
				if (current()) {
					this.publish({ message: '취소 결과를 확인하지 못했습니다. 연결이 복구되면 다시 취소하거나 이어올리기를 선택해 주세요.' });
					this.observer()?.onCancelError(cause);
				}
			}
		} finally {
			this.deleting = false;
			this.finishCancellation();
			this.deliver();
			this.release();
		}
	};
	cancel = async () => {
		if (this.deleting) return;
		this.cancellation = true;
		this.pause();
		if (this.snapshot.saved) await this.cancelSaved(this.snapshot.saved);
		else this.finishCancellation();
	};
	transfer = async (run: UploadRun, args: Parameters<typeof uploadDirectAssetFile>, toSaved: (session: DirectAssetUploadSession) => Locator, operationKey?: string) => {
		const [owner, file, kind, onProgress, options = {}] = args;
		const epoch = this.epoch;
		if (!this.isCurrentRun(run.token)) throw new DOMException('Aborted', 'AbortError');
		if (!options.resume && (this.pending || this.uncertain || this.snapshot.saved)) throw new Error('기존 업로드 결과를 먼저 확인해 주세요.');
		if (!options.resume) { this.pending = true; this.sourceFile = file; this.operationKey = operationKey; this.identityAssigned = true; }
		let received = false;
		try {
			return await uploadDirectAssetFile(owner, file, kind, progress => {
				if (epoch !== this.epoch || !this.isCurrentRun(run.token)) return;
				this.publish({ progress });
				if (this.isCurrentRun(run.token)) onProgress?.(progress);
			}, { ...options, signal: run.controller.signal, onSession: session => {
				if (received || epoch !== this.epoch) return;
				received = true;
				this.pending = false;
				this.bindingId = options.submissionItem?.id;
				this.remember(toSaved(session));
				if (!this.isCurrentRun(run.token) && !this.cancellation) this.publish({ handoff: this.snapshot.handoff + 1 });
				if (this.cancellation) void this.cancelSaved(this.snapshot.saved!);
			} });
		} catch (cause) {
			if (epoch === this.epoch && !received && typeof cause === 'object' && cause !== null && 'uncertain' in cause && cause.uncertain) {
				this.uncertain = true;
				this.publish({ message: recoveryMessage, handoff: this.snapshot.handoff + 1 });
			}
			throw cause;
		} finally {
			if (epoch === this.epoch) {
				this.pending = false;
				this.finishCancellation();
			}
			this.release();
		}
	};
	restore = (recovery?: Recovery): Promise<Locator | null> => {
		if (this.pending) {
			this.publish({ message: recoveryMessage });
			return Promise.resolve(null);
		}
		if (!recovery?.items.length || (this.snapshot.saved && this.bindingId && recovery.items.some(item => item.id === this.bindingId))) return Promise.resolve(this.snapshot.saved);
		if (this.recoveryRequest) return this.recoveryRequest;
		const epoch = this.epoch;
		this.recoveryRequest = (async () => {
			const submission = !this.uncertain && recovery.items.every(item => item.state !== undefined)
				? { projectId: recovery.owner.id, items: recovery.items.map(item => ({ ...item, kind: recovery.kind })) }
				: await getProjectSubmitApi(recovery.mode).getSubmission(recovery.owner.id);
			if (submission.projectId !== recovery.owner.id || epoch !== this.epoch) throw new Error('제출 항목이 일치하지 않습니다.');
			for (let index = 0; index < recovery.items.length; index++) {
				const binding = recovery.items[index]!;
				const item = submission.items.find(item => item.id === binding.id && item.clientToken === binding.clientToken && item.kind === recovery.kind);
				if (!item) throw new Error('제출 항목을 확인할 수 없습니다.');
				if (!item.sessionId || item.generation === undefined) continue;
				const status = await getDirectAssetUploadStatus(item.sessionId);
				if (epoch !== this.epoch) return null;
				if (status.sessionId !== item.sessionId || status.generation !== item.generation || status.kind !== recovery.kind
					|| status.owner.type !== recovery.owner.type || status.owner.id !== recovery.owner.id) throw new Error('제출 업로드 세션이 일치하지 않습니다.');
				const file = recovery.files[index];
				if (file) {
					const source = await createFileSourceIdentity(file);
					if (file.name !== status.originalName || file.size !== status.totalBytes || source.sourceIdentity !== status.sourceIdentity) throw new Error('중단된 제출 파일과 선택한 파일이 일치하지 않습니다.');
				}
				if (epoch !== this.epoch) return null;
				this.bindingId = binding.id;
				const session: DirectAssetUploadSession = {
					sessionId: status.sessionId, generation: status.generation, owner: status.owner, kind: status.kind,
					partSizeBytes: status.partSizeBytes, totalParts: status.totalParts, expiresAt: status.expiresAt,
					sourceIdentityAlgorithm: status.sourceIdentityAlgorithm, sourceIdentity: status.sourceIdentity,
				};
				this.remember(recovery.toSaved(session, status, index));
				if (this.cancellation) await this.cancelSaved(this.snapshot.saved!);
				return this.snapshot.saved;
			}
			if (this.snapshot.saved) throw new Error('저장된 세션이 현재 제출 항목과 연결되지 않았습니다. 제출 상태를 다시 확인해 주세요.');
			// No linked session does not prove an ambiguous create failed: keep responsibility.
			if (this.uncertain) this.publish({ message: recoveryMessage });
			return null;
		})().catch(cause => {
			if (epoch === this.epoch) {
				this.recoveryBlocked = true;
				this.publish({ message: cause instanceof Error && cause.message ? cause.message : recoveryMessage });
			}
			throw cause;
		}).finally(() => { this.recoveryRequest = null; this.release(); });
		return this.recoveryRequest;
	};
}
export function getDirectUploadTask(scope: string, storageKey: string) {
	const key = `${scope}:${storageKey}`;
	let task = tasks.get(key);
	if (!task) { task = new DirectUploadTask(key, storageKey); tasks.set(key, task); }
	return task;
}

/** Test harness teardown also fences responses still held by deferred transports. */
export function resetDirectUploadTasksForTests() {
	for (const task of tasks.values()) task.disposeForTests();
	tasks.clear();
}
