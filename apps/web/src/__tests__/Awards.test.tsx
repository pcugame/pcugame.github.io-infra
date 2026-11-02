/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AwardImage } from '../components/awards/AwardImage';
import { awardApi } from '../lib/api/awards';
import { api } from '../lib/api/client';
import { resetMockState, getMockSnapshot, forgetMockCacheForTests, selectMockUser } from '../lib/api/mock/transport';
import type { AdminProjectDetail, PublicExhibitionProjectsResponse } from '@pcu/contracts';
import { sortProjectsWithPosterFirst } from '../lib/utils/projectSort';

beforeEach(async()=>{vi.stubEnv('VITE_MOCK','true');await resetMockState();});
afterEach(()=>vi.unstubAllEnvs());
describe('awards through persisted mock and actual client',()=>{
 it('migrates old state without losing projects, persists multiple awards, rejects stale writes and enforces roles',async()=>{
  const snapshot=await getMockSnapshot();const p=Object.values(snapshot.projects).find(p=>!p.isChangeRequestDraft && p.status==='PUBLISHED')!;
  const originalCount=Object.keys(snapshot.projects).length;
  let state=await awardApi.read(p.exhibitionId);expect(state.items).toEqual([]);
  state=await awardApi.create(p.exhibitionId,state.version,'Gold');
  await expect(awardApi.create(p.exhibitionId,0,'Stale')).rejects.toMatchObject({status:409});
  state=await awardApi.create(p.exhibitionId,state.version,'Silver');
  state=await awardApi.project(p.id,state.version,state.items.map(a=>a.id));
  await forgetMockCacheForTests();
  const detail=await api.get<AdminProjectDetail>(`/api/admin/projects/${p.id}`);expect(detail.awards?.map(a=>a.name)).toEqual(['Gold','Silver']);expect(detail.exhibitionId).toBe(p.exhibitionId);
  expect(Object.keys((await getMockSnapshot()).projects)).toHaveLength(originalCount);
  const listing=await api.get<PublicExhibitionProjectsResponse>(`/api/public/exhibitions/${p.exhibitionId}/projects`);
  expect(listing.items[0].id).toBe(p.id);expect(sortProjectsWithPosterFirst(listing.items)).toBe(listing.items);expect(listing.items[0].awards?.[0]).not.toHaveProperty('projectIds');
  await selectMockUser('owner');await expect(awardApi.read(p.exhibitionId)).rejects.toMatchObject({status:403});
  await selectMockUser('anonymous');await expect(awardApi.read(p.exhibitionId)).rejects.toMatchObject({status:401});
 });
 it('retains the award name after an image error',()=>{
  const {container}=render(<AwardImage award={{id:1,name:'최우수상',sortOrder:0,builtinKey:null,assetId:2,imageUrl:'https://example.test/missing.png'}}/>);
  fireEvent.error(container.querySelector('img')!);expect(screen.getByText('최우수상')).toBeTruthy();expect(container.querySelector('img')).toBeNull();
 });
});
