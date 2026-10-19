import {
	cancelDirectAssetUploadSession, getDirectAssetUploadStatus, uploadDirectAssetFile,
	getDirectAssetUploadCreation, createDirectAssetUploadSession, DirectUploadAllocationPendingError, isDirectUploadPreCreationRejection,
	type DirectAssetUploadSession, type DirectAssetUploadProgress, type DirectUploadCreateRequest,
} from '../api/game-upload';
import { ApiError } from '../api/client';
import { getProjectSubmitApi } from '../api/project-submit';
import { createFileSourceIdentity } from '../file-identity';
import type { DirectAssetUploadKind, DirectAssetUploadOwner } from '../../contracts';

export type UploadRun = { token: number; controller: AbortController };
export type Locator = DirectAssetUploadSession | { session: DirectAssetUploadSession; originalName?: string; totalBytes?: number };
type Status = Awaited<ReturnType<typeof getDirectAssetUploadStatus>>;
export type SubmissionBinding = { id: string; clientToken: string; sessionId?: string; generation?: number; state?: string };
export type Recovery = {
	owner: DirectAssetUploadOwner; kind: DirectAssetUploadKind;
	items: readonly SubmissionBinding[]; files: readonly File[];
	toSaved: (session: DirectAssetUploadSession, status: Status, index: number) => Locator;
	mode: 'admin' | 'user';
};
type CreationRecord = {
	version: 1; scope: string; owner: DirectAssetUploadOwner; kind: DirectAssetUploadKind;
	request: DirectUploadCreateRequest; fileIndex: number; operationKey?: string;
	cancelRequested?: boolean; conflict?: boolean;
};
export type TaskCallbacks<Saved> = {
	onCancelled?: () => void;
	onCancelReady: (saved: Saved, state: 'READY' | 'COMPLETING' | 'VERIFYING', status: Status) => void;
	onCancelError: (cause: unknown, terminalState?: 'REJECTED' | 'EXPIRED', status?: Status) => void;
	onCancelSettled: () => void;
};
export const sessionOf = (value: Locator): DirectAssetUploadSession => 'session' in value ? value.session : value;
const tasks = new Map<string, DirectUploadTask>();
type ControlState = 'open' | 'cancelling' | 'cancel-unconfirmed' | 'completion';
const cancellingMessage = '취소 처리 중입니다. 결과가 확인될 때까지 이어올릴 수 없습니다.';
const cancelUnconfirmedMessage = '취소 결과가 미확정이므로 이어올릴 수 없습니다. 연결이 복구되면 취소를 다시 시도해 주세요.';
const completionMessage = '서버에서 완료 처리 중입니다. 이어올리기를 중단하고 완료 결과를 확인합니다.';
export const fileVerificationMessage = '선택한 파일이 원본과 일치하는지 확인할 수 없습니다. 원본 파일을 다시 선택하거나 기존 업로드 상태를 확인해 주세요.';
const recoveryMessage = '업로드 생성 결과를 확인하지 못했습니다. 연결이 복구되면 재시도하거나 취소해 주세요.';
function waitForCancelObservation(signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		const done = () => { window.clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
		const timer = window.setTimeout(done, 1_500);
		signal.addEventListener('abort', done, { once: true });
		if (signal.aborted) done();
	});
}

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
	private cancellationSettled = false;
	private get cancellation() { return this.snapshot.control !== 'open'; }
	private cancellationRaw: string | null = null;
	private cancelObservation: AbortController | null = null;
	private epoch = 0;
	private sourceFile: File | null = null;
	private creation: CreationRecord | null = null;
	private clientUploadId: string | undefined;
	private legacyUnresolved = false;
	private creationKey: string;
	private creationRaw: string | null = null;
	private scope: string;
	private operationKey: string | undefined;
	private identityAssigned = false;
	private bindingId: string | undefined;
	private closed = new Set<string>();
	private accepted = new Set<string>();
	private recoveryRequest: Promise<Locator | null | undefined> | null = null;
	private outcome: { saved: Locator; state: 'READY' | 'COMPLETING' | 'VERIFYING'; status: Status } | 'cancelled' | null = null;
	private snapshot: { saved: Locator | null; message: string | null; progress: DirectAssetUploadProgress | null; handoff: number; control: ControlState } = {
		saved: null, message: null, progress: null, handoff: 0, control: 'open',
	};
	private key: string;
	private storageKey: string;
	constructor(key: string, storageKey: string, scope: string) {
		this.key = key; this.storageKey = storageKey; this.scope = scope;
		this.creationKey = `${storageKey}:creation`;
		const creationRaw = window.sessionStorage.getItem(this.creationKey);
		if (creationRaw) {
			try {
				const record = JSON.parse(creationRaw) as CreationRecord;
				if (record.version !== 1 || record.scope !== scope || !record.request?.clientUploadId
					|| !record.owner || !record.kind || !Number.isSafeInteger(record.fileIndex) || record.fileIndex < 0) throw new Error('Unsupported creation record');
				this.creation = record; this.creationRaw = creationRaw;
				this.clientUploadId = record.request.clientUploadId;
				this.operationKey = record.operationKey; this.identityAssigned = true;
				this.snapshot.control = record.cancelRequested ? 'cancel-unconfirmed' : 'open'; this.uncertain = true;
				this.snapshot.message = record.cancelRequested ? cancelUnconfirmedMessage : recoveryMessage;
			} catch {
				this.legacyUnresolved = true;
				this.snapshot.message = '이전 업로드 기록의 식별자 또는 사용자 정보를 확인할 수 없습니다. 원래 계정이나 제출 상태에서 확인해 주세요.';
			}
		}
		const raw = window.sessionStorage.getItem(storageKey);
		if (raw) {
			try {
				const value = JSON.parse(raw) as Locator;
				const session = value && typeof value === 'object' ? sessionOf(value) : null;
				if (session && typeof session.sessionId === 'string' && Number.isSafeInteger(session.generation)
					&& session.owner && ['PROJECT', 'EXHIBITION'].includes(session.owner.type) && typeof session.kind === 'string') {
					if (!this.legacyUnresolved) this.snapshot.saved = value;
				} else this.legacyUnresolved = true;
			} catch { this.legacyUnresolved = true; }
			if (this.legacyUnresolved) this.snapshot.message ??= '이전 업로드 기록에 복구 식별자가 없습니다. 제출 상태 또는 관리자 확인이 필요합니다.';
		}
		const cancellationRaw = window.sessionStorage.getItem(`${storageKey}:cancellation`);
		if (cancellationRaw) {
			this.cancellationRaw = cancellationRaw;
			try {
				const record = JSON.parse(cancellationRaw);
				const saved = this.snapshot.saved && sessionOf(this.snapshot.saved);
				if (record.scope !== scope || !saved || record.sessionId !== saved.sessionId || record.generation !== saved.generation) throw new Error('Cancellation identity mismatch');
				this.snapshot.control = 'cancel-unconfirmed';
				this.snapshot.message = cancelUnconfirmedMessage;
			} catch {
				this.legacyUnresolved = true;
				this.snapshot.message = '취소 기록과 업로드 세션이 일치하지 않습니다. 관리자 확인이 필요합니다.';
			}
		}
	}
	/** A durable locator may move only after its old view and control requests release ownership. */
	canMigrate = () => !this.observers.size && !this.pending && !this.deleting && !this.recoveryRequest && !this.cancelObservation;
	retireAfterMigration = () => {
		if (!this.canMigrate()) throw new Error('이전 업로드 결과를 먼저 확인해 주세요.');
		this.epoch++;
		this.pause();
		if (tasks.get(this.key) === this) tasks.delete(this.key);
	};
	disposeForTests = () => { this.epoch++; this.pause(); this.cancelObservation?.abort(); };
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
		if (!this.observers.size && !this.pending && !this.deleting && !this.uncertain && !this.recoveryBlocked && !this.snapshot.saved && !this.recoveryRequest && !this.outcome && !this.creation && !this.legacyUnresolved) {
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
	matchesFile = async (file: File, signal?: AbortSignal) => {
		const epoch = this.epoch;
		const saved = this.snapshot.saved;
		const metadata = this.creation?.request ?? (saved && 'session' in saved ? saved : null);
		if (metadata && ((metadata.originalName !== undefined && file.name !== metadata.originalName)
			|| (metadata.totalBytes !== undefined && file.size !== metadata.totalBytes))) return false;
		if (this.sourceFile && (file.name !== this.sourceFile.name || file.size !== this.sourceFile.size)) return false;
		// The same immutable File is proof only while the original reference survives.
		if (this.sourceFile === file) return true;
		const expected = saved ? sessionOf(saved) : this.creation?.request;
		// Legacy locators without identity remain recoverable/cancellable, but cannot
		// identify a newly selected file. Never infer a match from a missing File.
		if (!expected?.sourceIdentity || expected.sourceIdentityAlgorithm !== 'SHA256_BLOCK_MANIFEST_V1') return false;
		try {
			const source = signal ? await createFileSourceIdentity(file, { signal }) : await createFileSourceIdentity(file);
			return epoch === this.epoch && this.snapshot.saved === saved
				&& source.sourceIdentityAlgorithm === expected.sourceIdentityAlgorithm && source.sourceIdentity === expected.sourceIdentity;
		} catch { return false; }
	};
	getSaved = () => this.snapshot.saved;
	isPendingCreate = () => this.pending;
	hasUnresolved = () => this.pending || this.uncertain || this.recoveryBlocked || this.legacyUnresolved || Boolean(this.creation && !this.snapshot.saved);
	private persistCreation = (record: CreationRecord) => {
		const raw = JSON.stringify(record);
		window.sessionStorage.setItem(this.creationKey, raw);
		this.creation = record; this.creationRaw = raw;
	};
	private clearCreation = () => {
		if (this.creationRaw && window.sessionStorage.getItem(this.creationKey) === this.creationRaw) window.sessionStorage.removeItem(this.creationKey);
		this.creation = null; this.creationRaw = null; this.clientUploadId = undefined;
	};
	private persistCancellation = (saved: Locator) => {
		const { sessionId, generation } = sessionOf(saved);
		const raw = JSON.stringify({ scope: this.scope, sessionId, generation });
		window.sessionStorage.setItem(`${this.storageKey}:cancellation`, raw);
		this.cancellationRaw = raw;
	};
	private clearCancellation = () => {
		if (this.cancellationRaw && window.sessionStorage.getItem(`${this.storageKey}:cancellation`) === this.cancellationRaw) window.sessionStorage.removeItem(`${this.storageKey}:cancellation`);
		this.cancellationRaw = null;
	};
	private settleCancelIntent = () => {
		// Fence transport callbacks from before cancellation, including resumed onSession.
		this.epoch++;
		this.clearCancellation();
		if (this.creation) this.persistCreation({ ...this.creation, cancelRequested: false });
		this.publish({ control: 'open', message: null });
	};

	remember = (saved: Locator) => {
		const session = sessionOf(saved);
		if (this.closed.has(`${session.sessionId}:${session.generation}`)) return;
		this.cancellationSettled = false;
		this.uncertain = false;
		this.recoveryBlocked = false;
		window.sessionStorage.setItem(this.storageKey, JSON.stringify(saved));
		if (this.cancellation) this.persistCancellation(saved);
		this.publish({ saved, ...(this.snapshot.control === 'open' ? { message: null } : {}) });
	};
	// A view cannot discard an unresolved DELETE by requesting a new upload.
	forget = (sessionId: string) => this.snapshot.control === 'open' && this.closeSaved(sessionId);
	private closeSaved = (sessionId: string) => {
		const saved = this.snapshot.saved;
		if (!saved || sessionOf(saved).sessionId !== sessionId) return false;
		this.closed.add(`${sessionId}:${sessionOf(saved).generation}`);
		this.epoch++;
		if (window.sessionStorage.getItem(this.storageKey) === JSON.stringify(saved)) window.sessionStorage.removeItem(this.storageKey);
		this.sourceFile = null;
		this.clearCreation();
		this.clearCancellation();
		this.uncertain = false; this.recoveryBlocked = false;
		this.publish({ saved: null, progress: null, message: null });
		this.release();
		return true;
	};
	beginRun = (): UploadRun | null => {
		if (this.snapshot.control !== 'open' || this.active || this.pending || this.deleting || (this.legacyUnresolved || ((this.uncertain || this.recoveryBlocked) && !this.snapshot.saved && !this.creation)) || !this.observers.size) return null;
		this.epoch++;
		this.cancellationSettled = false;
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
		this.publish({ control: 'open' });
		this.closeSaved(sessionId);
		return true;
	};
	private finishCancellation = () => {
		if (!this.cancellation || this.pending || this.deleting || this.uncertain || this.recoveryBlocked || this.legacyUnresolved || this.creation || this.snapshot.saved) return;
		this.epoch++;
		this.cancellationSettled = true;
		this.publish({ control: 'open', message: null, progress: null });
		this.outcome = 'cancelled';
		this.deliver();
		this.release();
	};
	private cancelSaved = async (candidate: Locator) => {
		if (this.deleting || !this.cancellation) return;
		this.persistCancellation(candidate);
		this.deleting = true;
		this.publish({ control: 'cancelling', message: cancellingMessage });
		const epoch = this.epoch;
		const observation = new AbortController();
		this.cancelObservation = observation;
		const session = sessionOf(candidate);
		const current = () => epoch === this.epoch && this.snapshot.saved !== null
			&& sessionOf(this.snapshot.saved).sessionId === session.sessionId
			&& sessionOf(this.snapshot.saved).generation === session.generation;
		try {
			await cancelDirectAssetUploadSession(session.sessionId);
			if (current()) this.closeSaved(session.sessionId);
		} catch (cause) {
			try {
				let status: Status;
				for (;;) {
					status = await getDirectAssetUploadStatus(session.sessionId, AbortSignal.any([observation.signal, AbortSignal.timeout(15_000)]));
					if (!current()) return;
					if (status.sessionId !== session.sessionId || status.generation !== session.generation
						|| status.kind !== session.kind || status.owner.type !== session.owner.type || status.owner.id !== session.owner.id) throw cause;
					if (status.state !== 'COMPLETING') break;
					// COMPLETING can revert to UPLOADING while an earlier DELETE is delayed.
					// Keep ownership here until a safe outcome, rather than starting a view run.
					this.publish({ control: 'completion', message: completionMessage });
					await waitForCancelObservation(observation.signal);
					if (!current()) return;
				}
				if (status.state === 'CANCELLED') this.closeSaved(session.sessionId);
				else if (status.state === 'READY' || status.state === 'VERIFYING') {
					this.settleCancelIntent();
					this.outcome = { saved: candidate, state: status.state, status };
				} else {
					if (status.state === 'REJECTED' || status.state === 'EXPIRED') this.settleCancelIntent();
					else this.publish({ control: 'cancel-unconfirmed', message: cancelUnconfirmedMessage });
					this.observer()?.onCancelError(cause, status.state === 'REJECTED' || status.state === 'EXPIRED' ? status.state : undefined, status);
				}
			} catch {
				if (current()) {
					this.publish({ control: 'cancel-unconfirmed', message: cancelUnconfirmedMessage });
					this.observer()?.onCancelError(cause);
				}
			}
		} finally {
			this.cancelObservation = null;
			this.deleting = false;
			this.finishCancellation();
			this.deliver();
			this.release();
		}
	};
	cancel = async (recovery?: Recovery) => {
		if (this.deleting || this.cancellationSettled || this.outcome === 'cancelled') return;
		this.publish({ control: 'cancelling', message: cancellingMessage });
		this.pause();
		if (this.creation) this.persistCreation({ ...this.creation, cancelRequested: true });
		if (this.snapshot.saved) await this.cancelSaved(this.snapshot.saved);
		else if (this.creation) {
			const clientUploadId = this.creation.request.clientUploadId;
			try { await this.restore(recovery); }
			catch (cause) {
				if (this.creation?.request.clientUploadId !== clientUploadId) return;
				this.publish({ control: 'cancel-unconfirmed', message: cancelUnconfirmedMessage });
				this.observer()?.onCancelError(cause);
			}
		} else if (recovery?.items.some(item => item.sessionId)) {
			try {
				await this.restore(recovery);
				this.finishCancellation();
			} catch (cause) {
				this.publish({ control: 'cancel-unconfirmed', message: cancelUnconfirmedMessage });
				this.observer()?.onCancelError(cause);
			}
		} else this.finishCancellation();
	};
	transfer = async (run: UploadRun, args: Parameters<typeof uploadDirectAssetFile>, toSaved: (session: DirectAssetUploadSession) => Locator, operationKey?: string) => {
		const [owner, file, kind, onProgress, options = {}] = args;
		const epoch = this.epoch;
		if (!this.isCurrentRun(run.token)) throw new DOMException('Aborted', 'AbortError');
		if (this.snapshot.control !== 'open') throw new Error(this.snapshot.message ?? cancelUnconfirmedMessage);
		if (!options.resume && (this.pending || (this.uncertain && !this.creation) || this.legacyUnresolved || this.snapshot.saved)) throw new Error('기존 업로드 결과를 먼저 확인해 주세요.');
		if (!options.resume && this.creation && !this.matchesOperation(operationKey)) throw new Error('이전 업로드를 먼저 확인하거나 취소해 주세요.');
		// Snapshot earlier ambiguity before persisting this attempt. The current
		// request record alone is not evidence of an uncertain result, and the
		// guards above prevent overlapping transfers while a create is pending.
		const earlierCreateUnresolved = this.uncertain || this.recoveryBlocked;
		if (!options.resume) { this.clientUploadId ??= crypto.randomUUID(); this.pending = true; if (!this.creation) this.sourceFile = file; this.operationKey = operationKey; this.identityAssigned = true; }
		let received = false;
		try {
			return await uploadDirectAssetFile(owner, file, kind, progress => {
				if (epoch !== this.epoch || !this.isCurrentRun(run.token)) return;
				this.publish({ progress });
				if (this.isCurrentRun(run.token)) onProgress?.(progress);
			}, { ...options, clientUploadId: this.clientUploadId,
				...(this.creation ? { createRequest: this.creation.request } : {}),
				onCreateRequest: request => {
					if (epoch !== this.epoch) throw new DOMException('Aborted', 'AbortError');
					this.persistCreation({ ...this.creation, version: 1, scope: this.scope, owner: typeof owner === 'number' ? { type: 'PROJECT', id: owner } : owner,
						kind, request, fileIndex: options.recoveryIndex ?? 0, operationKey,
						...(this.cancellation ? { cancelRequested: true } : {}) });
					this.sourceFile = file;
				},
				signal: run.controller.signal, onSession: session => {
				if (received || epoch !== this.epoch || (options.resume && !this.isCurrentRun(run.token))) return;
				received = true;
				this.pending = false;
				this.bindingId = options.submissionItem?.id;
				this.remember(toSaved(session));
				if (!this.isCurrentRun(run.token) && !this.cancellation) this.publish({ handoff: this.snapshot.handoff + 1 });
				if (this.cancellation) void this.cancelSaved(this.snapshot.saved!);
			} });
		} catch (cause) {
			if (epoch === this.epoch && cause instanceof ApiError && (cause.body as { error?: { code?: string } } | null)?.error?.code === 'IDEMPOTENCY_CONFLICT' && this.creation) {
				this.persistCreation({ ...this.creation, conflict: true });
			}
			if (epoch === this.epoch && !received && !options.resume && this.creation) {
				if (!earlierCreateUnresolved && !this.snapshot.saved && isDirectUploadPreCreationRejection(cause)) {
					// No prior ambiguous/in-flight attempt exists for this logical job.
					// Remove durable recovery data before allowing another identity.
					this.clearCreation();
					this.sourceFile = null;
					this.uncertain = false; this.recoveryBlocked = false;
					this.publish({ message: null, progress: null });
				} else {
					this.uncertain = true;
					this.publish({ message: this.cancellation ? cancelUnconfirmedMessage : recoveryMessage, handoff: this.snapshot.handoff + 1,
						...(this.cancellation ? { control: 'cancel-unconfirmed' } : {}) });
				}
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
	private restoreCreation = (recovery?: Recovery): Promise<Locator | null | undefined> => {
		if (this.recoveryRequest) return this.recoveryRequest;
		const record = this.creation!;
		const epoch = this.epoch;
		const current = () => epoch === this.epoch && this.creation?.request.clientUploadId === record.request.clientUploadId;
		this.recoveryRequest = (async () => {
			if (record.conflict) throw new Error('업로드 식별자가 다른 요청에 사용되었습니다. 기존 기록을 보존했으므로 관리자 확인이 필요합니다.');
			if (recovery && (record.owner.type !== recovery.owner.type || record.owner.id !== recovery.owner.id || record.kind !== recovery.kind)) throw new Error('저장된 업로드 대상이 일치하지 않습니다.');
			const result = await getDirectAssetUploadCreation(record.request.clientUploadId);
			if (!current()) return undefined;
			if (this.snapshot.saved) return this.snapshot.saved;
			let observed = result.status === 'OBSERVED' ? result.session : null;
			// A missing observation is not failure. For cancellation, replay the exact
			// durable body to acquire a cancellable session, even without the File.
			// Let an original in-flight request settle first. Replaying it here
			// would make even its later definite rejection ambiguous.
			if (!observed && this.cancellation && !this.pending) observed = await createDirectAssetUploadSession(record.owner, record.kind, record.request);
			if (!current()) return undefined;
			if (!observed) { this.publish({ message: recoveryMessage }); return null; }
			if (observed.clientUploadId !== record.request.clientUploadId || observed.owner.type !== record.owner.type
				|| observed.owner.id !== record.owner.id || observed.kind !== record.kind || observed.sourceIdentity !== record.request.sourceIdentity) throw new Error('복구된 업로드 생성 결과가 요청과 일치하지 않습니다.');
			if (observed.state === 'ALLOCATING' && !this.cancellation) throw new DirectUploadAllocationPendingError();
			const status = await getDirectAssetUploadStatus(observed.sessionId, AbortSignal.timeout(15_000));
			if (!current()) return undefined;
			if (this.snapshot.saved) return this.snapshot.saved;
			if (status.sessionId !== observed.sessionId || status.generation !== observed.generation || status.owner.type !== record.owner.type
				|| status.owner.id !== record.owner.id || status.kind !== record.kind || status.originalName !== record.request.originalName
				|| status.totalBytes !== record.request.totalBytes || status.sourceIdentity !== record.request.sourceIdentity) throw new Error('복구된 업로드 세션이 요청과 일치하지 않습니다.');
			const session: DirectAssetUploadSession = { ...observed };
			const saved = recovery ? recovery.toSaved(session, status, record.fileIndex) : session;
			// Fence the original in-flight create before adopting its observed result.
			this.pause(); this.epoch++; this.pending = false;
			this.bindingId = record.request.submissionItem?.id;
			this.remember(saved);
			if (this.cancellation) await this.cancelSaved(saved);
			return this.snapshot.saved;
		})().catch(cause => {
			if (current()) { this.recoveryBlocked = true; this.publish({ message: cause instanceof Error ? cause.message : recoveryMessage }); }
			throw cause;
		}).finally(() => { this.recoveryRequest = null; this.release(); });
		return this.recoveryRequest;
	};

	restore = (recovery?: Recovery): Promise<Locator | null | undefined> => {
		if (this.creation && !this.snapshot.saved) return this.restoreCreation(recovery);
		if (this.legacyUnresolved && !recovery?.items.length) return Promise.reject(new Error(this.snapshot.message ?? recoveryMessage));
		if (this.pending) {
			this.publish({ message: recoveryMessage });
			return Promise.resolve(undefined);
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
				this.legacyUnresolved = false;
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
	if (!task) { task = new DirectUploadTask(key, storageKey, scope); tasks.set(key, task); }
	return task;
}

/** Test harness teardown also fences responses still held by deferred transports. */
export function resetDirectUploadTasksForTests() {
	for (const task of tasks.values()) task.disposeForTests();
	tasks.clear();
}
