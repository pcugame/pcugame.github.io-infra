import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectChangeDetailSchema, ProjectChangeListResponseSchema, WebglDisplaySettingsResponseSchema, WebglNetworkRequestSchema, WebglNetworkRequestListSchema, type ProjectChangeDetail, type WebglNetworkRequest } from '@pcu/contracts';
import { api } from '../lib/api/client';
import { adminImportApi, adminExportApi, adminSettingsApi, adminBannedIpApi } from '../lib/api/admin';
import { getMockSnapshot, resetMockState, selectMockUser, setMockControls, updateMockState, forgetMockCacheForTests } from '../lib/api/mock/transport';
import { chooseMockScenario } from '../lib/api/mock/scenarios';

beforeEach(async()=>{vi.stubEnv('VITE_MOCK','true');await resetMockState();});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
async function closedProject(){ await chooseMockScenario('permissions');return Object.values((await getMockSnapshot()).projects).find(p=>p.createdByUserId===3&&p.status!=='DRAFT')!; }
async function createChange(){const p=await closedProject();const row=await api.post<ProjectChangeDetail>(`/api/me/projects/${p.id}/change-requests`,{kind:'EDIT',reason:'Correct the title'});return {p,row};}

describe('change request workflow through actual client',()=>{
  it('keeps authors, drafts, review permissions, response schemas and approved source consistent',async()=>{
    const {p,row}=await createChange();expect(ProjectChangeDetailSchema.safeParse(row).success).toBe(true);
    await expect(api.post(`/api/me/projects/${p.id}/change-requests`,{kind:'EDIT',reason:'Duplicate'})).rejects.toMatchObject({status:409});
    await selectMockUser('participant');await expect(api.patch(`/api/me/change-requests/${row.id}`,{reason:'Other author'})).rejects.toMatchObject({status:403});
    await selectMockUser('owner');const draft=await api.patch(`/api/me/change-requests/${row.id}`,{changes:{title:'Approved title'}});expect(ProjectChangeDetailSchema.safeParse(draft).success).toBe(true);
    await api.post(`/api/me/change-requests/${row.id}/submit`);
    await expect(api.patch(`/api/me/change-requests/${row.id}`,{reason:'Late edit'})).rejects.toMatchObject({status:409});
    await expect(api.post(`/api/admin/change-requests/${row.id}/approve`)).rejects.toMatchObject({status:403});
    await selectMockUser('OPERATOR');const list=await api.get('/api/admin/change-requests?state=PENDING');expect(ProjectChangeListResponseSchema.safeParse(list).success).toBe(true);
    const approved=await api.post<ProjectChangeDetail>(`/api/admin/change-requests/${row.id}/approve`);expect(approved.state).toBe('COMPLETED');
    expect(ProjectChangeDetailSchema.safeParse(approved).success).toBe(true);
    expect(await api.get(`/api/admin/projects/${p.id}`)).toMatchObject({title:'Approved title'});
    await forgetMockCacheForTests();expect((await getMockSnapshot()).projects[p.id].title).toBe('Approved title');
    expect(await api.post(`/api/admin/change-requests/${row.id}/approve`)).toMatchObject({state:'COMPLETED'});
  });
  it('snapshots and applies requirement clears through approved change requests',async()=>{
    const p=await closedProject();
    await updateMockState(state=>{state.projects[p.id].platforms=['PC','WEB'];state.projects[p.id].hardwareRequirements='VR 헤드셋';});
    const row=await api.post<ProjectChangeDetail>(`/api/me/projects/${p.id}/change-requests`,{kind:'EDIT',reason:'실행 환경 정정'});
    expect(row.before).toMatchObject({platforms:['PC','WEB'],hardwareRequirements:'VR 헤드셋'});
    const draft=await api.patch<ProjectChangeDetail>(`/api/me/change-requests/${row.id}`,{changes:{platforms:[],hardwareRequirements:''}});
    expect(ProjectChangeDetailSchema.safeParse(draft).success).toBe(true);
    await api.post(`/api/me/change-requests/${row.id}/submit`);await selectMockUser('ADMIN');
    expect(await api.post(`/api/admin/change-requests/${row.id}/approve`)).toMatchObject({state:'COMPLETED'});
    await forgetMockCacheForTests();
    expect(await api.get(`/api/admin/projects/${p.id}`)).toMatchObject({platforms:[],hardwareRequirements:''});
    expect(await api.get(`/api/public/projects/${p.id}`)).toMatchObject({platforms:[],hardwareRequirements:''});
  });
  it('rejects/cancels and detects source version conflicts without changing source',async()=>{
    const {p,row}=await createChange();await api.patch(`/api/me/change-requests/${row.id}`,{changes:{title:'Conflicting edit'}});await api.post(`/api/me/change-requests/${row.id}/submit`);
    await selectMockUser('ADMIN');await api.patch(`/api/admin/projects/${p.id}`,{title:'Staff direct edit'});
    expect(await api.post(`/api/admin/change-requests/${row.id}/approve`)).toMatchObject({state:'CONFLICT'});
    await selectMockUser('owner');const cancelled=await api.post<ProjectChangeDetail>(`/api/me/projects/${p.id}/change-requests`,{kind:'DELETE',reason:'Remove this'});await api.post(`/api/me/change-requests/${cancelled.id}/cancel`);
    await expect(api.patch(`/api/me/change-requests/${cancelled.id}`,{reason:'No longer draft'})).rejects.toMatchObject({status:409});
    const rejected=await api.post<ProjectChangeDetail>(`/api/me/projects/${p.id}/change-requests`,{kind:'DELETE',reason:'Review removal'});await api.post(`/api/me/change-requests/${rejected.id}/submit`);await selectMockUser('ADMIN');
    expect(await api.post(`/api/admin/change-requests/${rejected.id}/reject`,{reason:'Retain the work'})).toMatchObject({state:'REJECTED',reviewReason:'Retain the work'});
    expect((await getMockSnapshot()).projects[p.id].title).toBe('Staff direct edit');
  });
  it('stages manifests and prevents submission before assets are ready',async()=>{
    const {row}=await createChange();const draft=await api.patch<ProjectChangeDetail>(`/api/me/change-requests/${row.id}`,{manifest:[{kind:'POSTER',slot:'poster',clientToken:'a'.repeat(32)}]});
    expect(draft.stagingProjectId).not.toBeNull();expect(ProjectChangeDetailSchema.safeParse(draft).success).toBe(true);
    await expect(api.post(`/api/me/change-requests/${row.id}/submit`)).rejects.toMatchObject({status:409});
    await api.post(`/api/me/change-requests/${row.id}/cancel`);expect((await getMockSnapshot()).projects[draft.stagingProjectId!]).toBeUndefined();
  });
});

