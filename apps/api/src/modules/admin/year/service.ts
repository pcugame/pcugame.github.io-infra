import type { AdminExhibitionItem, CreateExhibitionRequest, UpdateExhibitionRequest } from '@pcu/contracts';
import { notFound, conflict } from '../../../shared/errors.js';
import type { UploadLimits } from '../../../shared/upload-limits.js';
import type { MultipartCommandInput } from '../../../application/http-input.js';
import type { PosterUploadCoordinator, ProcessedUpload } from '../../../application/upload-ports.js';
import type { ExhibitionRepository, ExhibitionRecord } from './ports.js';

export interface ExhibitionServiceDependencies {
	apiPublicUrl: string;
	posterBucket: string;
	repository: ExhibitionRepository;
	uploadLimits(role: MultipartCommandInput['actor']['role']): UploadLimits;
	uploadSlots: { acquire(): void; release(): void };
	posterUpload: PosterUploadCoordinator;
	deleteOrQueue(
		bucket: string,
		key: string,
		reason: string,
		context: Record<string, unknown>,
	): Promise<void>;
}

function exhibitionPosterUrl(deps: ExhibitionServiceDependencies, storageKey: string): string {
	return `${deps.apiPublicUrl}/api/public/exhibition-posters/${storageKey}`;
}

function serializeExhibition(
	deps: ExhibitionServiceDependencies,
	e: ExhibitionRecord,
): AdminExhibitionItem {
	return {
		id: e.id,
		year: e.year,
		title: e.title || undefined,
		isUploadEnabled: e.isUploadEnabled,
		sortOrder: e.sortOrder,
		projectCount: e._count.projects,
		posterUrl: e.posterStorageKey ? exhibitionPosterUrl(deps, e.posterStorageKey) : undefined,
		posterOriginalName: e.posterOriginalName || undefined,
		posterSize: e.posterStorageKey ? Number(e.posterSizeBytes) : undefined,
	};
}

/** List all exhibitions with project counts, mapped to API shape */
export async function listExhibitions(deps: ExhibitionServiceDependencies): Promise<AdminExhibitionItem[]> {
	const exhibitions = await deps.repository.findAllExhibitions();
	return exhibitions.map((exhibition) => serializeExhibition(deps, exhibition));
}

/** Create an exhibition after checking for duplicates */
export async function createExhibition(deps: ExhibitionServiceDependencies, data: CreateExhibitionRequest) {
	const existing = await deps.repository.findExhibitionByComposite(data.year, data.title || '');
	if (existing) throw conflict(`"${data.title || data.year}" 전시회가 이미 존재합니다`);

	const created = await deps.repository.createExhibition(data);
	return { id: created.id, year: created.year };
}

/** Delete an exhibition by ID. Throws 404 if not found. */
export async function deleteExhibition(deps: ExhibitionServiceDependencies, id: number) {
	const exhibition = await deps.repository.findExhibitionByIdWithCount(id);
	if (!exhibition) throw notFound('Exhibition not found');

	await deps.repository.deleteExhibition(id);

	if (exhibition.posterStorageKey) {
		await deps.deleteOrQueue(
			deps.posterBucket,
			exhibition.posterStorageKey,
			'exhibition-delete-poster',
			{ exhibitionId: id },
		);
	}
}

/** Partial-update an exhibition. Throws 404 if not found. Returns updated shape. */
export async function updateExhibition(
	deps: ExhibitionServiceDependencies,
	id: number,
	patch: UpdateExhibitionRequest,
): Promise<AdminExhibitionItem> {
	const exhibition = await deps.repository.findExhibitionById(id);
	if (!exhibition) throw notFound('Exhibition not found');

	const updated = await deps.repository.updateExhibition(id, {
		...(patch.title !== undefined ? { title: patch.title } : {}),
		...(patch.isUploadEnabled !== undefined ? { isUploadEnabled: patch.isUploadEnabled } : {}),
		...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
	});

	return {
		...serializeExhibition(deps, updated),
	};
}

export async function replacePoster(
	deps: ExhibitionServiceDependencies,
	id: number,
	input: MultipartCommandInput,
): Promise<AdminExhibitionItem> {
	const existing = await deps.repository.findExhibitionById(id);
	if (!existing) throw notFound('Exhibition not found');

	const limits = deps.uploadLimits(input.actor.role);
	let upload: ProcessedUpload | null = null;

	deps.uploadSlots.acquire();
	try {
		upload = await deps.posterUpload.start(input.parts, limits);
		const savedFile = upload.savedFile;
		const result = await deps.repository.replaceExhibitionPoster(id, {
			storageKey: savedFile.storageKey,
			originalName: savedFile.originalName,
			mimeType: savedFile.mimeType,
			sizeBytes: BigInt(savedFile.sizeBytes),
		});
		if (!result) throw notFound('Exhibition not found');

		if (result.oldStorageKey && result.oldStorageKey !== savedFile.storageKey) {
			await deps.deleteOrQueue(
				deps.posterBucket,
				result.oldStorageKey,
				'exhibition-poster-replace-previous',
				{ exhibitionId: id },
			);
		}

		return serializeExhibition(deps, result.updated);
	} catch (err) {
		if (upload) await upload.rollback();
		throw err;
	} finally {
		deps.uploadSlots.release();
		if (upload) await upload.cleanup();
	}
}

export async function deletePoster(deps: ExhibitionServiceDependencies, id: number): Promise<void> {
	const result = await deps.repository.clearExhibitionPoster(id);
	if (!result) throw notFound('Exhibition not found');

	if (result.oldStorageKey) {
		await deps.deleteOrQueue(
			deps.posterBucket,
			result.oldStorageKey,
			'exhibition-poster-delete',
			{ exhibitionId: id },
		);
	}
}

export function createExhibitionService(deps: ExhibitionServiceDependencies) {
	return {
		listExhibitions: () => listExhibitions(deps),
		createExhibition: (data: CreateExhibitionRequest) => createExhibition(deps, data),
		deleteExhibition: (id: number) => deleteExhibition(deps, id),
		updateExhibition: (id: number, patch: UpdateExhibitionRequest) => (
			updateExhibition(deps, id, patch)
		),
		replacePoster: (id: number, input: MultipartCommandInput) => replacePoster(deps, id, input),
		deletePoster: (id: number) => deletePoster(deps, id),
	};
}
