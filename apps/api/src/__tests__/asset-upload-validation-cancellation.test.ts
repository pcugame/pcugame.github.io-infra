import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import yauzl from 'yauzl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGameUploadValidationWorker } from '../modules/asset-upload/validation-worker.service.js';
import type { AssetUploadRepository, AssetUploadValidationStorage } from '../modules/asset-upload/ports.js';
import { ZipValidationAbortedError, ZipValidationError } from '../modules/archive/bounded-zip-validator.js';
import { ProjectUploadPolicyRejectedError } from '../modules/admin/project-access.service.js';
import { WorkerGenerationFencedError, WorkerInputRejectedError } from '../modules/upload-lifecycle/worker-errors.js';
import { gameZip, validationSession } from './helpers/game-validation-fixture.js';

let tempRoot: string;
beforeEach(async () => { tempRoot = await mkdtemp(join(tmpdir(), 'validation-cancel-')); });
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await rm(tempRoot, { recursive: true, force: true }); });

function harness(session = validationSession()) {
	const body = Readable.from(gameZip());
	const repository = {
		claimVerifying: vi.fn(async (kind: string) => kind === session.kind ? [session] : []),
		renewValidation: vi.fn(async () => true),
		commitGameReady: vi.fn(async () => ({ assetId: 1, representationId: 'original' })),
		markRejected: vi.fn(async () => true),
	};
	const stream = vi.fn<AssetUploadValidationStorage['stream']>(async () => ({ body, size: Number(session.totalBytes) }));
	const worker = createGameUploadValidationWorker({ repository: repository as unknown as AssetUploadRepository,
		storage: { stream }, ids: { next: () => 'claim' }, tempRoot, tempDiskBudgetBytes: 1024 * 1024,
		logger: { error: vi.fn() }, wakeDeletionWorker: vi.fn(),
	});
	return { worker, repository, stream, body };
}
const retried = { claimed: 1, ready: 0, rejected: 0, retried: 1 };