describe('WebGL display/network and file access',()=>{
  it('uses fixed build analysis and publishes resolved settings for the local frontend player',async()=>{
    await selectMockUser('ADMIN');
    const settings=WebglDisplaySettingsResponseSchema.parse(await api.get('/api/me/projects/2/webgl-display'));
    expect(settings.analysis).toMatchObject({kind:'fixed',width:800,height:600});
    await api.put('/api/me/projects/2/webgl-display',{webglDisplayMode:'auto',webglDisplayWidth:null,webglDisplayHeight:null});
    const fixed=await api.get<{webglPlayUrl?:string;webglDisplayKind:string;webglDisplayWidth:number;webglDisplayHeight:number}>('/api/public/projects/2');
    expect(fixed).toMatchObject({webglDisplayKind:'fixed',webglDisplayWidth:800,webglDisplayHeight:600});
    expect(fixed.webglPlayUrl).toBeUndefined();
    await api.put('/api/me/projects/1/webgl-display',{webglDisplayMode:'manual',webglDisplayWidth:1024,webglDisplayHeight:768});
    expect(await api.get('/api/public/projects/1')).toMatchObject({webglDisplayKind:'fixed',webglDisplayWidth:1024,webglDisplayHeight:768});
  });
  it('checks creator display capability and publishes settings; reviews connection policy history',async()=>{
    await selectMockUser('owner');const p=Object.values((await getMockSnapshot()).projects).find(p=>p.createdByUserId===3&&p.isModificationEnabled!==false)!;
    const result=await api.put(`/api/me/projects/${p.id}/webgl-display`,{webglDisplayMode:'manual',webglDisplayWidth:800,webglDisplayHeight:600});expect(WebglDisplaySettingsResponseSchema.safeParse(result).success).toBe(true);
    await selectMockUser('participant');await expect(api.put(`/api/me/projects/${p.id}/webgl-display`,{webglDisplayMode:'auto',webglDisplayWidth:null,webglDisplayHeight:null})).rejects.toMatchObject({status:403});
    await selectMockUser('owner');await expect(api.post(`/api/me/projects/${p.id}/webgl-network-requests`,{origin:'http://localhost',purpose:'bad',mode:'HTTPS',cors:'yes'})).rejects.toMatchObject({status:400});
    const row=await api.post<WebglNetworkRequest>(`/api/me/projects/${p.id}/webgl-network-requests`,{origin:'https://example.com',purpose:'Scores',mode:'HTTPS',cors:'Allows local fixture origin'});
    expect(WebglNetworkRequestSchema.safeParse(row).success).toBe(true);
    await expect(api.post(`/api/me/projects/${p.id}/webgl-network-requests`,{origin:'https://example.com',purpose:'Duplicate',mode:'HTTPS',cors:'yes'})).rejects.toMatchObject({status:409});
    expect(WebglNetworkRequestListSchema.safeParse(await api.get(`/api/me/projects/${p.id}/webgl-network-requests`)).success).toBe(true);
    await selectMockUser('OPERATOR');const approved=await api.post<WebglNetworkRequest>(`/api/admin/webgl-network-requests/${row.id}/approve`,{reason:'Approved exact origin'});expect(approved).toMatchObject({state:'APPROVED',policyVersion:p.webglNetworkPolicyVersion+1});
    const revoked=await api.post<WebglNetworkRequest>(`/api/admin/webgl-network-requests/${row.id}/revoke`,{reason:'Access ended'});expect(revoked.events).toHaveLength(2);expect(revoked.policyVersion).toBe(p.webglNetworkPolicyVersion+2);
    expect(WebglNetworkRequestSchema.safeParse(revoked).success).toBe(true);
  });
  it('distinguishes protected media, expiration, role change and permission changes on renew',async()=>{
    const p=Object.values((await getMockSnapshot()).projects).find(p=>p.poster)!;await api.patch(`/api/admin/projects/${p.id}`,{visibility:'AUTHENTICATED'});
    const media=p.poster!.original.url;
    await selectMockUser('anonymous');await expect(api.post('/api/file-access',{url:media})).rejects.toMatchObject({status:403});
    await selectMockUser('owner');const access=await api.post<{token:string;url:string}>('/api/file-access',{url:media});expect(access.token).toMatch(/^[a-f0-9]{64}$/);
    expect(await api.post(`/api/file-access/${access.token}/renew`)).toMatchObject({token:access.token});
    await selectMockUser('other');await expect(api.post(`/api/file-access/${access.token}/renew`)).rejects.toMatchObject({status:403});
    await selectMockUser('owner');await updateMockState(state=>{(state.fileTokens[access.token] as {expiresAt:string}).expiresAt=new Date(0).toISOString();});
    await expect(api.post(`/api/file-access/${access.token}/renew`)).rejects.toMatchObject({status:403});
    const foreign = new URL(media); foreign.hostname='unknown.example';
    await expect(api.post('/api/file-access',{url:foreign.href})).rejects.toMatchObject({status:404});
    await expect(api.post('/api/file-access',{url:'https://unknown.example/file'})).rejects.toMatchObject({status:404});
  });
});

