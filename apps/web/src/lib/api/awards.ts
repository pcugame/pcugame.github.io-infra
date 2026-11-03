import type { Award, AwardState } from '@pcu/contracts';
import { api } from './client';
const base = (id: number) => `/api/admin/exhibitions/${id}/awards`;
export const awardApi = {
 read: (id: number) => api.get<AwardState>(base(id)),
 create: (id: number, expectedVersion: number, name: string) => api.post<AwardState>(base(id), { expectedVersion, name, builtinKey: 'laurel-gold', assetId: null }),
 edit: (id: number, expectedVersion: number, award: Pick<Award, 'id' | 'name' | 'builtinKey' | 'assetId' | 'color'>) => api.patch<AwardState>(`${base(id)}/${award.id}`, { expectedVersion, name: award.name, builtinKey: award.builtinKey, assetId: award.assetId, ...(award.color !== undefined ? { color: award.color } : {}) }),
 remove: (id: number, expectedVersion: number, awardId: number) => api.delete<AwardState>(`${base(id)}/${awardId}`, { body: { expectedVersion } }),
 order: (id: number, expectedVersion: number, awardIds: number[]) => api.put<AwardState>(`${base(id)}/order`, { expectedVersion, awardIds }),
 recipients: (id: number, expectedVersion: number, awardId: number, addProjectIds: number[], removeProjectIds: number[]) => api.patch<AwardState>(`${base(id)}/${awardId}/recipients`, { expectedVersion, addProjectIds, removeProjectIds }),
 project: (id: number, expectedVersion: number, awardIds: number[]) => api.put<AwardState>(`/api/admin/projects/${id}/awards`, { expectedVersion, awardIds }),
 deleteImage: (id: number, expectedVersion: number, assetId: number) => api.delete<AwardState>(`/api/admin/exhibitions/${id}/award-images/${assetId}`, { body: { expectedVersion } }),
};