describe('direct validation cancellation and typed failures', () => {
	it.each([1, 5])('preserves a valid ZIP when shutdown interrupts real decoding (attempt %i)', async (attempt) => {
		const controller = new AbortController();
		const h = harness(validationSession(gameZip(), { validationAttemptCount: attempt }));
		const open = yauzl.openPromise;
		const opened = vi.spyOn(yauzl, 'openPromise').mockImplementationOnce(async (...args) => {
			const zip = await open(...args);
			controller.abort(new Error('GAME validation worker is stopping'));
			return zip;
		});
		await expect(h.worker.runPass(controller.signal)).resolves.toEqual(retried);
		expect(opened).toHaveBeenCalledOnce();
		expect(h.repository.markRejected).not.toHaveBeenCalled();
		expect(h.repository.commitGameReady).not.toHaveBeenCalled();
		expect(await readdir(tempRoot)).toEqual([]);
	});

	it('does not claim anything when already stopped', async () => {
		const h = harness(); const controller = new AbortController(); controller.abort();
		await expect(h.worker.runPass(controller.signal)).resolves.toEqual({ claimed: 0, ready: 0, rejected: 0, retried: 0 });
		expect(h.repository.claimVerifying).not.toHaveBeenCalled();
	});

	it.each(['GAME', 'DOCUMENT', 'ATTACHMENT'] as const)('aborts the real %s source pipeline without rejecting', async (kind) => {
		const h = harness(validationSession(gameZip(), { kind, validationAttemptCount: 5 }));
		const controller = new AbortController();
		const body = new Readable({ read() { controller.abort(new Error('shutdown with invalid ZIP in its message')); } });
		h.stream.mockResolvedValue({ body, size: Number(validationSession().totalBytes) });
		await expect(h.worker.runPass(controller.signal)).resolves.toEqual(retried);
		expect(body.destroyed).toBe(true);
		expect(h.repository.markRejected).not.toHaveBeenCalled();
		expect(await readdir(tempRoot)).toEqual([]);
	});

	it.each([new ZipValidationAbortedError(), new DOMException('invalid ZIP', 'AbortError'), Object.assign(new Error('cancel'), { code: 'ABORT_ERR' })])('preserves sources for an explicit cancellation error', async (error) => {
		const h = harness(validationSession(gameZip(), { validationAttemptCount: 5 }));
		h.stream.mockRejectedValue(error);
		await expect(h.worker.runPass()).resolves.toEqual(retried);
		expect(h.repository.markRejected).not.toHaveBeenCalled();
	});

	it('does not commit if shutdown occurs during final ownership renewal', async () => {
		const h = harness(); const controller = new AbortController();
		h.repository.renewValidation.mockImplementation(async () => { controller.abort(); return true; });
		await expect(h.worker.runPass(controller.signal)).resolves.toEqual(retried);
		expect(h.repository.commitGameReady).not.toHaveBeenCalled();
		expect(h.repository.markRejected).not.toHaveBeenCalled();
	});

	it('preserves a lost lease even at the retry limit', async () => {
		const h = harness(validationSession(gameZip(), { validationAttemptCount: 5 }));
		h.repository.renewValidation.mockResolvedValue(false);
		await expect(h.worker.runPass()).resolves.toEqual(retried);
		expect(h.repository.markRejected).not.toHaveBeenCalled();
	});

	it.each(['ZIP storage unavailable', 'invalid credentials', 'corrupt connection', 'CRC I/O failure'])('retries untyped infrastructure failure: %s', async (message) => {
		const h = harness(); h.stream.mockRejectedValue(new Error(message));
		await expect(h.worker.runPass()).resolves.toEqual(retried);
		expect(h.repository.markRejected).not.toHaveBeenCalled();
	});

	it('retains the original after infrastructure retries are exhausted', async () => {
		const h = harness(validationSession(gameZip(), { validationAttemptCount: 5 }));
		h.stream.mockRejectedValue(new Error('ZIP storage unavailable'));
		await expect(h.worker.runPass()).resolves.toEqual({ claimed: 1, ready: 0, rejected: 1, retried: 0 });
		expect(h.repository.markRejected).toHaveBeenCalledWith('game-validation', 1, 'claim', {
			reason: expect.stringContaining('OPERATOR_REQUIRED:'), sourceDisposition: 'RETAIN',
		});
	});

	it.each([new ZipValidationError('content failed'), new WorkerInputRejectedError('content failed'), new WorkerGenerationFencedError('GAME'), new ProjectUploadPolicyRejectedError('closed')])('rejects an explicit deterministic failure', async (error) => {
		const h = harness(); h.stream.mockRejectedValue(error);
		await expect(h.worker.runPass()).resolves.toEqual({ claimed: 1, ready: 0, rejected: 1, retried: 0 });
		expect(h.repository.markRejected).toHaveBeenCalledWith('game-validation', 1, 'claim', { reason: error.message, sourceDisposition: 'DELETE' });
	});

	it('retains malformed persisted metadata and closes the unconsumed stream', async () => {
		const h = harness(validationSession(gameZip(), { sourceIdentityBlockManifest: '' }));
		await expect(h.worker.runPass()).resolves.toEqual({ claimed: 1, ready: 0, rejected: 1, retried: 0 });
		expect(h.repository.markRejected).toHaveBeenCalledWith('game-validation', 1, 'claim', {
			reason: expect.stringContaining('OPERATOR_REQUIRED:'), sourceDisposition: 'RETAIN',
		});
		expect(h.body.destroyed).toBe(true);
	});

	it('closes the materialization destination when persisted manifest length is invalid', async () => {
		const h = harness(validationSession(gameZip(), { sourceIdentityBlockManifest: Buffer.alloc(64).toString('base64') }));
		await h.worker.runPass();
		expect(h.repository.markRejected).toHaveBeenCalledWith('game-validation', 1, 'claim', {
			reason: 'OPERATOR_REQUIRED: Persisted source identity manifest length is invalid', sourceDisposition: 'RETAIN',
		});
		expect(await readdir(tempRoot)).toEqual([]);
	});

	it('aborts an in-flight source when the heartbeat loses its lease', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		const h = harness(validationSession(gameZip(), { validationAttemptCount: 5 }));
		h.repository.renewValidation.mockResolvedValue(false);
		let started!: () => void;
		const reading = new Promise<void>((resolve) => { started = resolve; });
		const body = new Readable({ read() { started(); } });
		h.stream.mockResolvedValue({ body, size: Number(validationSession().totalBytes) });
		const pass = h.worker.runPass();
		await reading;
		await vi.advanceTimersByTimeAsync(30_000);
		await expect(pass).resolves.toEqual(retried);
		expect(body.destroyed).toBe(true);
		expect(h.repository.markRejected).not.toHaveBeenCalled();
		expect(h.repository.commitGameReady).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(['GAME', 'DOCUMENT', 'ATTACHMENT'] as const)('rejects an actual %s source identity mismatch', async (kind) => {
		const bytes = Buffer.from('different bytes');
		const session = validationSession(bytes, { kind });
		const h = harness(session);
		h.stream.mockResolvedValue({ body: Readable.from(Buffer.alloc(bytes.length)), size: bytes.length });
		await h.worker.runPass();
		expect(h.repository.markRejected).toHaveBeenCalledWith(session.id, 1, 'claim', {
			reason: expect.stringContaining('source identity'), sourceDisposition: 'DELETE',
		});
	});

	it.each(['metadata', 'short', 'long'] as const)('rejects a proven source size mismatch: %s', async (shape) => {
		const bytes = gameZip(); const h = harness(validationSession(bytes));
		const body = Readable.from(shape === 'short' ? bytes.subarray(0, -1) : shape === 'long' ? Buffer.concat([bytes, Buffer.from([0])]) : bytes);
		h.stream.mockResolvedValue({ body, size: shape === 'metadata' ? bytes.length + 1 : bytes.length });
		await expect(h.worker.runPass()).resolves.toEqual({ claimed: 1, ready: 0, rejected: 1, retried: 0 });
		expect(h.repository.markRejected).toHaveBeenCalledWith('game-validation', 1, 'claim', { reason: expect.any(String), sourceDisposition: 'DELETE' });
		expect(h.repository.commitGameReady).not.toHaveBeenCalled();
		expect(body.destroyed).toBe(true);
	});

	it('rejects actual ZIP CRC corruption after source identity succeeds', async () => {
		const bytes = gameZip(); bytes[38] = bytes[38]! ^ 0xff;
		const h = harness(validationSession(bytes)); h.stream.mockResolvedValue({ body: Readable.from(bytes), size: bytes.length });
		await h.worker.runPass();
		expect(h.repository.markRejected).toHaveBeenCalledWith('game-validation', 1, 'claim', { reason: expect.stringContaining('CRC32 mismatch'), sourceDisposition: 'DELETE' });
	});

	it.each(['open', 'entry-open', 'entry-read'] as const)('preserves local I/O errors at ZIP %s', async (stage) => {
		const h = harness();
		const error = Object.assign(new Error('ZIP invalid disk read'), { code: 'EIO' });
		const open = yauzl.openPromise;
		vi.spyOn(yauzl, 'openPromise').mockImplementationOnce(async (...args) => {
			if (stage === 'open') throw error;
			const zip = await open(...args);
			if (stage === 'entry-open') vi.spyOn(zip, 'openReadStreamPromise').mockRejectedValueOnce(error);
			else vi.spyOn(zip, 'openReadStreamPromise').mockResolvedValueOnce(new Readable({ read() { this.destroy(error); } }));
			return zip;
		});
		await expect(h.worker.runPass()).resolves.toEqual(retried);
		expect(h.repository.markRejected).not.toHaveBeenCalled();
		expect(await readdir(tempRoot)).toEqual([]);
	});

	it('does not start the next claimed source after shutdown', async () => {
		const h = harness(); const controller = new AbortController();
		h.repository.claimVerifying.mockImplementation(async (kind) => kind === 'GAME' ? [validationSession(), validationSession(gameZip(), { id: 'second' })] : []);
		h.stream.mockImplementation(async () => { controller.abort(); throw new ZipValidationError('bad ZIP'); });
		await expect(h.worker.runPass(controller.signal)).resolves.toEqual({ ...retried, claimed: 2 });
		expect(h.stream).toHaveBeenCalledOnce();
		expect(h.repository.markRejected).not.toHaveBeenCalled();
	});

	it('rejects an actual document content violation', async () => {
		const bytes = Buffer.from([0, 1, 2]);
		const h = harness(validationSession(bytes, { kind: 'DOCUMENT', originalName: 'fake.txt' }));
		h.stream.mockResolvedValue({ body: Readable.from(bytes), size: bytes.length });
		await h.worker.runPass();
		expect(h.repository.markRejected).toHaveBeenCalledWith('game-validation', 1, 'claim', { reason: 'Invalid text document content', sourceDisposition: 'DELETE' });
	});

	it('keeps a rejected transition fenced when the repository reports ownership loss', async () => {
		const h = harness(); h.stream.mockRejectedValue(new ZipValidationError('bad content'));
		h.repository.markRejected.mockResolvedValue(false);
		await expect(h.worker.runPass()).resolves.toEqual(retried);
	});
});
