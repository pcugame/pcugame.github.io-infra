import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import {
	EXHIBITION_MUTATION_TRANSACTION_POLICY,
	withExhibitionMutationTransaction,
} from '../modules/admin/year/repository.js';
import { createExhibitionService } from '../modules/admin/year/service.js';

const mocks = {
	findAllExhibitions: vi.fn(),
	findExhibitionByComposite: vi.fn(),
	createExhibition: vi.fn(),
	findExhibitionById: vi.fn(),
	findExhibitionByIdWithCount: vi.fn(),
	updateExhibition: vi.fn(),
	deleteExhibition: vi.fn(),
	replaceExhibitionPoster: vi.fn(),
	clearExhibitionPoster: vi.fn(),
	wakeDeletionWorker: vi.fn(),
	logError: vi.fn(),
	posterUploadStart: vi.fn(),
};

const exhibitionService = createExhibitionService({
	publicAssetBaseUrl: 'https://assets.example.test',
	posterBucket: 'public-bucket',
	repository: {
		findAllExhibitions: mocks.findAllExhibitions,
		findExhibitionByComposite: mocks.findExhibitionByComposite,
		createExhibition: mocks.createExhibition,
		findExhibitionById: mocks.findExhibitionById,
		findExhibitionByIdWithCount: mocks.findExhibitionByIdWithCount,
		updateExhibition: mocks.updateExhibition,
		deleteExhibition: mocks.deleteExhibition,
		replaceExhibitionPoster: mocks.replaceExhibitionPoster,
		clearExhibitionPoster: mocks.clearExhibitionPoster,
	},
	uploadLimits: () => ({
		posterMaxBytes: 1,
		imageMaxBytes: 1,
		gameMaxBytes: 1,
		videoMaxBytes: 1,
		requestMaxBytes: 1,
		maxFiles: 1,
	}),
	uploadSlots: { acquire: vi.fn(), release: vi.fn() },
	posterUpload: { start: mocks.posterUploadStart },
	wakeDeletionWorker: mocks.wakeDeletionWorker,
	logger: { error: mocks.logError },
});

const {
	createExhibition,
	deleteExhibition,
	deletePoster,
	listExhibitions,
	replacePoster,
	updateExhibition,
} = exhibitionService;

function exhibition(overrides: Record<string, unknown> = {}) {
	return {
		id: 1,
		year: 2026,
		title: '',
		isUploadEnabled: true,
		sortOrder: 0,
		posterStorageKey: null,
		posterOriginalName: '',
		posterSizeBytes: 0n,
		posterWidth: null,
		posterHeight: null,
		posterCard480Height: null,
		posterDisplay960Height: null,
		_count: { projects: 0 },
		...overrides,
	};
}

