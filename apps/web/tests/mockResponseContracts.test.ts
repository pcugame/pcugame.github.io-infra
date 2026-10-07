/** All Web-owned routes use the API's real HTTP response schemas, including stripping behavior. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROUTE_RUNTIME_CONTRACTS } from '../../api/src/shared/http-route-schemas';
import { ApiErrorResponseSchema } from '@pcu/contracts';
import type { DirectAssetUploadKind } from '../src/contracts';
import inventory from '../src/lib/api/mock/inventory.json';
import { mockFetch, resetMockState, selectMockUser, getMockSnapshot, setMockControls, updateMockState } from '../src/lib/api/mock/transport';
import { chooseMockScenario } from '../src/lib/api/mock/scenarios';
import { createFileSourceIdentity } from '../src/lib/file-identity';
import { uploadDirectAssetFile, getDirectAssetUploadStatus } from '../src/lib/api/game-upload';

function pattern(path: string): RegExp {
  return new RegExp(`^${path.split('/').map(segment => segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')}$`);
}
function routeContract(method: string, path: string) {
  return ROUTE_RUNTIME_CONTRACTS.find(route => route.method === method && pattern(route.url).test(new URL(path,'http://mock.local').pathname));
}
async function assertResponse(method: string, path: string, response: Response): Promise<void> {
  const contract = routeContract(method,path);
  if (!contract && new URL(path,'http://mock.local').pathname.startsWith('/mock/garage-upload/')) {
    if (response.ok) expect(response.headers.get('etag')).toBeTruthy();
    else ApiErrorResponseSchema.parse(await response.json());
    return;
  }
  expect(contract,`${method} ${path} has no API route contract`).toBeDefined();
  const schema = contract!.response[response.status] ?? contract!.response.default;
  expect(schema,`${method} ${path} status ${response.status} has no schema`).toBeDefined();
  if (response.status === 204) { expect(await response.text()).toBe(''); schema!.parse(undefined); return; }
  const body:unknown = await response.json();
  const parsed = schema!.parse(body);
  // Zod strips unknown fields in many API serializers. Mock bypasses that serializer,
  // so parsing alone would miss leaks such as actorId, capabilities, and dueAt.
  expect(parsed,`${method} ${path} ${response.status} contains data that production serialization changes`).toEqual(body);
}
async function checked(method:string,path:string,body?:unknown) {
  const response=await mockFetch(path,{method,body});
  const clone=response.clone(); await assertResponse(method,path,clone);
  return response;
}
beforeEach(async () => { vi.stubEnv('VITE_MOCK','true'); await resetMockState(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function sample(path:string) {
  const state=await getMockSnapshot();
  const change=Object.keys(state.changeRequests)[0] ?? '12345678-1234-4234-8234-123456789abc';
  return path.replace(/:([A-Za-z]+)/g,(_match,name:string)=>name==='year'?'2025':name==='token'?'a'.repeat(64):name==='requestId'?change:
    name==='memberId'?'100':name==='assetId'?'192':name==='sessionId'||name==='capability'?'missing':'1');
}
function genericBody(path:string,method:string):unknown {
  if (method==='GET'||method==='DELETE') return undefined;
  if (path==='/api/auth/google') return {credential:'fixture'};
  if (path==='/api/dev/auth/login') return {role:'ADMIN'};
  if (path==='/api/dev/auth/login-error') return {scenario:'invalid-google-token'};
  if (path.endsWith('/projects/submit')) {
    const form=new FormData();form.set('payload',JSON.stringify({exhibitionId:1,title:'Contract gate',members:[{name:'학생',studentId:'2088099'}],manifest:[]}));return form;
  }
  if (path==='/api/admin/exhibitions') return {year:2099,title:'Contract exhibition',visibility:'PUBLIC',isModificationEnabled:true};
  if (/\/exhibitions\/1$/.test(path)) return {title:'Contract exhibition'};
  if (path==='/api/admin/projects/bulk/status') return {ids:[1],status:'ARCHIVED'};
  if (path==='/api/admin/projects/bulk/delete') return {ids:[1]};
  if (path.endsWith('/videos/order')) return {expectedOrder:[190,191],order:[191,190]};
  if (path.endsWith('/poster')) return {assetId:150};
  if (path.endsWith('/members/swap')) return {memberIdA:100,memberIdB:101};
  if (/\/members(?:\/100)?$/.test(path)) return {name:'Contract member',studentId:'2088123'};
  if (path.endsWith('/webgl-display')) return {webglDisplayMode:'auto',webglDisplayWidth:null,webglDisplayHeight:null};
  if (path.endsWith('/webgl-network-requests')) return {origin:'https://connections.example.test',purpose:'Contract gate',mode:'HTTPS',cors:'*'};
  if (/\/change-requests$/.test(path)) return {kind:'EDIT',reason:'Contract gate'};
  if (/\/reject$/.test(path)) return {reason:'Contract gate rejection'};
  if (path==='/api/me/external-links/resolve') return {url:'https://github.com/pcu/game'};
  if (path==='/api/file-access') return {url:'http://localhost:5173/mock/files/demo.webm'};
  if (path==='/api/admin/settings') return {maxGameFileMb:5120,maxChunkSizeMb:10};
  if (path==='/api/admin/banned-ips') return {ip:'198.51.100.1',reason:'Contract gate'};
  if (/\/projects\/1$/.test(path)) return {title:'Contract title'};
  return {};
}

describe('all-surface mock HTTP response contracts', () => {
  it.each(['default','review'] as const)('audits every inventory route in %s fixture state',async scenario=>{
    const failures:string[]=[];let successes=0;
    for (const row of inventory.routes) {
      await resetMockState();await chooseMockScenario(scenario);await selectMockUser('ADMIN');
      const path=await sample(row.path);
      try {
        const response=await checked(row.method,path,genericBody(path,row.method));
        if(response.ok)successes++;
      } catch(error) { failures.push(`${row.method} ${path}: ${error instanceof Error?error.message:String(error)}`); }
    }
    expect(successes).toBeGreaterThan(25);
    expect(failures).toEqual([]);
  },15000);
  it('audits populated submission, network, protected access, and publication read/write responses',async()=>{
    await selectMockUser('owner');
    const form=new FormData();form.set('payload',JSON.stringify({exhibitionId:1,title:'Populated response audit',members:[{name:'학생',studentId:'2088099'}],manifest:[]}));
    const create=await checked('POST','/api/me/projects/submit',form),project=(await create.json()).data as {id:number};
    await checked('GET',`/api/me/projects/${project.id}/submission`);
    await checked('POST',`/api/me/projects/${project.id}/submission/finalize`);
    vi.useFakeTimers();vi.setSystemTime(new Date(Date.now()+1000));
    await checked('GET',`/api/me/projects/${project.id}/submission`);
    vi.useRealTimers();
    const connection=await checked('POST','/api/me/projects/1/webgl-network-requests',{origin:'https://connections.example.test',purpose:'Gate',mode:'HTTPS',cors:'*'});
    const request=(await connection.json()).data as {id:string};
    await checked('GET','/api/me/projects/1/webgl-network-requests');
    await selectMockUser('ADMIN');await checked('GET','/api/admin/webgl-network-requests');
    await checked('POST',`/api/admin/webgl-network-requests/${request.id}/approve`,{reason:'Gate approval'});
    await checked('POST',`/api/admin/webgl-network-requests/${request.id}/revoke`,{reason:'Gate revocation'});
    await selectMockUser('owner');
    const state=await updateMockState(state=>{state.projects[1].visibility='AUTHENTICATED';});
    const document=state.projects[1].assets.find(asset=>asset.kind==='DOCUMENT');
    expect(document&&'downloadUrl' in document).toBe(true);
    const access=await checked('POST','/api/file-access',{url:document&&'downloadUrl' in document?document.downloadUrl:''});
    const token=(await access.json()).data.token as string;
    expect(token).toBeTruthy();await checked('POST',`/api/file-access/${token}/renew`);
  });
  it.each(['GAME','WEBGL','VIDEO','IMAGE','POSTER','DOCUMENT','ATTACHMENT'] as const)('audits exact %s create/part URL/status/completion contracts through actual upload client',async kind=>{
    await selectMockUser('ADMIN');await setMockControls({worker:'paused'});
    const file=new File(['contract bytes'],kind==='GAME'||kind==='WEBGL'?'game.zip':kind==='VIDEO'?'demo.webm':kind==='POSTER'||kind==='IMAGE'?'image.png':'readme.txt');
    const identity=await createFileSourceIdentity(file);
    const path=`/api/admin/projects/1/direct-${kind.toLowerCase()}-upload-sessions`;
    const created=await checked('POST',path,{originalName:file.name,totalBytes:file.size,...identity});
    expect(created.status).toBe(201); const data=(await created.json()).data as {sessionId:string;generation:number};
    const bytes=await file.arrayBuffer();const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
    const checksum=btoa(String.fromCharCode(...digest));
    const signed=await checked('POST',`/api/admin/direct-asset-upload-sessions/${data.sessionId}/part-urls`,{generation:data.generation,parts:[{partNumber:1,checksumSha256:checksum}]});
    const capability=(await signed.json()).data.parts[0] as {url:string;requiredHeaders:Record<string,string>};
    const part=await mockFetch(capability.url,{method:'PUT',body:file,headers:capability.requiredHeaders});
    await assertResponse('PUT',capability.url,part.clone());
    await checked('GET',`/api/admin/direct-asset-upload-sessions/${data.sessionId}`);
    await checked('POST',`/api/admin/direct-asset-upload-sessions/${data.sessionId}/complete`,{generation:data.generation,parts:[{partNumber:1,etag:part.headers.get('etag'),sizeBytes:file.size}]});
    await getDirectAssetUploadStatus(data.sessionId);
    // Canonical browser client consumes the same HTTP transport, not dispatcher objects.
    let clientSession='';await uploadDirectAssetFile(1,file,kind as DirectAssetUploadKind,undefined,{onSession:session=>{clientSession=session.sessionId;}});
    await checked('GET',`/api/admin/direct-asset-upload-sessions/${clientSession}`);
  });
});
