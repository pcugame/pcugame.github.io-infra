import path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type {
	AppLogger,
	FileSystem,
	IdGenerator,
	ObjectStorage,
} from '../../application/ports.js';
import type {
	ImageRenditionProfile,
	PrismaClient,
} from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import { generateStorageKey } from '../../shared/storage-path.js';
import {
	IMAGE_RENDITION_TARGETS,
	ImageOutputCleanupError,
	processImageRenditions,
	type ProcessedImageRendition,
} from './upload/image-processing.js';
import {
	createIntentTrackedObjectUploader,
	type IntentTrackedObjectUploader,
} from './upload/intent-tracked-object-upload.js';
import { storageOptionsForAsset } from './upload/storage-policy.js';
import { commitUploadIntents } from '../upload-intent/repository.js';
import type { UploadIntentService } from '../upload-lifecycle/ports.js';
import type { ObjectDeletionCoordinator } from '../../application/object-deletion.js';
import { imageRenditionCreateManyData } from './image-rendition-lifecycle.js';
import {
	ASSET_MUTATION_TRANSACTION_POLICY,
	withAssetMutationTransaction,
} from './mutation-transaction.js';
import {
	EXHIBITION_MUTATION_TRANSACTION_POLICY,
	withExhibitionMutationTransaction,
} from '../admin/year/repository.js';

export type ImageRenditionBackfillOwner = 'all' | 'asset' | 'exhibition';

export interface ImageRenditionBackfillOptions {
	apply: boolean;
	limit?: number;
	owner: ImageRenditionBackfillOwner;
	concurrency: number;
	afterAssetId?: number;
	afterExhibitionId?: number;
}

export interface ImageRenditionBackfillSummary {
	scanned: number;
	metadataMissing: number;
	plannedCard480: number;
	plannedDisplay960: number;
	alreadyComplete: number;
	sourceObjectMissing: number;
	sourceChanged: number;
	succeeded: number;
	failed: number;
	resumeAfterAssetId?: number;
	resumeAfterExhibitionId?: number;
	failures: Array<{ owner: 'asset' | 'exhibition'; id: number; error: string }>;
}

interface RenditionRow {
	profile: ImageRenditionProfile;
	storageKey: string;
	sourceStorageKey: string;
}

interface AssetBackfillItem {
	owner: 'asset';
	id: number;
	projectId: number;
	kind: 'IMAGE' | 'POSTER' | 'THUMBNAIL';
	storageKey: string;
	width: number | null;
	height: number | null;
	imageRenditions: RenditionRow[];
}

interface ExhibitionBackfillItem {
	owner: 'exhibition';
	id: number;
	storageKey: string;
	width: number | null;
	height: number | null;
	imageRenditions: RenditionRow[];
}

type BackfillItem = AssetBackfillItem | ExhibitionBackfillItem;

interface UploadedRendition {
	profile: ImageRenditionProfile;
	storageKey: string;
	sourceStorageKey: string;
	width: number;
	height: number;
	mimeType: string;
	sizeBytes: number;
	intentId: string;
}

export interface ImageRenditionBackfillDependencies {
	prisma: PrismaClient;
	storage: Pick<ObjectStorage, 'stream' | 'upload'>;
	fileSystem: FileSystem;
	ids: IdGenerator;
	logger: Pick<AppLogger, 'info' | 'warn' | 'error'>;
	publicBucket: string;
	uploadIntents: Pick<
		UploadIntentService,
		'prepare' | 'markUploaded' | 'recordAmbiguousError' | 'isUncommitted'
	>;
	orphanDeletions: Pick<ObjectDeletionCoordinator, 'deleteOrQueue'>;
}

class SourceObjectMissingError extends Error {
	constructor(readonly storageKey: string) {
		super(`Canonical source object is missing: ${storageKey}`);
		this.name = 'SourceObjectMissingError';
	}
}

class SourceChangedError extends Error {
	constructor(owner: BackfillItem['owner'], id: number) {
		super(`${owner} ${id} canonical source changed during rendition backfill`);
		this.name = 'SourceChangedError';
	}
}

