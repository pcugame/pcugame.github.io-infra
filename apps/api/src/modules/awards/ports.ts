export interface AwardRecord {
 id: number; exhibitionId: number; name: string; sortOrder: number; builtinKey: string | null; assetId: number | null;
 recipients: { projectId: number }[];
 asset?: AwardAsset | null;
}
export interface AwardAsset {
 id: number; originalName: string; status: string; kind: string; exhibitionId: number | null; projectId: number | null;
 representations: { role: string; state: string; bucket: string; objectKey: string }[];
}
export interface AwardSnapshot { candidates: { id: number; title: string; members: { name: string; studentId: string }[] }[]; version: number; items: AwardRecord[]; assets: AwardAsset[] }
export type AwardChange =
 | { kind: 'create' | 'edit'; awardId?: number; name: string; builtinKey: string | null; assetId: number | null }
 | { kind: 'delete'; awardId: number }
 | { kind: 'order'; awardIds: number[] }
 | { kind: 'recipients'; awardId: number; addProjectIds: number[]; removeProjectIds: number[] }
 | { kind: 'project'; projectId: number; awardIds: number[] }
 | { kind: 'asset-delete'; assetId: number };
export interface AwardRepository {
 read(exhibitionId: number): Promise<AwardSnapshot>;
 mutate(exhibitionId: number | null, projectIds: number[], validate: (snapshot: AwardSnapshot & {
  exhibitionId: number; projects: { id: number; exhibitionId: number; staging: boolean }[];
 }) => AwardChange): Promise<AwardSnapshot>;
}
