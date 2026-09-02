import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { sourceIdentityRoot } from '../modules/admin/game-upload/source-identity.js';
import { ImageRejectedError } from '../modules/image/errors.js';
import { DEFAULT_IMAGE_WORKER_LIMITS } from '../modules/image/policy.js';
import { createImageProcessor } from '../modules/image/processor.js';
import type { LocalImageOutput, VerifyingImageSession } from '../modules/image/ports.js';
import { createImageWorker } from '../modules/image/worker.js';

const source = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4]);

function session(): VerifyingImageSession {
	const digest = createHash('sha256').update(source).digest();
	return {
		id: 'image-session', kind: 'IMAGE', state: 'VERIFYING', owner: { type: 'PROJECT', id: '7' },
		actorId: '9', originalName: 'photo.jpg', declaredMimeType: 'text/plain', totalBytes: BigInt(source.length),
		bucket: 'protected', objectKey: 'protected/uploads/image-session/g1/source', generation: 1,
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
		sourceIdentity: sourceIdentityRoot(source.length, 1_048_576, [digest.toString('hex')]),
		sourceIdentityBlockSizeBytes: 1_048_576, sourceIdentityBlockManifest: digest.toString('base64'),
	};
}

async function harness(commitFailsOnce = false) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-worker-test-'));
	const uploaded = new Map<string, { size: number; checksumSha256: string }>();
	const upload = vi.fn(async (input: { key: string; body: Readable; contentLength: number; checksumSha256: string }) => {
		for await (const _chunk of input.body) { /* drain */ }
		uploaded.set(input.key, { size: input.contentLength, checksumSha256: input.checksumSha256 });
	});
	let firstCommit = commitFailsOnce;
	const repository = {
		claimVerifying: vi.fn(), renewLease: vi.fn(), markOutputUploaded: vi.fn(async () => {}), reject: vi.fn(),
		prepareOutputPlan: vi.fn(async () => ({
			assetId: 'asset-20',
			outputs: ['ORIGINAL', 'CARD_480', 'DISPLAY_960'].map((role) => ({
				role, bucket: 'public', objectKey: `public/images/asset-20/${role.toLowerCase()}/g1.webp`,
				intentId: `intent-${role}`, intentState: 'PREPARED',
			})),
		})),
		commitReady: vi.fn(async () => {
			if (firstCommit) { firstCommit = false; throw new Error('database unavailable'); }
		}),
	};
	const operations = {
		inspectRaster: vi.fn(async () => ({ width: 1000, height: 500, pages: 1, channels: 4 })),
		renderPdfFirstPage: vi.fn(async () => ({ pages: 1 })),
		createOutputs: vi.fn(async ({ outputDirectory }: { outputDirectory: string }) => {
			const roles = ['ORIGINAL', 'CARD_480', 'DISPLAY_960'] as const;
			const outputs: LocalImageOutput[] = [];
			for (const [index, role] of roles.entries()) {
				const body = Buffer.from(`output-${role}`);
				const outputPath = path.join(outputDirectory, `${role}.webp`);
				await fs.writeFile(outputPath, body);
				outputs.push({ role, path: outputPath, mimeType: role === 'ORIGINAL' ? 'image/jpeg' : 'image/webp',
					extension: role === 'ORIGINAL' ? 'jpg' : 'webp', sizeBytes: body.length,
					width: index === 0 ? 1000 : index === 1 ? 480 : 960, height: index === 0 ? 500 : index === 1 ? 240 : 480,
					checksumSha256: createHash('sha256').update(body).digest('hex') });
			}
			return outputs;
		}),
	};
	const storage = {
		stream: vi.fn(async () => ({ body: Readable.from([source]), size: source.length })),
		head: vi.fn(async (_bucket: string, key: string) => uploaded.get(key) ?? null), upload,
	};
	const logger = { info: vi.fn(), warn: vi.fn() };
	return { root, repository, operations, storage, logger, processor: createImageProcessor({
		repository: repository as never, operations, storage, tempRoot: root, protectedBucket: 'protected', publicBucket: 'public',
		limits: { ...DEFAULT_IMAGE_WORKER_LIMITS, maxSourceBytes: 1024, maxOutputBytes: 1024, maxTempBytes: 4096 },
		clock: { now: () => new Date(0) }, logger,
	}) };
}

describe('direct IMAGE/POSTER processor', () => {
	it('distrusts MIME and commits public immutable ORIGINAL/CARD_480/DISPLAY_960 metadata', async () => {
		const test = await harness();
		try {
			await expect(test.processor.process(session(), 'token')).resolves.toEqual({ assetId: 'asset-20' });
			expect(test.storage.upload).toHaveBeenCalledTimes(3);
			expect(test.repository.prepareOutputPlan.mock.invocationCallOrder[0])
				.toBeLessThan(test.storage.upload.mock.invocationCallOrder[0]!);
			expect(test.repository.commitReady).toHaveBeenCalledWith(expect.objectContaining({
				outputs: expect.arrayContaining([expect.objectContaining({ role: 'ORIGINAL', mimeType: 'image/jpeg' }),
					expect.objectContaining({ role: 'CARD_480' }), expect.objectContaining({ role: 'DISPLAY_960' })]),
			}));
			expect(test.logger.warn).toHaveBeenCalledOnce();
			expect(await fs.readdir(test.root)).toEqual([]);
		} finally { await fs.rm(test.root, { recursive: true, force: true }); }
	});

	it('recovers PUT-before-DB-commit without duplicate object writes and cleans temp files', async () => {
		const test = await harness(true);
		try {
			await expect(test.processor.process(session(), 'token')).rejects.toThrow('database unavailable');
			await expect(test.processor.process(session(), 'token')).resolves.toEqual({ assetId: 'asset-20' });
			expect(test.storage.upload).toHaveBeenCalledTimes(3);
			expect(test.repository.markOutputUploaded).toHaveBeenCalledTimes(6);
			expect(await fs.readdir(test.root)).toEqual([]);
		} finally { await fs.rm(test.root, { recursive: true, force: true }); }
	});
});

describe('IMAGE worker failure classification', () => {
	function repository() {
		return { claimVerifying: vi.fn(async () => [session()]), renewLease: vi.fn(async () => true),
			prepareOutputPlan: vi.fn(), markOutputUploaded: vi.fn(), commitReady: vi.fn(), reject: vi.fn(async () => true) };
	}
	it('rejects decoder bombs and retries Garage/DB/worker outages', async () => {
		const rejectedRepository = repository();
		const rejected = createImageWorker({ repository: rejectedRepository as never,
			processor: { process: vi.fn(async () => { throw new ImageRejectedError('bomb', 'PIXEL_LIMIT'); }) } as never,
			ids: { next: () => 'token' }, logger: { error: vi.fn(), warn: vi.fn() } });
		await expect(rejected.runPass()).resolves.toMatchObject({ rejected: 1, retried: 0 });
		expect(rejectedRepository.reject).toHaveBeenCalledOnce();

		for (const message of ['Garage outage', 'database unavailable', 'worker crash']) {
			const retryRepository = repository();
			const retry = createImageWorker({ repository: retryRepository as never,
				processor: { process: vi.fn(async () => { throw new Error(message); }) } as never,
				ids: { next: () => 'token' }, logger: { error: vi.fn(), warn: vi.fn() } });
			await expect(retry.runPass()).resolves.toMatchObject({ rejected: 0, retried: 1 });
			expect(retryRepository.reject).not.toHaveBeenCalled();
		}
	});
});