class RenditionSourceMismatchError extends Error {
	constructor(owner: BackfillItem['owner'], id: number) {
		super(`${owner} ${id} has a rendition from a mismatched source generation`);
		this.name = 'RenditionSourceMismatchError';
	}
}

function parseIntegerFlag(name: string, raw: string | undefined, minimum: number, maximum?: number): number {
	if (!raw || !/^\d+$/.test(raw)) {
		throw new Error(`${name} must be an integer`);
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < minimum || (maximum !== undefined && value > maximum)) {
		throw new Error(`${name} must be between ${minimum} and ${maximum ?? Number.MAX_SAFE_INTEGER}`);
	}
	return value;
}

function optionValue(args: readonly string[], index: number): { value?: string; consumed: number } {
	const argument = args[index]!;
	const equals = argument.indexOf('=');
	if (equals >= 0) return { value: argument.slice(equals + 1), consumed: 0 };
	return { value: args[index + 1], consumed: 1 };
}

export function parseImageRenditionBackfillOptions(
	args: readonly string[],
): ImageRenditionBackfillOptions {
	const options: ImageRenditionBackfillOptions = {
		apply: false,
		owner: 'all',
		concurrency: 1,
	};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index]!;
		if (argument === '--apply') {
			options.apply = true;
			continue;
		}
		if (argument === '--limit' || argument.startsWith('--limit=')) {
			const parsed = optionValue(args, index);
			options.limit = parseIntegerFlag('--limit', parsed.value, 1);
			index += parsed.consumed;
			continue;
		}
		if (argument === '--concurrency' || argument.startsWith('--concurrency=')) {
			const parsed = optionValue(args, index);
			options.concurrency = parseIntegerFlag('--concurrency', parsed.value, 1, 4);
			index += parsed.consumed;
			continue;
		}
		if (argument === '--owner' || argument.startsWith('--owner=')) {
			const parsed = optionValue(args, index);
			if (parsed.value !== 'all' && parsed.value !== 'asset' && parsed.value !== 'exhibition') {
				throw new Error('--owner must be all, asset, or exhibition');
			}
			options.owner = parsed.value;
			index += parsed.consumed;
			continue;
		}
		if (argument === '--after-asset-id' || argument.startsWith('--after-asset-id=')) {
			const parsed = optionValue(args, index);
			options.afterAssetId = parseIntegerFlag('--after-asset-id', parsed.value, 0);
			index += parsed.consumed;
			continue;
		}
		if (argument === '--after-exhibition-id' || argument.startsWith('--after-exhibition-id=')) {
			const parsed = optionValue(args, index);
			options.afterExhibitionId = parseIntegerFlag('--after-exhibition-id', parsed.value, 0);
			index += parsed.consumed;
			continue;
		}
		throw new Error(`Unknown backfill option: ${argument}`);
	}
	return options;
}

function requestedProfiles(item: BackfillItem): ImageRenditionProfile[] {
	if (item.owner === 'asset' && item.kind === 'THUMBNAIL') return [];
	const currentProfiles = new Set(item.imageRenditions
		.filter((rendition) => rendition.sourceStorageKey === item.storageKey)
		.map((rendition) => rendition.profile));
	return IMAGE_RENDITION_TARGETS.flatMap((target) => {
		if (currentProfiles.has(target.profile)) return [];
		if (item.width !== null && item.width <= target.width) return [];
		return [target.profile];
	});
}

function isAlreadyComplete(item: BackfillItem, profiles: readonly ImageRenditionProfile[]): boolean {
	return item.width !== null && item.height !== null && profiles.length === 0;
}

