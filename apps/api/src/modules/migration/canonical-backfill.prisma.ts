import { randomUUID } from 'node:crypto';
import {
	Prisma,
	type PrismaClient,
} from '../../generated/prisma/client.js';
import { withAssetMutationTransaction } from '../assets/mutation-transaction.js';
import { parseWebglEntryKey, parseWebglSourceKey } from '../webgl/paths.js';
import type {
	CanonicalApplyOutcome,
	CanonicalAssetPlan,
	CanonicalBackfillRepository,
	CanonicalExhibitionPlan,
	CanonicalRepresentationPlan,
	CanonicalWebglPlan,
	LegacyAssetRow,
	LegacyExhibitionRow,
	LegacyWebglRow,
	LegacyWebglSourceProof,
} from './canonical-backfill.types.js';

type TransactionClient = Prisma.TransactionClient;

const assetSelect = {
	id: true,
	projectId: true,
	exhibitionId: true,
	kind: true,
	status: true,
	storageKey: true,
	playbackStorageKey: true,
	originalName: true,
	mimeType: true,
	playbackMimeType: true,
	sizeBytes: true,
	playbackSizeBytes: true,
	playbackStatus: true,
	isPublic: true,
	width: true,
	height: true,
	card480Height: true,
	display960Height: true,
	updatedAt: true,
} as const;

const exhibitionSelect = {
	id: true,
	posterAssetId: true,
	posterStorageKey: true,
	posterOriginalName: true,
	posterMimeType: true,
	posterSizeBytes: true,
	posterWidth: true,
	posterHeight: true,
	posterCard480Height: true,
	posterDisplay960Height: true,
	updatedAt: true,
} as const;

function completedResultProvesSource(
	result: unknown,
	storageKey: string,
	totalBytes: bigint,
): boolean {
	if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
	const record = result as Record<string, unknown>;
	return record['status'] === 'COMPLETED'
		&& record['storageKey'] === storageKey
		&& typeof record['sizeBytes'] === 'number'
		&& Number.isSafeInteger(record['sizeBytes'])
		&& BigInt(record['sizeBytes']) === totalBytes;
}

async function sourceProofForProject(
	client: PrismaClient | TransactionClient,
	projectId: number,
	entryKey: string,
): Promise<LegacyWebglSourceProof | null> {
	const entryGeneration = parseWebglEntryKey(projectId, entryKey);
	if (!entryGeneration) return null;
	const candidates = await client.gameUploadSession.findMany({
		where: {
			projectId,
			uploadKind: 'WEBGL',
			status: 'COMPLETED',
			storageKey: { not: null },
		},
		select: {
			id: true,
			storageKey: true,
			s3Key: true,
			originalName: true,
			totalBytes: true,
			completionResult: true,
			updatedAt: true,
		},
	});
	const provenCandidates = candidates.filter((candidate) => {
		if (!candidate.storageKey || candidate.s3Key !== candidate.storageKey
			|| !completedResultProvesSource(candidate.completionResult, candidate.storageKey, candidate.totalBytes)) return false;
		const sourceGeneration = parseWebglSourceKey(projectId, candidate.storageKey);
		return sourceGeneration?.deploymentId === entryGeneration.deploymentId;
	});
	// Selecting the newest completed upload guesses ownership. Ambiguous proof is
	// deliberately unresolved until an operator reconciles the legacy rows.
	if (provenCandidates.length !== 1) return null;
	const proven = provenCandidates[0]!;
	return proven?.storageKey ? {
		sessionId: proven.id,
		deploymentId: entryGeneration.deploymentId,
		storageKey: proven.storageKey,
		originalName: proven.originalName,
		totalBytes: proven.totalBytes,
		updatedAt: proven.updatedAt,
	} : null;
}

