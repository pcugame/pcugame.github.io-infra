import { extname, join } from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type {
	AssetKind,
	Prisma,
	PrismaClient,
} from '../src/generated/prisma/client.js';
import type {
	AppLogger,
	FileSystem,
	IdGenerator,
} from '../src/application/ports.js';
import type {
	SavedUpload,
	UploadIntentOwner,
	UploadPipelinePort,
} from '../src/application/upload-ports.js';
import { assetImageRenditionReadiness } from '../src/modules/assets/image-rendition-lifecycle.js';
import { commitUploadIntents } from '../src/modules/upload-intent/repository.js';

export interface ScriptUploadSource {
	kind: AssetKind;
	filePath: string;
	originalName: string;
}

export interface ScriptUploadedAsset {
	source: ScriptUploadSource;
	saved: SavedUpload;
	converted: boolean;
}

export interface ScriptUploadItemResources {
	prisma: PrismaClient;
	fileSystem: FileSystem;
	ids: IdGenerator;
	logger: AppLogger;
	createUploadPipeline(): UploadPipelinePort;
}

function safeStagingExtension(filePath: string): string {
	const extension = extname(filePath).toLowerCase();
	return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '';
}

function wasConverted(saved: SavedUpload): boolean {
	if (saved.kind === 'GAME') return false;
	if (saved.kind === 'VIDEO') return saved.playbackStorageKey !== null
		&& saved.playbackStorageKey !== undefined;
	return true;
}

function combineFailure(
	current: unknown,
	next: unknown,
	message: string,
): unknown {
	return current === undefined ? next : new AggregateError([current, next], message);
}

/**
 * Own one script item's complete upload lifetime. Source/NAS files are copied
 * to request-owned staging paths; the production upload pipeline owns every
 * staged/derived temp file and every uncommitted object.
 */
export async function runScriptUploadItem<T>(
	resources: ScriptUploadItemResources,
	owner: UploadIntentOwner,
	sources: readonly ScriptUploadSource[],
	persist: (
		tx: Prisma.TransactionClient,
		uploads: readonly ScriptUploadedAsset[],
	) => Promise<T>,
): Promise<{ result: T; uploads: readonly ScriptUploadedAsset[] }> {
	const pipeline = resources.createUploadPipeline();
	pipeline.setOwner?.(owner);
	const uploads: ScriptUploadedAsset[] = [];
	let result!: T;
	let failure: unknown;
	let committed = false;

	try {
		for (const source of sources) {
			const stagedPath = join(
				resources.fileSystem.temporaryDirectory(),
				`script-upload-${resources.ids.next()}${safeStagingExtension(source.filePath)}`,
			);
			pipeline.trackTempFile(stagedPath);
			await streamPipeline(
				resources.fileSystem.createReadStream(source.filePath),
				resources.fileSystem.createWriteStream(stagedPath),
			);
			const saved = await pipeline.processFile(
				stagedPath,
				source.kind,
				source.originalName,
			);
			uploads.push({ source, saved, converted: wasConverted(saved) });
		}

		result = await resources.prisma.$transaction(async (tx) => {
			const persisted = await persist(tx, uploads);
			await commitUploadIntents(
				tx,
				uploads.flatMap(({ saved }) => saved.uploadIntentIds ?? []),
			);
			return persisted;
		});
		committed = true;
	} catch (error) {
		failure = error;
		try {
			await pipeline.rollbackCommitted();
		} catch (rollbackError) {
			failure = combineFailure(
				failure,
				rollbackError,
				'Script upload and durable rollback failed',
			);
		}
	}

	try {
		await pipeline.cleanupTemp();
	} catch (cleanupError) {
		if (committed) {
			resources.logger.error(
				{ error: cleanupError, owner },
				'Post-commit script upload temp cleanup failed',
			);
		} else {
			failure = combineFailure(
				failure,
				cleanupError,
				'Script upload and temp cleanup failed',
			);
		}
	}

	if (failure !== undefined) throw failure;
	return { result, uploads };
}

/** Persist the canonical object and all physical renditions for one Asset. */
export async function createScriptAsset(
	tx: Prisma.TransactionClient,
	projectId: number,
	upload: ScriptUploadedAsset,
): Promise<{ id: number }> {
	const saved = upload.saved;
	const created = await tx.asset.create({
		data: {
			projectId,
			kind: saved.kind,
			status: 'READY',
			storageKey: saved.storageKey,
			playbackStorageKey: saved.playbackStorageKey ?? null,
			originalName: saved.originalName,
			mimeType: saved.mimeType,
			playbackMimeType: saved.playbackMimeType ?? '',
			sizeBytes: BigInt(saved.sizeBytes),
		width: saved.width,
		height: saved.height,
		...assetImageRenditionReadiness(saved.renditions ?? []),
			playbackSizeBytes: BigInt(saved.playbackSizeBytes ?? 0),
			playbackStatus: saved.playbackStatus ?? 'PENDING',
			playbackError: saved.playbackError ?? '',
			isPublic: saved.kind !== 'GAME' && saved.kind !== 'VIDEO',
		},
		select: { id: true },
	});
	return created;
}
