import type { Visibility, UserRole } from '@pcu/contracts';
import type { AssetDeliveryPolicyRecord } from '../assets/delivery-policy.js';
import type { AssetDownloadSource, AssetsService } from '../assets/ports.js';

export interface FileAccessRequest {
 currentUser?: { id: number; role: UserRole };
 cookies: Record<string, string | undefined>;
 ip?: string;
}
export interface FileAccessGrant { url: string; token: string | null; expiresAt: string | null }
export type FileProject = AssetDeliveryPolicyRecord['project'] & {
 title: string;
 currentWebglDeploymentId: string | null;
 members: { userId: number | null; name: string; studentId: string; sortOrder: number; id: number }[];
};
export interface FileDeployment {
 id: string;
 state: string;
 stagingBucket: string | null;
 stagingPrefix: string | null;
 publicBucket: string;
 publicPrefix: string;
 stagingObjectManifest: unknown;
 objectManifest: unknown;
 project: FileProject;
 sourceRepresentation: { assetId: number };
}
export interface FileToken {
 id: string; sessionId: string | null; bucket: string; objectKey: string; deploymentId: string | null; expiresAt: Date;
}
export interface FileAccessRepository {
 votePoster?(bucket: string, objectKey: string): Promise<{ id: string } | null>;
 purgeExpired(at: Date): Promise<unknown>;
 reusable(sessionId: string | null, bucket: string, key: string, deploymentId: string | null, at: Date): Promise<FileToken | null>;
 activeCount(sessionId: string | null, at: Date): Promise<number>;
 findRepresentation(bucket: string, key: string): Promise<{
  role: string;
  asset: { id: number; status: string; kind: string; originalName: string; project: FileProject | null; exhibition: { visibility: Visibility } | null };
 } | null>;
 findDeployment(bucket: string, key: string): Promise<FileDeployment | null>;
 deployment(id: string): Promise<FileDeployment | null>;
 token(id: string): Promise<FileToken | null>;
 createToken(data: FileToken): Promise<unknown>;
 renew(id: string, expiresAt: Date): Promise<unknown>;
 session(id: string): Promise<{ expiresAt: Date; lastSeenAt: Date; user: { id: number; role: UserRole } } | null>;
}
export type PrepareAssetDownload = AssetsService['prepareAssetDownload'];
export type RuntimeResolver = (raw: string, headers: Record<string, string | string[] | undefined>) => Promise<{ path: string; host: string; csp: string }>;
export interface FileAccessService {
 issue(value: string, request: FileAccessRequest): Promise<FileAccessGrant>;
 issueAssetDownload(assetId: number, variant: 'original' | 'playback', request: FileAccessRequest, source?: AssetDownloadSource): Promise<FileAccessGrant>;
 renew(token: string, request: FileAccessRequest): Promise<{ ok: boolean; data: { token: string; expiresAt: string } }>;
 check(headers: Record<string, string | string[] | undefined>): Promise<{ path: string; host: string; csp?: string }>;
}