describe('management workflow',()=>{
  it('persists settings, validates IPs and preserves unban history',async()=>{
    await adminSettingsApi.update({maxGameFileMb:42,maxChunkSizeMb:5});await forgetMockCacheForTests();expect(await adminSettingsApi.get()).toEqual({maxGameFileMb:42,maxChunkSizeMb:5});
    await expect(adminSettingsApi.update({maxChunkSizeMb:99})).rejects.toMatchObject({status:400});
    await expect(adminBannedIpApi.create({ip:'127.1',reason:'Invalid'})).rejects.toMatchObject({status:400});
    const ban=await adminBannedIpApi.create({ip:'198.51.100.3/24',reason:'Test range'});expect(ban.ip).toBe('198.51.100.0/24');
    await expect(adminBannedIpApi.create({ip:'198.51.100.0/24',reason:'Duplicate'})).rejects.toMatchObject({status:409});await adminBannedIpApi.unban(ban.id);
    expect((await adminBannedIpApi.list()).items.find(b=>b.id===ban.id)).toMatchObject({active:false,disabledAt:expect.any(String)});
  });
  it('previews imports without writes, applies valid imports atomically and restricts operator',async()=>{
    const file=new File([JSON.stringify({years:[{year:2030,title:'Synthetic import'}],projects:[{year:2030,title:'Imported',members:[{name:'Author'}]}]})],'import.json',{type:'application/json'});
    const before=(await getMockSnapshot()).projects;expect(await adminImportApi.preview(file)).toMatchObject({valid:true,projectCount:1});expect(Object.keys((await getMockSnapshot()).projects)).toEqual(Object.keys(before));
    expect(await adminImportApi.execute(file)).toMatchObject({projects:{created:1}});expect(Object.values((await getMockSnapshot()).projects).some(p=>p.title==='Imported')).toBe(true);
    const bad=new File(['{"years":[{"year":2031}],"projects":[{"year":2031,"title":""}]}'],'invalid.json');await expect(adminImportApi.execute(bad)).rejects.toMatchObject({status:400});expect((await getMockSnapshot()).exhibitions.some(e=>e.year===2031)).toBe(false);
    await selectMockUser('OPERATOR');await expect(adminImportApi.preview(file)).rejects.toMatchObject({status:403});await expect(adminExportApi.run()).rejects.toMatchObject({status:403});
  });
  it('exposes empty, queued, running, ready and failed export states after reload',async()=>{
    vi.useFakeTimers();expect(await adminExportApi.status()).toEqual({running:false,progress:null});const job=await adminExportApi.run(2025);expect(job.state).toBe('QUEUED');
    await expect(adminExportApi.run()).rejects.toMatchObject({status:409});await forgetMockCacheForTests();expect(await adminExportApi.status()).toMatchObject({jobId:job.jobId,state:'QUEUED'});
    vi.advanceTimersByTime(300);expect(await adminExportApi.status()).toMatchObject({state:'RUNNING'});vi.advanceTimersByTime(1000);expect(await adminExportApi.status()).toMatchObject({state:'READY',result:{projects:expect.any(Number)}});
    await adminExportApi.run();await setMockControls({worker:'fail'});vi.advanceTimersByTime(1300);expect(await adminExportApi.status()).toMatchObject({state:'FAILED',error:expect.any(String)});
  });
});


