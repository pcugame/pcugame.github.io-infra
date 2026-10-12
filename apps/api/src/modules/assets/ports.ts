import type { AssetKind, Visibility } from '@pcu/contracts';
import type { Actor } from '../../application/http-input.js';
import type { AssetDeliveryPolicyRecord } from './delivery-policy.js';
import type { AssetDownloadIdentity, AssetDownloadVariant, ResolvedDownloadRepresentation } from './download-resolver.js';
import type { ProjectAccessRecord } from '../admin/project-access.ports.js';

export interface AssetDownloadRecord extends AssetDownloadIdentity {
 originalName: string;
 exhibition: { visibility: Visibility } | null;
 projectId: number | null;
 project: (AssetDeliveryPolicyRecord['project'] & {
  title: string;
  members: { id: number; userId: number | null; name: string; studentId: string; sortOrder: number }[];
 }) | null;
}
export type AssetDownloadSource = 'download-route' | 'canonical-url' | 'object-url';
export interface PreparedAssetDownload {
 assetId: number;
 representation: ResolvedDownloadRepresentation;
}
export interface AssetsRepository {
 findAssetByIdForDownload(id: number): Promise<AssetDownloadRecord | null>;
}
export interface AssetDeletionSnapshot {
 id: number;
 projectId: number;
 kind: AssetKind;
 status: 'PENDING' | 'VERIFYING' | 'PROCESSING' | 'READY' | 'DELETING' | 'DELETED' | 'FAILED';
 representations: { role: string; bucket: string; objectKey: string }[];
 project: ProjectAccessRecord & { isMember: boolean; posterAssetId: number | null; version: number };
 submissionState: string | null;
 videos: { id: number; videoSortOrder: number | null }[];
}
export interface AssetDeletionPlan {
 incrementVersion: boolean;
 clearPoster: boolean;
 videoIds: number[] | null;
 reason: string;
}
export interface AssetDeletionTransaction {
 snapshot: AssetDeletionSnapshot;
 applyDeletion(plan: AssetDeletionPlan): Promise<void>;
}
export interface AssetDeletionUnitOfWork {
 run<T>(assetId: number, actor: Actor, operation: (tx: AssetDeletionTransaction) => Promise<T>): Promise<T>;
}
export interface AssetsServiceDependencies {
 protectedBucket: string;
 repository: AssetsRepository;
 deletion: AssetDeletionUnitOfWork;
 checkDownloadLimit(ip: string, principalScope: string): Promise<void>;
 wakeDeletionWorker(): void;
 logger: { error(context: Record<string, unknown>, message: string): void };
}
export interface AssetsService {
 prepareAssetDownload(assetId: number, variant: AssetDownloadVariant, ip: string, actor?: Actor, source?: AssetDownloadSource): Promise<PreparedAssetDownload>;
 deleteAsset(assetId: number, actor: Actor): Promise<{ projectId: number }>;
}
