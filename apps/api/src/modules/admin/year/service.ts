import type { AdminExhibitionItem, CreateExhibitionRequest, UpdateExhibitionRequest } from '@pcu/contracts';
import { notFound, conflict } from '../../../shared/errors.js';
import { serializePublicImage } from '../../public/image-serialization.js';
import type { ExhibitionRepository, ExhibitionRecord } from './ports.js';

export interface ExhibitionServiceDependencies {
	publicAssetOrigin?: string;
	posterBucket: string;
	protectedBucket?: string;
	repository: ExhibitionRepository;
	wakeDeletionWorker(): void;
}

function cleanupCommittedPoster(deps: ExhibitionServiceDependencies): void {
	deps.wakeDeletionWorker();
}

async function serializeExhibition(
	deps: ExhibitionServiceDependencies,
	e: ExhibitionRecord,
): Promise<AdminExhibitionItem> {
	const canonicalPoster = e.poster?.status === 'READY' && deps.publicAssetOrigin
		? await serializePublicImage(e.poster, {
			publicAssetOrigin: deps.publicAssetOrigin,
			publicBucket: deps.posterBucket,
		})
		: undefined;
	const original = canonicalPoster ? e.poster?.representations.find((representation) => (
		representation.role === 'ORIGINAL'
		&& representation.state === 'READY'
		&& representation.bucket === deps.posterBucket
	)) : undefined;
	return {
		id: e.id,
		year: e.year,
		title: e.title || undefined,
		isUploadEnabled: e.isUploadEnabled,
		sortOrder: e.sortOrder,
		projectCount: e._count.projects,
		poster: canonicalPoster,
		posterOriginalName: e.poster?.originalName || undefined,
		posterSize: original ? Number(original.sizeBytes) : undefined,
	};
}

/** List all exhibitions with project counts, mapped to API shape */
export async function listExhibitions(deps: ExhibitionServiceDependencies): Promise<AdminExhibitionItem[]> {
	const exhibitions = await deps.repository.findAllExhibitions();
	return Promise.all(exhibitions.map((exhibition) => serializeExhibition(deps, exhibition)));
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
	const deleted = await deps.repository.deleteExhibition(id, {
		publicBucket: deps.posterBucket,
		protectedBucket: deps.protectedBucket ?? deps.posterBucket,
		reason: 'exhibition-delete',
	});
	if (!deleted) throw notFound('Exhibition not found');

	if (deleted.cleanupQueued) {
		cleanupCommittedPoster(deps);
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

	return serializeExhibition(deps, updated);
}

export async function deletePoster(deps: ExhibitionServiceDependencies, id: number): Promise<void> {
	const result = await deps.repository.clearExhibitionPoster(id, {
		bucket: deps.posterBucket,
		reason: 'exhibition-poster-delete',
	});
	if (!result) throw notFound('Exhibition not found');

	if (result.cleanupQueued) {
		cleanupCommittedPoster(deps);
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
		deletePoster: (id: number) => deletePoster(deps, id),
	};
}