async function loadItems(
	deps: ImageRenditionBackfillDependencies,
	options: ImageRenditionBackfillOptions,
): Promise<BackfillItem[]> {
	const take = options.limit;
	const [assets, exhibitions] = await Promise.all([
		options.owner === 'exhibition'
			? Promise.resolve([])
			: deps.prisma.asset.findMany({
				where: {
					id: { gt: options.afterAssetId ?? 0 },
					status: 'READY',
					isPublic: true,
					kind: { in: ['IMAGE', 'POSTER', 'THUMBNAIL'] },
				},
				orderBy: { id: 'asc' },
				...(take ? { take } : {}),
				select: {
					id: true,
					projectId: true,
					kind: true,
					storageKey: true,
					width: true,
					height: true,
					imageRenditions: {
						select: { profile: true, storageKey: true, sourceStorageKey: true },
					},
				},
			}),
		options.owner === 'asset'
			? Promise.resolve([])
			: deps.prisma.exhibition.findMany({
				where: {
					id: { gt: options.afterExhibitionId ?? 0 },
					posterStorageKey: { not: null },
				},
				orderBy: { id: 'asc' },
				...(take ? { take } : {}),
				select: {
					id: true,
					posterStorageKey: true,
					posterWidth: true,
					posterHeight: true,
					imageRenditions: {
						select: { profile: true, storageKey: true, sourceStorageKey: true },
					},
				},
			}),
	]);
	const assetItems: AssetBackfillItem[] = assets.map((asset) => ({
		owner: 'asset',
		id: asset.id,
		projectId: asset.projectId,
		kind: asset.kind as AssetBackfillItem['kind'],
		storageKey: asset.storageKey,
		width: asset.width,
		height: asset.height,
		imageRenditions: asset.imageRenditions,
	}));
	const exhibitionItems: ExhibitionBackfillItem[] = exhibitions.map((exhibition) => ({
		owner: 'exhibition',
		id: exhibition.id,
		storageKey: exhibition.posterStorageKey!,
		width: exhibition.posterWidth,
		height: exhibition.posterHeight,
		imageRenditions: exhibition.imageRenditions,
	}));
	if (options.owner === 'asset') return assetItems;
	if (options.owner === 'exhibition') return exhibitionItems;
	const interleaved: BackfillItem[] = [];
	const count = Math.max(assetItems.length, exhibitionItems.length);
	for (let index = 0; index < count; index += 1) {
		if (assetItems[index]) interleaved.push(assetItems[index]!);
		if (exhibitionItems[index]) interleaved.push(exhibitionItems[index]!);
	}
	// With --owner=all the limit applies independently to each owner namespace.
	// This avoids permanently starving exhibitions when a small global limit is
	// repeatedly resumed while asset IDs continue to exist.
	return interleaved;
}

async function uploadRenditions(
	deps: ImageRenditionBackfillDependencies,
	item: BackfillItem,
	renditions: readonly ProcessedImageRendition[],
	uploaded: UploadedRendition[],
	objectUploads: IntentTrackedObjectUploader,
): Promise<void> {
	for (const rendition of renditions) {
		const storageKey = generateStorageKey(rendition.ext, deps.ids.next());
		const { intentId } = await objectUploads.upload({
			bucket: deps.publicBucket,
			storageKey,
			purpose: `backfill-image-rendition-${rendition.profile.toLowerCase()}`,
			owner: item.owner === 'asset'
				? { projectId: item.projectId }
				: { exhibitionId: item.id },
			createBody: () => deps.fileSystem.createReadStream(rendition.tmpPath),
			contentType: rendition.mimeType,
			contentLength: rendition.sizeBytes,
			storageOptions: storageOptionsForAsset('IMAGE', 'rendition'),
			rollbackReason: 'backfill-image-rendition-unpersisted',
			rollbackContext: { profile: rendition.profile },
			logContext: {
				profile: rendition.profile,
				owner: item.owner,
				ownerId: item.id,
			},
		});
		if (!intentId) {
			throw new Error('Backfill upload intent was not prepared');
		}
		const record: UploadedRendition = {
			profile: rendition.profile,
			storageKey,
			sourceStorageKey: item.storageKey,
			width: rendition.width,
			height: rendition.height,
			mimeType: rendition.mimeType,
			sizeBytes: rendition.sizeBytes,
			intentId,
		};
		uploaded.push(record);
	}
}