async function toWebglRow(
	client: PrismaClient | TransactionClient,
	project: {
		id: number;
		webglEntryKey: string;
		currentWebglDeploymentId: string | null;
		updatedAt: Date;
	},
): Promise<LegacyWebglRow> {
	const sourceProof = project.currentWebglDeploymentId
		? null
		: await sourceProofForProject(client, project.id, project.webglEntryKey);
	const sourceAsset = sourceProof ? await client.asset.findUnique({
		where: { storageKey: sourceProof.storageKey },
		select: { id: true, projectId: true, status: true, kind: true },
	}) : null;
	return {
		...project,
		sourceProof,
		sourceLegacyAssetId: sourceAsset?.projectId === project.id
			&& sourceAsset.status === 'READY'
			&& (sourceAsset.kind === 'GAME' || sourceAsset.kind === 'WEBGL')
			? sourceAsset.id
			: null,
	};
}
function sameDate(left: Date, right: Date): boolean {
	return left.getTime() === right.getTime();
}

function assertAssetSnapshot(current: LegacyAssetRow, planned: LegacyAssetRow): void {
	const fields: Array<keyof LegacyAssetRow> = [
		'projectId', 'exhibitionId', 'kind', 'status', 'storageKey', 'playbackStorageKey',
		'originalName', 'mimeType', 'playbackMimeType', 'sizeBytes', 'playbackSizeBytes',
		'playbackStatus', 'isPublic', 'width', 'height', 'card480Height', 'display960Height',
	];
	if (!sameDate(current.updatedAt, planned.updatedAt)
		|| fields.some((field) => current[field] !== planned[field])) {
		throw new Error(`asset ${planned.id} changed concurrently`);
	}
}

function assertExhibitionSnapshot(current: LegacyExhibitionRow, planned: LegacyExhibitionRow): void {
	const fields: Array<keyof LegacyExhibitionRow> = [
		'posterAssetId',
		'posterStorageKey', 'posterOriginalName', 'posterMimeType', 'posterSizeBytes',
		'posterWidth', 'posterHeight', 'posterCard480Height', 'posterDisplay960Height',
	];
	if (!sameDate(current.updatedAt, planned.updatedAt)
		|| fields.some((field) => current[field] !== planned[field])) {
		throw new Error(`exhibition ${planned.id} changed concurrently`);
	}
}

function representationData(plan: CanonicalRepresentationPlan) {
	return {
		bucket: plan.bucket,
		objectKey: plan.objectKey,
		mimeType: plan.mimeType,
		sizeBytes: plan.sizeBytes,
		checksumAlgorithm: plan.checksumAlgorithm,
		checksum: plan.checksum,
		etag: plan.etag,
		sourceIdentityAlgorithm: plan.sourceIdentityAlgorithm,
		sourceIdentity: plan.sourceIdentity,
		state: 'READY' as const,
		error: null,
		width: plan.width,
		height: plan.height,
	};
}

async function upsertRepresentations(
	tx: TransactionClient,
	assetId: number,
	plans: readonly CanonicalRepresentationPlan[],
): Promise<void> {
	for (const plan of plans) {
		await tx.assetRepresentation.upsert({
			where: {
				asset_representation_asset_role: { assetId, role: plan.role },
			},
			create: {
				id: randomUUID(),
				assetId,
				role: plan.role,
				...representationData(plan),
			},
			update: representationData(plan),
		});
	}
}

async function lockAsset(tx: TransactionClient, id: number): Promise<LegacyAssetRow> {
	await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "assets" WHERE "id" = ${id} FOR UPDATE`);
	const row = await tx.asset.findUnique({ where: { id }, select: assetSelect });
	if (!row) throw new Error(`asset ${id} changed concurrently`);
	return row;
}

async function lockExhibition(tx: TransactionClient, id: number): Promise<LegacyExhibitionRow> {
	await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "exhibitions" WHERE "id" = ${id} FOR UPDATE`);
	const row = await tx.exhibition.findUnique({ where: { id }, select: exhibitionSelect });
	if (!row) throw new Error(`exhibition ${id} changed concurrently`);
	return row;
}

