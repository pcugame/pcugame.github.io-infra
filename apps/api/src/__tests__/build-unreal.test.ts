import * as nativeEngines from '../modules/build-package/native-engines.js';
import { InspectionBudgetExceeded } from '../modules/build-package/reader.js';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createUnrealInspector, UE_PARSER_REVISION } from '../modules/build-package/unreal.js';
import { CommandLimitError } from '../modules/process/command-runner.js';
import { inspectBuildPackage } from '../modules/build-package/inspect.js';
import { validateBoundedZipFile } from '../modules/archive/bounded-zip-validator.js';
import { makeZip, nativeElfFixture } from './helpers/build-zip.js';
import { validationSession } from './helpers/game-validation-fixture.js';
import { createGameUploadValidationWorker } from '../modules/asset-upload/validation-worker.service.js';
import type { AssetUploadRepository } from '../modules/asset-upload/ports.js';
import { Readable } from 'node:stream';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'ue-adapter-test-')); roots.push(root);
	const bytes = makeZip([{ name: '여러 폴더/game', data: nativeElfFixture() }, { name: '여러 폴더/game.pak', data: 'pak contents' }, { name: '여러 폴더/main.utoc', data: 'toc' }, { name: '여러 폴더/main.ucas', data: 'cas' }]);
	const archivePath = join(root, 'source.zip'); await writeFile(archivePath, bytes);
	const summary = await validateBoundedZipFile(archivePath, { profile: 'GAME' });
	return { root, bytes, archivePath, summary };
}
function output(status: 'review' | 'reject' = 'review') {
	return JSON.stringify({ version: 1, inspector: 'ue-inspector-v1', parserRevision: UE_PARSER_REVISION, facts: [
		{ path: '여러 폴더/game.pak', format: 'pak', status, evidence: ['checked index'], reasons: [status === 'reject' ? 'ue-pak-index-hash-mismatch' : 'ue-pak-cooked-payload-not-certified'] },
		{ path: '여러 폴더/main.utoc', format: 'iostore', status: 'review', evidence: [], reasons: ['ue-iostore-package-metadata-not-certified'] },
	] });
}
it('materializes containers once as opaque names, validates JSON, and cleans the workspace', async () => {
	const f = await fixture();
	const run = vi.fn(async (request) => {
		expect(request.file).toBe('/fixed/inspector'); expect(request.timeoutMs).toBe(60_000); expect(request.maxOutputBytes).toBe(1024 * 1024);
		const input = JSON.parse(await readFile(request.args[0], 'utf8'));
		expect(input.files).toHaveLength(3); expect(input.analysisBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
		for (const file of input.files) {
			expect(dirname(file.localPath)).toBe(dirname(request.args[0]));
			expect((await readFile(file.localPath)).length).toBe(file.bytes);
		}
		return { stdout: output(), stderr: '' };
	});
	const result = await inspectBuildPackage({ ...f, tempByteLimit: 8 * 1024 * 1024, unrealInspector: createUnrealInspector({ run }, '/fixed/inspector') });
	expect(result.outcome).toBe('REVIEW'); expect(result.evidence.join()).toContain(UE_PARSER_REVISION); expect(run).toHaveBeenCalledOnce();
	expect(await readdir(f.root)).toEqual(['source.zip']);
});
it('does not create optional copies when source plus containers exceeds workspace budget', async () => {
	const f = await fixture(), run = vi.fn();
	const result = await inspectBuildPackage({ ...f, tempByteLimit: f.summary.archiveBytes, unrealInspector: createUnrealInspector({ run }) });
	expect(result.reasons).toContain('ue-temporary-space-budget'); expect(run).not.toHaveBeenCalled(); expect(await readdir(f.root)).toEqual(['source.zip']);
});
it.each(['{}', output().replace('game.pak', 'foreign.pak'), output().replace(UE_PARSER_REVISION, 'other')])('retries invalid or foreign protocol output instead of classifying corruption', async stdout => {
	const f = await fixture();
	await expect(inspectBuildPackage({ ...f, tempByteLimit: 8 * 1024 * 1024, unrealInspector: createUnrealInspector({ run: async () => ({ stdout, stderr: '' }) }) })).rejects.toThrow();
	expect(await readdir(f.root)).toEqual(['source.zip']);
});
it('keeps bounded exhaustion reviewable and installation failures retryable', async () => {
	const f = await fixture();
	const inspect = (error: Error) => inspectBuildPackage({ ...f, tempByteLimit: 8 * 1024 * 1024, unrealInspector: createUnrealInspector({ run: async () => { throw error; } }) });
	expect((await inspect(new CommandLimitError('timeout', 'PROCESS_TIMEOUT'))).reasons).toContain('ue-process_timeout');
	await expect(inspect(new Error('ENOENT'))).rejects.toThrow('ENOENT');
	expect(await readdir(f.root)).toEqual(['source.zip']);
});
it('aborts inspection and removes all optional files', async () => {
	const f = await fixture(), controller = new AbortController();
	const unrealInspector = createUnrealInspector({ run: async () => { controller.abort(new Error('lease lost')); throw controller.signal.reason; } });
	await expect(inspectBuildPackage({ ...f, signal: controller.signal, tempByteLimit: 8 * 1024 * 1024, unrealInspector })).rejects.toThrow('lease lost');
	expect(await readdir(f.root)).toEqual(['source.zip']);
});
it('rechecks UE damage after approval through the GAME worker and retains infrastructure failures', async () => {
	const f = await fixture(), session = validationSession(f.bytes);
	const repository = { claimVerifying: vi.fn(async kind => kind === 'GAME' ? [session] : []), renewValidation: vi.fn(async () => true), commitGameReady: vi.fn(), markRejected: vi.fn(async () => true) } as unknown as AssetUploadRepository;
	let approved = false, status: 'review' | 'reject' = 'review', broken = false;
	const reviews = { approval: vi.fn(async () => approved ? { sourceIdentity: session.sourceIdentity, generation: session.generation, entryPath: null } : null), awaitReview: vi.fn(async () => true) };
	const worker = createGameUploadValidationWorker({ repository, reviews, unrealInspector: createUnrealInspector({ run: async () => { if (broken) throw new Error('installation failure'); return { stdout: output(status), stderr: '' }; } }), storage: { stream: async () => ({ body: Readable.from([f.bytes]), size: f.bytes.length }) }, ids: { next: () => 'claim' }, tempRoot: f.root, tempDiskBudgetBytes: 8 * 1024 * 1024, logger: { error: vi.fn() }, wakeDeletionWorker: vi.fn() });
	expect(await worker.runPass()).toMatchObject({ ready: 0, rejected: 0, retried: 0 }); expect(reviews.awaitReview).toHaveBeenCalledOnce();
	approved = true;
	expect(await worker.runPass()).toMatchObject({ ready: 1 });
	status = 'reject';
	expect(await worker.runPass()).toMatchObject({ ready: 0, rejected: 1 });
	expect(repository.markRejected).toHaveBeenLastCalledWith(session.id, session.generation, 'claim', expect.objectContaining({ sourceDisposition: 'DELETE', reason: expect.stringContaining('ue-pak-index-hash-mismatch') }));
	broken = true;
	expect(await worker.runPass()).toMatchObject({ ready: 0, rejected: 0, retried: 1 });
	expect(repository.commitGameReady).toHaveBeenCalledOnce(); expect(await readdir(f.root)).toEqual(['source.zip']);
});
it('terminates a real child on lease cancellation and preserves the cancellation reason', async () => {
	const { createBoundedCommandRunner } = await import('../modules/process/command-runner.js');
	const controller = new AbortController(), reason = new Error('lease fenced');
	const timer = setTimeout(() => controller.abort(reason), 40);
	try {
		await expect(createBoundedCommandRunner().run({ file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], signal: controller.signal, timeoutMs: 2000, maxOutputBytes: 1024 })).rejects.toBe(reason);
	} finally { clearTimeout(timer); }
});

it('does not let a later adapter budget exhaustion downgrade confirmed UE damage', async () => {
	const f = await fixture();
	const later = vi.spyOn(nativeEngines, 'inspectNativeEngines').mockRejectedValueOnce(new InspectionBudgetExceeded('later-budget'));
	try {
		const result = await inspectBuildPackage({ ...f, tempByteLimit: 8 * 1024 * 1024, unrealInspector: async () => ({ outcome: 'REJECT', evidence: [], reasons: ['ue-pak-index-hash-mismatch'] }) });
		expect(result.outcome).toBe('REJECT');
		expect(later).not.toHaveBeenCalled();
	} finally { later.mockRestore(); }
});