async function replaceStaleProfileRows(
	tx: Prisma.TransactionClient,
	deps: ImageRenditionBackfillDependencies,
	item: BackfillItem,
	uploaded: readonly UploadedRendition[],
): Promise<void> {
	if (uploaded.length === 0) return;
	const ownerWhere = item.owner === 'asset'
		? { assetId: item.id }
		: { exhibitionId: item.id };
	const existing = await tx.imageRendition.findMany({
		where: {
			...ownerWhere,
			profile: { in: uploaded.map(({ profile }) => profile) },
		},
		select: { storageKey: true, sourceStorageKey: true, profile: true },
	});
	const mismatched = existing.filter((row) => row.sourceStorageKey !== item.storageKey);
	if (mismatched.length > 0) {
		for (const row of mismatched) {
			deps.logger.error(
				{
					owner: item.owner,
					id: item.id,
					profile: row.profile,
					storageKey: row.storageKey,
					sourceStorageKey: row.sourceStorageKey,
					currentSource: item.storageKey,
				},
				'Backfill found a rendition from a mismatched source generation',
			);
		}
		throw new RenditionSourceMismatchError(item.owner, item.id);
	}
	if (existing.length > 0) throw new SourceChangedError(item.owner, item.id);
	await tx.imageRendition.createMany({
		data: imageRenditionCreateManyData(
			item.owner === 'asset' ? { assetId: item.id } : { exhibitionId: item.id },
			item.storageKey,
			uploaded,
		),
	});
}