export function createCanonicalBackfillRepository(
	client: PrismaClient,
): CanonicalBackfillRepository {
	return {
		async listAssets(afterId, limit) {
			return client.asset.findMany({
				where: { id: { gt: afterId } },
				orderBy: { id: 'asc' },
				take: limit,
				select: assetSelect,
			});
		},
		async listExhibitions(afterId, limit) {
			return client.exhibition.findMany({
				where: { id: { gt: afterId } },
				orderBy: { id: 'asc' },
				take: limit,
				select: exhibitionSelect,
			});
		},
		async listWebglProjects(afterId, limit) {
			const projects = await client.project.findMany({
				where: { id: { gt: afterId }, webglEntryKey: { not: '' } },
				orderBy: { id: 'asc' },
				take: limit,
				select: {
					id: true,
					webglEntryKey: true,
					currentWebglDeploymentId: true,
					updatedAt: true,
				},
			});
			return Promise.all(projects.map((project) => toWebglRow(client, project)));
		},
		async getAsset(id) {
			return client.asset.findUnique({ where: { id }, select: assetSelect });
		},
		getExhibition(id) {
			return client.exhibition.findUnique({ where: { id }, select: exhibitionSelect });
		},
		async getWebglProject(id) {
			const project = await client.project.findUnique({
				where: { id },
				select: {
					id: true,
					webglEntryKey: true,
					currentWebglDeploymentId: true,
					updatedAt: true,
				},
			});
			return project ? toWebglRow(client, project) : null;
		},
		applyAsset(plan: CanonicalAssetPlan): Promise<CanonicalApplyOutcome> {
			return withAssetMutationTransaction(client, async (tx) => {
				const current = await lockAsset(tx, plan.row.id);
				assertAssetSnapshot(current, plan.row);
				await upsertRepresentations(tx, plan.row.id, plan.representations);
				return {
					assetsCreated: 0,
					representationsUpserted: plan.representations.length,
					deploymentsUpserted: 0,
				};
			});
		},
		applyExhibition(plan: CanonicalExhibitionPlan): Promise<CanonicalApplyOutcome> {
			return withAssetMutationTransaction(client, async (tx) => {
				const current = await lockExhibition(tx, plan.row.id);
				assertExhibitionSnapshot(current, plan.row);
				let assetId = current.posterAssetId;
				let assetsCreated = 0;
				if (assetId === null) {
					const asset = await tx.asset.create({
						data: {
							projectId: null,
							exhibitionId: plan.row.id,
							kind: 'POSTER',
							status: 'READY',
							storageKey: null,
							originalName: plan.row.posterOriginalName,
							mimeType: plan.row.posterMimeType,
							sizeBytes: plan.row.posterSizeBytes,
							width: plan.row.posterWidth,
							height: plan.row.posterHeight,
							card480Height: plan.row.posterCard480Height,
							display960Height: plan.row.posterDisplay960Height,
							isPublic: true,
						},
						select: { id: true },
					});
					assetId = asset.id;
					assetsCreated = 1;
				} else {
					const existing = await tx.asset.findUnique({
						where: { id: assetId },
						select: { exhibitionId: true, projectId: true, kind: true },
					});
					if (!existing || existing.exhibitionId !== plan.row.id
						|| existing.projectId !== null || existing.kind !== 'POSTER') {
						throw new Error(`exhibition ${plan.row.id} canonical poster conflicts with its owner`);
					}
				}
				await upsertRepresentations(tx, assetId, plan.representations);
				if (current.posterAssetId === null) {
					await tx.exhibition.update({
						where: { id: plan.row.id },
						data: { posterAssetId: assetId },
					});
				}
				return {
					assetsCreated,
					representationsUpserted: plan.representations.length,
					deploymentsUpserted: 0,
				};
			});
		},
		applyWebgl(plan: CanonicalWebglPlan): Promise<CanonicalApplyOutcome> {
			return withAssetMutationTransaction(client, async (tx) => {
				await tx.$queryRaw(Prisma.sql`
					SELECT "id" FROM "projects" WHERE "id" = ${plan.row.id} FOR UPDATE
				`);
				const current = await tx.project.findUnique({
					where: { id: plan.row.id },
					select: { webglEntryKey: true, currentWebglDeploymentId: true, updatedAt: true },
				});
				if (!current || current.webglEntryKey !== plan.row.webglEntryKey) {
					throw new Error(`webgl ${plan.row.id} changed concurrently`);
				}
				if (current.currentWebglDeploymentId !== null) {
					if (current.currentWebglDeploymentId !== plan.deploymentId) {
						throw new Error(`webgl ${plan.row.id} canonical deployment conflicts with its pointer`);
					}
					return { assetsCreated: 0, representationsUpserted: 0, deploymentsUpserted: 0 };
				}
				if (!sameDate(current.updatedAt, plan.row.updatedAt) || !plan.row.sourceProof) {
					throw new Error(`webgl ${plan.row.id} changed concurrently`);
				}
				await tx.$queryRaw(Prisma.sql`
					SELECT "id" FROM "game_upload_sessions"
					WHERE "id" = ${plan.row.sourceProof.sessionId} FOR UPDATE
				`);
				const proof = await sourceProofForProject(tx, plan.row.id, plan.row.webglEntryKey);
				if (!proof || proof.sessionId !== plan.row.sourceProof.sessionId
					|| proof.deploymentId !== plan.row.sourceProof.deploymentId
					|| proof.storageKey !== plan.row.sourceProof.storageKey
					|| proof.totalBytes !== plan.row.sourceProof.totalBytes
					|| proof.originalName !== plan.row.sourceProof.originalName
					|| !sameDate(proof.updatedAt, plan.row.sourceProof.updatedAt)) {
					throw new Error(`webgl ${plan.row.id} source proof changed concurrently`);
				}
				let assetId = plan.row.sourceLegacyAssetId;
				let assetsCreated = 0;
				if (assetId !== null) {
					const legacySource = await lockAsset(tx, assetId);
					if (legacySource.projectId !== plan.row.id
						|| legacySource.storageKey !== proof.storageKey
						|| legacySource.status !== 'READY'
						|| (legacySource.kind !== 'GAME' && legacySource.kind !== 'WEBGL')) {
						throw new Error(`webgl ${plan.row.id} legacy source asset changed concurrently`);
					}
				} else {
					const asset = await tx.asset.create({
						data: {
						projectId: plan.row.id,
						exhibitionId: null,
						kind: 'WEBGL',
						status: 'READY',
						storageKey: null,
						originalName: proof.originalName,
						mimeType: plan.source.mimeType,
						sizeBytes: plan.source.sizeBytes,
						isPublic: false,
						},
						select: { id: true },
					});
					assetId = asset.id;
					assetsCreated = 1;
				}
				const representationId = randomUUID();
				const representation = await tx.assetRepresentation.upsert({
					where: { asset_representation_asset_role: { assetId, role: 'WEBGL_SOURCE' } },
					create: { id: representationId, assetId, role: 'WEBGL_SOURCE', ...representationData(plan.source) },
					update: representationData(plan.source),
					select: { id: true },
				});
				await tx.webglDeployment.create({
					data: {
						id: plan.deploymentId,
						projectId: plan.row.id,
						sourceRepresentationId: representation.id,
						publicBucket: plan.publicBucket,
						publicPrefix: plan.publicPrefix,
						entryObjectKey: plan.entryObjectKey,
						objectManifest: plan.objectManifest,
						state: 'READY',
						error: null,
					},
				});
				await tx.project.update({
					where: { id: plan.row.id },
					data: { currentWebglDeploymentId: plan.deploymentId },
				});
				return { assetsCreated, representationsUpserted: 1, deploymentsUpserted: 1 };
			});
		},
	};
}