describe('persistent mock authentication',()=>{
  it('preserves logout and expiry, changes protected requests, and logs in again',async()=>{
    await api.post('/api/auth/logout');await forgetMockCacheForTests();expect(await api.get('/api/me')).toEqual({authenticated:false});
    await expect(api.get('/api/admin/projects')).rejects.toMatchObject({status:401,body:{error:{code:'UNAUTHORIZED'}}});
    expect(await api.post('/api/dev/auth/login',{role:'USER'})).toMatchObject({user:{id:3,role:'USER'}});
    await updateMockState(state=>{state.authExpiresAt=new Date(0).toISOString();});expect(await api.get('/api/me')).toEqual({authenticated:false});
    expect(await api.post('/api/auth/google',{credential:'mock-token'})).toMatchObject({user:{id:3}});expect(await api.get('/api/me')).toMatchObject({authenticated:true});
  });
  it.each([
    ['domain-not-allowed',403,'EMAIL_DOMAIN_NOT_ALLOWED'],['google-api-unavailable',401,'GOOGLE_API_UNAVAILABLE'],
    ['invalid-google-token',401,'UNAUTHORIZED'],['missing-google-payload',401,'UNAUTHORIZED'],['api-server-error',500,'INTERNAL_ERROR'],
  ])('uses API failure codes for %s',async(scenario,status,code)=>{
    await expect(api.post('/api/dev/auth/login-error',{scenario})).rejects.toMatchObject({status,body:{error:{code}}});
  });
});
