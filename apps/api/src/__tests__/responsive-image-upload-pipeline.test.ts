import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type {
	AppLogger,
	FileSystem,
	ObjectStorage,
} from '../application/ports.js';
import { createProjectUploadPipeline } from '../modules/admin/project/project-upload.adapter.js';
import { ImageOutputCleanupError } from '../modules/assets/upload/image-processing.js';

const logger: AppLogger = {
	child: () => logger,
	trace: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	fatal: vi.fn(),
};

function harness(options: { failUploadNumber?: number; processingError?: Error } = {}) {
	const files = new Map<string, Buffer>([
		['/tmp/source', Buffer.from('source')],
		['/tmp/source.webp', Buffer.alloc(100)],
		['/tmp/source.card-480.webp', Buffer.alloc(40)],
		['/tmp/source.display-960.webp', Buffer.alloc(70)],
	]);
	const events: string[] = [];
	const deleted: string[] = [];
	const removed: string[] = [];
	let id = 0;
	let uploadNumber = 0;
	let intentNumber = 0;

	const fileSystem = {
		temporaryDirectory: () => '/tmp',
		stat: async (path: string) => ({ size: files.get(path)?.length ?? 0 }),
		access: async () => {},
		mkdir: async () => {},
		rename: async () => {},
		remove: async (path: string) => {
			removed.push(path);
			files.delete(path);
		},
		readRange: async () => Buffer.alloc(0),
		createReadStream: (path: string) => Readable.from(files.get(path) ?? Buffer.alloc(0)),
		createWriteStream: () => { throw new Error('not used'); },
	} satisfies FileSystem;

	const storage = {
		upload: vi.fn(async (_bucket, key, body, _contentType, _length, storageOptions) => {
			uploadNumber += 1;
			events.push(`put:${key}:${storageOptions?.cacheControl ?? ''}`);
			if (uploadNumber === options.failUploadNumber) throw new Error('scripted PUT failure');
			if (body instanceof Readable) {
				for await (const _chunk of body) { /* consume request-owned stream */ }
			}
		}),
		presign: async () => '',
		delete: async () => {},
		head: async () => null,
		readRange: async () => Buffer.alloc(0),
		stream: async () => null,
		listKeys: async () => [],
		createMultipart: async () => '',
		uploadPart: async () => '',
		completeMultipart: async () => {},
		abortMultipart: async () => {},
		listParts: async () => [],
		listMultipartUploads: async () => [],
	} satisfies ObjectStorage;

	const processing = {
		validate: vi.fn(async () => ({ mimeType: 'image/png', ext: 'png', sizeBytes: 6 })),
		processImage: vi.fn(async (input: { createRenditions?: boolean }) => {
			if (options.processingError) throw options.processingError;
			return {
				original: {
					tmpPath: '/tmp/source.webp',
					mimeType: 'image/webp' as const,
					ext: 'webp' as const,
					sizeBytes: 100,
					width: 1200,
					height: 600,
					converted: true as const,
				},
				renditions: input.createRenditions ? [
					{
						profile: 'CARD_480' as const,
						tmpPath: '/tmp/source.card-480.webp',
						mimeType: 'image/webp' as const,
						ext: 'webp' as const,
						sizeBytes: 40,
						width: 480,
						height: 240,
					},
					{
						profile: 'DISPLAY_960' as const,
						tmpPath: '/tmp/source.display-960.webp',
						mimeType: 'image/webp' as const,
						ext: 'webp' as const,
						sizeBytes: 70,
						width: 960,
						height: 480,
					},
				] : [],
			};
		}),
		processPdf: vi.fn(async () => { throw new Error('not used'); }),
		processVideo: vi.fn(async () => { throw new Error('not used'); }),
	};
	const uploadIntents = {
		prepare: vi.fn(async ({ storageKey }: { storageKey: string }) => {
			const intent = `intent-${++intentNumber}`;
			events.push(`prepare:${storageKey}:${intent}`);
			return intent;
		}),
		markUploaded: vi.fn(async (intent: string) => {
			events.push(`uploaded:${intent}`);
		}),
		isUncommitted: vi.fn(async () => true),
		recordAmbiguousError: vi.fn(async (intent: string) => {
			events.push(`ambiguous:${intent}`);
		}),
	};
	const pipeline = createProjectUploadPipeline({
		storage,
		fileSystem,
		ids: { next: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}` },
		logger,
		processing,
		bucketForKind: () => 'public',
		deleteUnpersistedObject: async (_bucket, key) => {
			deleted.push(key);
		},
		uploadIntents,
	});
	pipeline.trackTempFile('/tmp/source');
	return {
		pipeline,
		processing,
		uploadIntents,
		storage,
		events,
		deleted,
		removed,
	};
}

describe('responsive image upload bundle lifecycle', () => {
	it('prepares and marks original plus both rendition intents as one SavedUpload', async () => {
		const test = harness();
		const saved = await test.pipeline.processFile('/tmp/source', 'IMAGE', 'source.png');

		expect(saved).toMatchObject({
			kind: 'IMAGE',
			mimeType: 'image/webp',
			sizeBytes: 100,
			width: 1200,
			height: 600,
			uploadIntentIds: ['intent-1', 'intent-2', 'intent-3'],
		});
		expect(saved.renditions).toEqual([
			expect.objectContaining({
				profile: 'CARD_480',
				sourceStorageKey: saved.storageKey,
				width: 480,
				height: 240,
			}),
			expect.objectContaining({
				profile: 'DISPLAY_960',
				sourceStorageKey: saved.storageKey,
				width: 960,
				height: 480,
			}),
		]);
		expect(test.uploadIntents.prepare).toHaveBeenCalledTimes(3);
		expect(test.uploadIntents.markUploaded).toHaveBeenCalledTimes(3);
		expect(test.storage.upload).toHaveBeenCalledTimes(3);
		for (const key of [
			saved.storageKey,
			...(saved.renditions ?? []).map(({ storageKey }) => storageKey),
		]) {
			const prepareIndex = test.events.findIndex((event) => event.startsWith(`prepare:${key}:`));
			const putIndex = test.events.findIndex((event) => event.startsWith(`put:${key}:`));
			const intentId = test.events[prepareIndex]?.split(':').at(-1);
			const markIndex = test.events.findIndex((event) => event === `uploaded:${intentId}`);
			expect(prepareIndex).toBeGreaterThanOrEqual(0);
			expect(putIndex).toBeGreaterThan(prepareIndex);
			expect(markIndex).toBeGreaterThan(putIndex);
			expect(test.events[putIndex]).toContain('public, max-age=31536000, immutable');
		}

		await test.pipeline.cleanupTemp();
		expect(new Set(test.removed)).toEqual(new Set([
			'/tmp/source',
			'/tmp/source.webp',
			'/tmp/source.card-480.webp',
			'/tmp/source.display-960.webp',
		]));
	});

	it('hands rare processor cleanup residue back to request-owned temp cleanup', async () => {
		const residueError = new ImageOutputCleanupError(
			[new Error('partial output remove failed')],
			['/tmp/source.card-480.webp'],
		);
		const test = harness({ processingError: residueError });

		await expect(test.pipeline.processFile('/tmp/source', 'IMAGE', 'source.png'))
			.rejects.toBe(residueError);
		await test.pipeline.cleanupTemp();
		expect(new Set(test.removed)).toEqual(new Set([
			'/tmp/source',
			'/tmp/source.card-480.webp',
		]));
	});

	it('fails the whole bundle and rolls back every possibly persisted key after a rendition PUT fails', async () => {
		const test = harness({ failUploadNumber: 2 });

		await expect(test.pipeline.processFile('/tmp/source', 'POSTER', 'source.png'))
			.rejects.toThrow('scripted PUT failure');
		expect(test.uploadIntents.prepare).toHaveBeenCalledTimes(2);
		expect(test.uploadIntents.markUploaded).toHaveBeenCalledTimes(1);
		expect(test.uploadIntents.recordAmbiguousError).toHaveBeenCalledWith(
			'intent-2',
			expect.any(Error),
		);

		await test.pipeline.rollbackCommitted();
		expect(test.uploadIntents.isUncommitted).toHaveBeenCalledTimes(2);
		expect(test.deleted).toHaveLength(2);
		expect(test.deleted[0]).toMatch(/\.webp$/);
		expect(test.deleted[1]).toMatch(/\.webp$/);
		await test.pipeline.cleanupTemp();
		expect(test.removed).toEqual(expect.arrayContaining([
			'/tmp/source',
			'/tmp/source.webp',
			'/tmp/source.card-480.webp',
			'/tmp/source.display-960.webp',
		]));
	});

	it('does not prepare or PUT objects after bundle generation fails', async () => {
		const processingError = new Error('rendition generation failed');
		const test = harness({ processingError });

		await expect(test.pipeline.processFile('/tmp/source', 'IMAGE', 'source.png'))
			.rejects.toBe(processingError);
		expect(test.uploadIntents.prepare).not.toHaveBeenCalled();
		expect(test.storage.upload).not.toHaveBeenCalled();
		await test.pipeline.rollbackCommitted();
		expect(test.deleted).toEqual([]);
		await test.pipeline.cleanupTemp();
		expect(test.removed).toEqual(['/tmp/source']);
	});

	it('keeps THUMBNAIL canonical-only while retaining canonical dimensions', async () => {
		const test = harness();
		const saved = await test.pipeline.processFile('/tmp/source', 'THUMBNAIL', 'source.png');

		expect(test.processing.processImage).toHaveBeenCalledWith(
			expect.objectContaining({ createRenditions: false }),
		);
		expect(saved).toMatchObject({ width: 1200, height: 600, renditions: [] });
		expect(test.storage.upload).toHaveBeenCalledOnce();
		expect(test.uploadIntents.prepare).toHaveBeenCalledOnce();
	});
});
