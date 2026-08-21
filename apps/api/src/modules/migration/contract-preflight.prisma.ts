import type { PrismaClient } from '../../generated/prisma/client.js';
import {
	LEGACY_BRIDGE_METRIC_NAMES,
	type ContractPreflightRepository,
	type ContractPreflightSnapshot,
} from './contract-preflight.js';

/** Prisma adapter kept intentionally read-only except the explicit reset call. */
export function createContractPreflightRepository(client: PrismaClient): ContractPreflightRepository {
	const db = client as unknown as {
		asset: { findMany(input: unknown): Promise<ContractPreflightSnapshot['assets']> };
		exhibition: { findMany(input: unknown): Promise<ContractPreflightSnapshot['exhibitions']> };
		project: { findMany(input: unknown): Promise<ContractPreflightSnapshot['projects']> };
		migrationMetric: {
			findMany(input: unknown): Promise<ContractPreflightSnapshot['metrics']>;
			updateMany(input: unknown): Promise<unknown>;
		};
		gameUploadSession: { findMany(input: unknown): Promise<ContractPreflightSnapshot['uploadSessions']> };
	};
	return {
		async readSnapshot() {
			const [assets, exhibitions, projects, metrics, uploadSessions] = await Promise.all([
				db.asset.findMany({
					select: {
						id: true, projectId: true, exhibitionId: true,
						kind: true, status: true, storageKey: true,
						playbackStorageKey: true, playbackStatus: true,
						card480Height: true, display960Height: true,
						representations: {
							select: { id: true, assetId: true, role: true, bucket: true, objectKey: true, state: true },
						},
					},
				}),
				db.exhibition.findMany({
					select: {
						id: true, posterStorageKey: true, posterAssetId: true,
						posterCard480Height: true, posterDisplay960Height: true,
					},
				}),
				db.project.findMany({
					select: {
						id: true, webglEntryKey: true, currentWebglDeploymentId: true,
						currentWebglDeployment: {
							select: {
								id: true, projectId: true, sourceRepresentationId: true,
								publicBucket: true, publicPrefix: true, entryObjectKey: true,
								objectManifest: true, state: true,
							},
						},
					},
				}),
				db.migrationMetric.findMany({
					where: { name: { in: [...LEGACY_BRIDGE_METRIC_NAMES] } },
					select: { name: true, scope: true, value: true, lastObservedAt: true },
				}),
				db.gameUploadSession.findMany({
					select: { id: true, status: true, uploadKind: true, storageKey: true },
				}),
			]);
			return { assets, exhibitions, projects, metrics, uploadSessions };
		},
		async resetLegacyBridgeObservations(observedAt) {
			await db.migrationMetric.updateMany({
				where: { name: { in: [...LEGACY_BRIDGE_METRIC_NAMES] } },
				data: { value: 0n, lastObservedAt: observedAt, details: { reset: 'contract-preflight' } },
			});
		},
	};
}
