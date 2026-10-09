/* @vitest-environment jsdom */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AdminProjectDetailSchema, AdminProjectListResponseSchema, AdminExhibitionItemSchema, PublicProjectDetailResponseSchema, PublicYearProjectsResponseSchema } from '@pcu/contracts';
import { adminAssetApi, adminExhibitionApi, adminMemberApi, adminProjectApi } from '../lib/api/admin';
import { publicApi } from '../lib/api/public';
import { resetMockState, selectMockUser, updateMockState } from '../lib/api/mock/transport';

describe('mock project canonical CRUD through API client',()=>{
 beforeEach(async()=>{vi.stubEnv('VITE_MOCK','true');await resetMockState();await selectMockUser('ADMIN');});
 afterEach(()=>vi.unstubAllEnvs());
 it('switches between a student with projects and a student without projects without deleting fixtures',async()=>{
  await selectMockUser('owner');
  const owned=await adminProjectApi.list();expect(owned.items.length).toBeGreaterThan(0);
  await selectMockUser('newStudent');
  expect((await adminProjectApi.list()).items).toEqual([]);
  await expect(adminProjectApi.getDetail(owned.items[0].id)).rejects.toMatchObject({status:403});
  await selectMockUser('owner');expect((await adminProjectApi.list()).items).toEqual(owned.items);
 });
 it('returns the same required asset summary in lists and detail, including pending video',async()=>{
  await updateMockState(s=>{s.projects[1].videos=s.projects[1].videos.map(video=>({...video,playbackStatus:'PENDING'}));});
  const detail=AdminProjectDetailSchema.parse(await adminProjectApi.getDetail(1));
  const list=AdminProjectListResponseSchema.parse(await adminProjectApi.list());
  expect(list.items.find(item=>item.id===1)?.requiredAssets).toEqual(detail.requiredAssets);
  expect(detail.requiredAssets?.video).toEqual({ready:false,processing:true,failed:false});
  await updateMockState(s=>{s.projects[1].videos=s.projects[1].videos.map(video=>({...video,playbackStatus:'FAILED'}));});
  expect((await adminProjectApi.getDetail(1)).requiredAssets?.video).toEqual({ready:false,processing:false,failed:true});
 });
 it('serves seeded game downloads through public detail and removes the button after deleting the asset',async()=>{
  const detail=PublicProjectDetailResponseSchema.parse(await publicApi.getProjectDetail(1));
  expect(detail.gameDownloadUrl).toContain('/mock/files/game.zip');
  expect(detail.attachments?.[0].downloadUrl).toContain('/mock/files/readme.txt');
  const admin=await adminProjectApi.getDetail(1);
  const game=admin.assets.find(asset=>asset.kind==='GAME')!;
  expect(game).toBeDefined();
  await adminAssetApi.remove(game.id);
  expect((await publicApi.getProjectDetail(1)).gameDownloadUrl).toBeUndefined();
 });
 it('seeds pagination, draft filters, search and deterministic sort',async()=>{
  const first=AdminProjectListResponseSchema.parse(await adminProjectApi.list());
  expect(first.items).toHaveLength(20);expect(first.pagination.totalItems).toBeGreaterThan(20);
  const second=await adminProjectApi.list({page:2});expect(second.items.every(p=>!first.items.some(a=>a.id===p.id))).toBe(true);
  const drafts=await adminProjectApi.list({status:'DRAFT'});expect(drafts.items.length).toBeGreaterThan(0);expect(drafts.items.every(p=>p.status==='DRAFT')).toBe(true);
  const search=await adminProjectApi.list({search:'2088100',sort:'title',order:'asc'});expect(search.items.length).toBeGreaterThan(0);expect(search.items.every(p=>p.memberStudentIds.includes('2088100'))).toBe(true);
 });
 it('projects metadata writes into authenticated public detail, honors slug/year and visibility',async()=>{
  const updated=AdminProjectDetailSchema.parse(await adminProjectApi.update(1,{title:'수정된 작품',summary:'저장됨',visibility:'AUTHENTICATED'}));
  expect(updated.title).toBe('수정된 작품');
  const publicDetail=PublicProjectDetailResponseSchema.parse(await publicApi.getProjectDetail('dragon-slayer',2025));expect(publicDetail.title).toBe(updated.title);
  await expect(publicApi.getProjectDetail('dragon-slayer',2024)).rejects.toMatchObject({status:404});
  await selectMockUser('anonymous');await expect(publicApi.getProjectDetail(1)).rejects.toMatchObject({status:404});
  const year=PublicYearProjectsResponseSchema.parse(await publicApi.getYearProjects(2025));expect(year.items.some(p=>p.id===1)).toBe(false);
  await selectMockUser('other');expect((await publicApi.getProjectDetail(1)).title).toBe(updated.title);
 });
 it('derives owner and participant access and closed capabilities dynamically',async()=>{
  await selectMockUser('participant');const own=await adminProjectApi.list();expect(own.items.some(p=>p.id===1)).toBe(true);
  expect((await adminProjectApi.getDetail(1)).canEditWebglDisplay).toBe(false);
  await adminProjectApi.update(1,{summary:'참여자 저장'});
  await expect(adminProjectApi.update(1,{status:'ARCHIVED'})).rejects.toMatchObject({status:403});
  await selectMockUser('ADMIN');await adminExhibitionApi.update(1,{isModificationEnabled:false});
  await selectMockUser('owner');const closed=AdminProjectDetailSchema.parse(await adminProjectApi.getDetail(1));expect(closed.canEdit).toBe(false);expect(closed.canRequestChange).toBe(true);
  await expect(adminProjectApi.update(1,{title:'불가'})).rejects.toMatchObject({status:403});await expect(adminProjectApi.delete(1)).rejects.toMatchObject({status:403});
  await selectMockUser('other');await expect(adminProjectApi.getDetail(1)).rejects.toMatchObject({status:403});
 });
 it('persists member add/update/swap/delete and shared public projection',async()=>{
  const member=await adminMemberApi.add(1,{name:'새 학생',studentId:'2099999',sortOrder:8});
  await adminMemberApi.update(1,member.id,{name:'학생 수정',sortOrder:4});let detail=await adminProjectApi.getDetail(1);expect(detail.members.find(m=>m.id===member.id)?.name).toBe('학생 수정');
  const first=detail.members[0];await adminMemberApi.swap(1,first.id,member.id);detail=await adminProjectApi.getDetail(1);expect(detail.members[0].id).toBe(member.id);
  expect((await publicApi.getProjectDetail(1)).members.some(m=>m.id===member.id&&m.name==='학생 수정')).toBe(true);
  await adminMemberApi.remove(1,member.id);expect((await adminProjectApi.getDetail(1)).members.some(m=>m.id===member.id)).toBe(false);
  await expect(adminMemberApi.remove(1,member.id)).rejects.toMatchObject({status:404});
 });
 it('persists poster, video concurrency, webgl and asset removal',async()=>{
  let detail=await adminProjectApi.getDetail(1);const screenshot=detail.assets.find(a=>a.kind==='IMAGE')!;
  await adminProjectApi.setPoster(1,{assetId:screenshot.id});expect((await publicApi.getProjectDetail(1)).poster).toEqual('image' in screenshot?screenshot.image:undefined);
  const order=detail.videos.map(v=>v.assetId);await adminProjectApi.reorderVideos(1,{expectedOrder:order,order:[...order].reverse()});
  expect((await publicApi.getProjectDetail(1)).video?.assetId).toBe(order[1]);
  await expect(adminProjectApi.reorderVideos(1,{expectedOrder:order,order})).rejects.toMatchObject({status:409});
  await adminAssetApi.remove(screenshot.id);detail=AdminProjectDetailSchema.parse(await adminProjectApi.getDetail(1));expect(detail.poster).toBeUndefined();expect((await publicApi.getProjectDetail(1)).images.some(a=>a.id===screenshot.id)).toBe(false);
  await adminAssetApi.remove(order[1]);expect((await publicApi.getProjectDetail(1)).video?.assetId).toBe(order[0]);
  await adminProjectApi.deleteWebgl(1);expect((await publicApi.getProjectDetail(1)).webglUrl).toBeUndefined();
 });
 it('creates same-year exhibition without cross-exhibition leakage and cascades deletion',async()=>{
  const created=await adminExhibitionApi.create({year:2025,title:'새 전시',visibility:'PUBLIC'});
  await expect(adminExhibitionApi.create({year:2025,title:'새 전시'})).rejects.toMatchObject({status:409});
  AdminExhibitionItemSchema.parse(await adminExhibitionApi.update(created.id,{title:'전시 수정',isUploadEnabled:false}));
  const exhibition=await publicApi.getExhibitionProjects(created.id);expect(exhibition.empty).toBe(true);
  const year=PublicYearProjectsResponseSchema.parse(await publicApi.getYearProjects(2025));expect(year.exhibitions.some(e=>e.id===created.id)).toBe(true);
  await updateMockState(s=>{s.projects[1].exhibitionId=created.id;});
  expect((await publicApi.getExhibitionProjects(created.id)).items.map(p=>p.id)).toEqual([1]);
  await adminExhibitionApi.delete(created.id);await expect(adminProjectApi.getDetail(1)).rejects.toMatchObject({status:404});
 });
 it('cleans source requests, stages and uploads when directly deleting a project',async()=>{
  await updateMockState(s=>{
   s.changeRequests['mock-request']={id:'mock-request',projectId:1,originalProjectId:1,projectTitle:'Dragon Slayer',actorId:3,kind:'EDIT',state:'PENDING',reason:'검토',reviewReason:null,reviewerId:null,error:null,baseVersion:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),submittedAt:null,reviewedAt:null,completedAt:null,before:{title:'Dragon Slayer',summary:'',description:'',githubUrl:'',externalLinks:[],platforms:[],members:[],posterAssetId:null,assets:[],currentWebglDeploymentId:null},changes:{},stagingProjectId:99999,submissionId:null,items:[],stagedAssets:[]};
   s.projects[99999]={...s.projects[1],id:99999,isChangeRequestDraft:true,status:'DRAFT'};
  });
  await adminProjectApi.delete(1);
  const {getMockState}=await import('../lib/api/mock/transport');const state=getMockState()!;
  expect(state.projects[99999]).toBeUndefined();expect(state.changeRequests['mock-request'].state).toBe('CONFLICT');expect(state.changeRequests['mock-request'].projectId).toBeNull();
 });
 it('enforces bulk roles, persisted status and final deletes',async()=>{
  await selectMockUser('owner');await expect(adminProjectApi.bulkStatus([1],'ARCHIVED')).rejects.toMatchObject({status:403});
  await selectMockUser('OPERATOR');expect(await adminProjectApi.bulkStatus([1,2],'ARCHIVED')).toEqual({updated:2});expect((await publicApi.getProjectDetail(1)).status).toBe('ARCHIVED');await expect(adminProjectApi.bulkDelete([1])).rejects.toMatchObject({status:403});
  await selectMockUser('ADMIN');expect((await adminProjectApi.bulkDelete([1,2])).deleted).toBe(2);await expect(publicApi.getProjectDetail(1)).rejects.toMatchObject({status:404});
 });
});