async function commitAssetItem(
	deps: ImageRenditionBackfillDependencies,
	item: AssetBackfillItem,
	dimensions: { width: number; height: number },
	uploaded: readonly UploadedRendition[],
): Promise<void> {
	await withAssetMutationTransaction(deps.prisma, async (tx) => {
		const projects = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
			SELECT "id" FROM "projects" WHERE "id" = ${item.projectId} FOR UPDATE
		`);
		if (projects.length === 0) throw new SourceChangedError(item.owner, item.id);
		const assets = await tx.$queryRaw<Array<{ storageKey: string; status: string }>>(Prisma.sql`
			SELECT "storage_key" AS "storageKey", "status"::text AS "status"
			FROM "assets" WHERE "id" = ${item.id} FOR UPDATE
		`);
		if (assets[0]?.storageKey !== item.storageKey || assets[0]?.status !== 'READY') {
			throw new SourceChangedError(item.owner, item.id);
		}
		await replaceStaleProfileRows(tx, deps, item, uploaded);
		await tx.asset.update({
			where: { id: item.id },
			data: dimensions,
			select: { id: true },
		});
		await commitUploadIntents(tx, uploaded.map(({ intentId }) => intentId));
	}, ASSET_MUTATION_TRANSACTION_POLICY);
}

async function commitExhibitionItem(
	deps: ImageRenditionBackfillDependencies,
	item: ExhibitionBackfillItem,
	dimensions: { width: number; height: number },
	uploaded: readonly UploadedRendition[],
): Promise<void> {
	await withExhibitionMutationTransaction(deps.prisma, async (tx) => {
		const exhibitions = await tx.$queryRaw<Array<{ posterStorageKey: string | null }>>(Prisma.sql`
			SELECT "poster_storage_key" AS "posterStorageKey"
			FROM "exhibitions" WHERE "id" = ${item.id} FOR UPDATE
		`);
		if (exhibitions[0]?.posterStorageKey !== item.storageKey) {
			throw new SourceChangedError(item.owner, item.id);
		}
		await replaceStaleProfileRows(tx, deps, item, uploaded);
		await tx.exhibition.update({
			where: { id: item.id },
			data: { posterWidth: dimensions.width, posterHeight: dimensions.height },
			select: { id: true },
		});
		await commitUploadIntents(tx, uploaded.map(({ intentId }) => intentId));
	}, EXHIBITION_MUTATION_TRANSACTION_POLICY);
}

type ItemOutcome =
	| { kind: 'complete'; item: BackfillItem }
	| {
		kind: 'success';
		item: BackfillItem;
		metadataMissing: boolean;
		planned: ImageRenditionProfile[];
	}
	| {
		kind: 'source-changed';
		item: BackfillItem;
		metadataMissing: boolean;
		planned: ImageRenditionProfile[];
	}
	| {
		kind: 'failure';
		item: BackfillItem;
		metadataMissing: boolean;
		planned: ImageRenditionProfile[];
		sourceMissing: boolean;
		error: unknown;
	};

async function processItem(
	deps: ImageRenditionBackfillDependencies,
	options: ImageRenditionBackfillOptions,
	item: BackfillItem,
): Promise<ItemOutcome> {
	const profiles = requestedProfiles(item);
	const metadataMissing = item.width === null || item.height === null;
	if (isAlreadyComplete(item, profiles)) return { kind: 'complete', item };

	const sourcePath = path.join(
		deps.fileSystem.temporaryDirectory(),
		`image-rendition-backfill-${item.owner}-${item.id}-${deps.ids.next()}`,
	);
	const temporaryPaths = new Set([sourcePath]);
	const uploaded: UploadedRendition[] = [];
	const objectUploads = createIntentTrackedObjectUploader({
		storage: deps.storage,
		uploadIntents: deps.uploadIntents,
		deleteUnpersistedObject: ({ bucket, storageKey, reason, context, intentId }) => (
			deps.orphanDeletions.deleteOrQueue(
				bucket,
				storageKey,
				reason,
				{
					...(intentId ? { intentId } : {}),
					...(context ?? {}),
				},
			)
		),
		logger: deps.logger,
		uploadStreamFailureMessage: 'Backfill rendition upload and request-stream cleanup failed',
		rollbackFailureMessage: 'Backfill rendition durable rollback failed',
		ambiguousErrorLogMessage: 'Failed to annotate backfill upload intent',
	});
	let committed = false;
	let planned: ImageRenditionProfile[] = [];
	let outcome: ItemOutcome;
	try {
		const object = await deps.storage.stream(deps.publicBucket, item.storageKey);
		if (!object) throw new SourceObjectMissingError(item.storageKey);
		await streamPipeline(object.body, deps.fileSystem.createWriteStream(sourcePath));
		let result: Awaited<ReturnType<typeof processImageRenditions>>;
		try {
			result = await processImageRenditions({ tmpPath: sourcePath, profiles }, deps.fileSystem);
		} catch (error) {
			if (error instanceof ImageOutputCleanupError) {
				for (const residuePath of error.residuePaths) temporaryPaths.add(residuePath);
			}
			throw error;
		}
		for (const rendition of result.renditions) temporaryPaths.add(rendition.tmpPath);
		planned = result.renditions.map(({ profile }) => profile);
		if (!options.apply) {
			outcome = { kind: 'success', item, metadataMissing, planned };
		} else {
			await uploadRenditions(deps, item, result.renditions, uploaded, objectUploads);
			const dimensions = { width: result.width, height: result.height };
			if (item.owner === 'asset') {
				await commitAssetItem(deps, item, dimensions, uploaded);
			} else {
				await commitExhibitionItem(deps, item, dimensions, uploaded);
			}
			committed = true;
			outcome = { kind: 'success', item, metadataMissing, planned };
		}
	} catch (error) {
		let finalError: unknown = error;
		let rollbackFailed = false;
		if (!committed) {
			try {
				await objectUploads.rollback();
			} catch (rollbackError) {
				rollbackFailed = true;
				finalError = new AggregateError(
					[error, rollbackError],
					'Backfill item and durable rollback failed',
				);
			}
		}
		if (error instanceof SourceChangedError && !rollbackFailed) {
			outcome = {
				kind: 'source-changed',
				item,
				metadataMissing,
				planned,
			};
		} else {
			outcome = {
				kind: 'failure',
				item,
				metadataMissing,
				planned,
				sourceMissing: error instanceof SourceObjectMissingError,
				error: finalError,
			};
		}
	}

	const cleanupErrors: unknown[] = [];
	for (const temporaryPath of temporaryPaths) {
		await deps.fileSystem.remove(temporaryPath).catch((error) => {
			const missing = typeof error === 'object'
				&& error !== null
				&& 'code' in error
				&& error.code === 'ENOENT';
			if (!missing) {
				cleanupErrors.push(error);
				deps.logger.warn(
					{ error, temporaryPath, owner: item.owner, ownerId: item.id },
					'Backfill temporary-file cleanup failed',
				);
			}
		});
	}
	if (cleanupErrors.length > 0) {
		const cleanupError = new AggregateError(
			cleanupErrors,
			'Backfill temporary-file cleanup failed',
		);
		return {
			kind: 'failure',
			item,
			metadataMissing,
			planned,
			sourceMissing: outcome.kind === 'failure' && outcome.sourceMissing,
			error: outcome.kind === 'failure'
				? new AggregateError([outcome.error, cleanupError], 'Backfill item and cleanup failed')
				: cleanupError,
		};
	}
	return outcome;
}

async function mapConcurrent<T, R>(
	items: readonly T[],
	concurrency: number,
	operation: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (nextIndex < items.length) {
			const index = nextIndex++;
			results[index] = await operation(items[index]!);
		}
	}));
	return results;
}

function errorMessage(error: unknown): string {
	return String(error instanceof Error ? error.message : error).slice(0, 2_000);
}

/**
 * Scan positions are input cursors. Returned cursors advance only through each
 * owner's contiguous successful prefix, so a failed lower ID is never hidden
 * behind a concurrently completed higher ID on resume.
 */
export async function backfillImageRenditions(
	deps: ImageRenditionBackfillDependencies,
	options: ImageRenditionBackfillOptions,
): Promise<ImageRenditionBackfillSummary> {
	const items = await loadItems(deps, options);
	const outcomes = await mapConcurrent(
		items,
		options.concurrency,
		(item) => processItem(deps, options, item),
	);
	const summary: ImageRenditionBackfillSummary = {
		scanned: items.length,
		metadataMissing: 0,
		plannedCard480: 0,
		plannedDisplay960: 0,
		alreadyComplete: 0,
		sourceObjectMissing: 0,
		sourceChanged: 0,
		succeeded: 0,
		failed: 0,
		...(options.afterAssetId !== undefined
			? { resumeAfterAssetId: options.afterAssetId }
			: {}),
		...(options.afterExhibitionId !== undefined
			? { resumeAfterExhibitionId: options.afterExhibitionId }
			: {}),
		failures: [],
	};
	const cursorBlocked = { asset: false, exhibition: false };
	for (const outcome of outcomes) {
		if (outcome.kind === 'complete') summary.alreadyComplete++;
		else {
			if (outcome.metadataMissing) summary.metadataMissing++;
			summary.plannedCard480 += outcome.planned.includes('CARD_480') ? 1 : 0;
			summary.plannedDisplay960 += outcome.planned.includes('DISPLAY_960') ? 1 : 0;
		}
		if (outcome.kind === 'source-changed') summary.sourceChanged++;
		else if (outcome.kind === 'failure') {
			summary.failed++;
			if (outcome.sourceMissing) summary.sourceObjectMissing++;
			summary.failures.push({
				owner: outcome.item.owner,
				id: outcome.item.id,
				error: errorMessage(outcome.error),
			});
		} else {
			summary.succeeded++;
		}

		const owner = outcome.item.owner;
		if (outcome.kind === 'failure' || outcome.kind === 'source-changed') {
			cursorBlocked[owner] = true;
		} else if (!cursorBlocked[owner]) {
			if (owner === 'asset') summary.resumeAfterAssetId = outcome.item.id;
			else summary.resumeAfterExhibitionId = outcome.item.id;
		}
	}
	return summary;
}