describe('admin exhibition service', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('serializes exhibition list items with optional poster metadata', async () => {
		mocks.findAllExhibitions.mockResolvedValue([
			exhibition({
				title: 'Graduation Show',
				posterStorageKey: 'poster.webp',
				posterOriginalName: 'poster.pdf',
				posterSizeBytes: 1234n,
				posterWidth: 1200,
				posterHeight: 800,
				posterCard480Height: 320,
				posterDisplay960Height: null,
				_count: { projects: 3 },
			}),
			exhibition({ id: 2, year: 2025 }),
		]);

		await expect(listExhibitions()).resolves.toEqual([
			{
				id: 1,
				year: 2026,
				title: 'Graduation Show',
				isUploadEnabled: true,
				sortOrder: 0,
				projectCount: 3,
				poster: {
					original: {
						url: 'https://assets.example.test/poster.webp',
						width: 1200,
						height: 800,
					},
					renditions: [{
						profile: 'CARD_480',
						url: 'https://assets.example.test/poster.webp/__pcu_image_rendition__/v1/card-480.webp',
						width: 480,
						height: 320,
					}],
				},
				posterOriginalName: 'poster.pdf',
				posterSize: 1234,
			},
			{
				id: 2,
				year: 2025,
				title: undefined,
				isUploadEnabled: true,
				sortOrder: 0,
				projectCount: 0,
				poster: undefined,
				posterOriginalName: undefined,
				posterSize: undefined,
			},
		]);
	});

	it('keeps a legacy poster usable without dimensions or renditions', async () => {
		mocks.findAllExhibitions.mockResolvedValue([
			exhibition({ posterStorageKey: 'legacy poster.webp' }),
		]);

		await expect(listExhibitions()).resolves.toEqual([
			expect.objectContaining({
				poster: {
					original: {
						url: 'https://assets.example.test/legacy%20poster.webp',
					},
					renditions: [],
				},
			}),
		]);
	});

	it('creates an exhibition when the year-title pair is unused', async () => {
		mocks.findExhibitionByComposite.mockResolvedValue(null);
		mocks.createExhibition.mockResolvedValue({ id: 7, year: 2027 });

		await expect(createExhibition({ year: 2027, title: 'Show' })).resolves.toEqual({
			id: 7,
			year: 2027,
		});
		expect(mocks.findExhibitionByComposite).toHaveBeenCalledWith(2027, 'Show');
		expect(mocks.createExhibition).toHaveBeenCalledWith({ year: 2027, title: 'Show' });
	});

	it('rejects duplicate exhibition year-title pairs', async () => {
		mocks.findExhibitionByComposite.mockResolvedValue({ id: 1 });

		await expect(createExhibition({ year: 2027 })).rejects.toMatchObject({
			statusCode: 409,
			code: 'CONFLICT',
		});
		expect(mocks.createExhibition).not.toHaveBeenCalled();
	});

	it('updates only fields present in the patch', async () => {
		mocks.findExhibitionById.mockResolvedValue(exhibition());
		mocks.updateExhibition.mockResolvedValue(exhibition({
			title: 'Updated',
			isUploadEnabled: false,
			_count: { projects: 2 },
		}));

		const result = await updateExhibition(1, { title: 'Updated', isUploadEnabled: false });

		expect(mocks.updateExhibition).toHaveBeenCalledWith(1, {
			title: 'Updated',
			isUploadEnabled: false,
		});
		expect(result).toMatchObject({
			title: 'Updated',
			isUploadEnabled: false,
			projectCount: 2,
		});
	});

	it('throws 404 when updating or deleting a missing exhibition', async () => {
		mocks.findExhibitionById.mockResolvedValue(null);
		mocks.deleteExhibition.mockResolvedValue(null);

		await expect(updateExhibition(404, { title: 'Missing' })).rejects.toMatchObject({
			statusCode: 404,
		});
		await expect(deleteExhibition(404)).rejects.toMatchObject({
			statusCode: 404,
		});
	});

	it('deletes the DB row with an outbox entry and wakes the deletion worker', async () => {
		mocks.deleteExhibition.mockResolvedValue(exhibition({
			posterStorageKey: 'old-poster.webp',
			cleanupQueued: true,
		}));

		await deleteExhibition(1);

		expect(mocks.deleteExhibition).toHaveBeenCalledWith(1, {
			publicBucket: 'public-bucket',
			protectedBucket: 'public-bucket',
			reason: 'exhibition-delete',
		});
		expect(mocks.wakeDeletionWorker).toHaveBeenCalledOnce();
	});

	it('does not wait for an unrelated deletion backlog after the poster outbox commits', async () => {
		mocks.deleteExhibition.mockResolvedValue(exhibition({
			posterStorageKey: 'old-poster.webp',
			cleanupQueued: true,
		}));

		await expect(deleteExhibition(1)).resolves.toBeUndefined();
		expect(mocks.wakeDeletionWorker).toHaveBeenCalledOnce();
		expect(mocks.logError).not.toHaveBeenCalled();
	});

	it('does not roll back a new poster after its DB pointer and old-object outbox commit', async () => {
		const rollback = vi.fn();
		const cleanup = vi.fn();
		mocks.findExhibitionById.mockResolvedValue(exhibition());
		mocks.posterUploadStart.mockResolvedValue({
			savedFile: {
				storageKey: 'new-poster.webp',
				mimeType: 'image/webp',
				sizeBytes: 123,
				originalName: 'poster.webp',
				kind: 'POSTER',
				width: 1200,
				height: 800,
				renditions: [{
					profile: 'CARD_480',
					width: 480,
					height: 320,
				}],
				uploadIntentIds: ['intent-original', 'intent-480'],
			},
			rollback,
			cleanup,
		});
		mocks.replaceExhibitionPoster.mockResolvedValue({
			updated: exhibition({
				posterStorageKey: 'new-poster.webp',
				posterWidth: 1200,
				posterHeight: 800,
				posterCard480Height: 320,
				posterDisplay960Height: null,
			}),
			oldStorageKey: 'old-poster.webp',
		});
		const parts = (async function* () {})();

		await expect(replacePoster(1, { actor: { id: 1, role: 'ADMIN' }, parts }))
			.resolves.toMatchObject({
				id: 1,
				poster: {
					original: { url: expect.stringContaining('new-poster.webp') },
				},
			});
		expect(rollback).not.toHaveBeenCalled();
		expect(cleanup).toHaveBeenCalledOnce();
		expect(mocks.wakeDeletionWorker).toHaveBeenCalledOnce();
		expect(mocks.logError).not.toHaveBeenCalled();
	});

	it('rolls back exactly one uploaded object when the pointer transaction fails', async () => {
		const rollback = vi.fn();
		const cleanup = vi.fn();
		mocks.findExhibitionById.mockResolvedValue(exhibition());
		mocks.posterUploadStart.mockResolvedValue({
			savedFile: {
				storageKey: 'unpersisted.webp',
				mimeType: 'image/webp',
				sizeBytes: 123,
				originalName: 'poster.webp',
				kind: 'POSTER',
			},
			rollback,
			cleanup,
		});
		mocks.replaceExhibitionPoster.mockRejectedValue(new Error('serialization exhausted'));

		await expect(replacePoster(1, {
			actor: { id: 1, role: 'ADMIN' },
			parts: (async function* () {})(),
		})).rejects.toThrow('serialization exhausted');
		expect(mocks.posterUploadStart).toHaveBeenCalledOnce();
		expect(rollback).toHaveBeenCalledOnce();
		expect(cleanup).toHaveBeenCalledOnce();
	});

	it('clears poster metadata and wakes the queued old-poster deletion', async () => {
		mocks.clearExhibitionPoster.mockResolvedValue({
			updated: exhibition(),
			oldStorageKey: 'old-poster.webp',
		});

		await deletePoster(1);

		expect(mocks.wakeDeletionWorker).toHaveBeenCalledOnce();
	});

	it('throws 404 when deleting a poster for a missing exhibition', async () => {
		mocks.clearExhibitionPoster.mockResolvedValue(null);

		await expect(deletePoster(404)).rejects.toMatchObject({
			statusCode: 404,
		});
	});

	it('retries only a bounded Serializable write conflict', async () => {
		const transaction = vi.fn()
			.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('write conflict', {
				code: 'P2034',
				clientVersion: 'test',
			}))
			.mockImplementationOnce(async (operation: (tx: object) => Promise<string>) => operation({}));
		const operation = vi.fn(async () => 'committed');
		const retries = vi.fn();

		await expect(withExhibitionMutationTransaction(
			{ $transaction: transaction } as never,
			operation as never,
			{ ...EXHIBITION_MUTATION_TRANSACTION_POLICY, onRetry: retries },
		)).resolves.toBe('committed');
		expect(transaction).toHaveBeenCalledTimes(2);
		expect(operation).toHaveBeenCalledOnce();
		expect(retries).toHaveBeenCalledOnce();
		expect(transaction.mock.calls[0]?.[1]).toEqual({
			isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
		});
	});
});
