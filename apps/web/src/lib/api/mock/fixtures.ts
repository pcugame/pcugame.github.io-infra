import type { MockProject } from './context';
import { buildAdminProjectDetail, buildAdminProjectItems, MOCK_ADMIN_YEARS, mockFixtureUrl } from './data';

export function createProjectFixtures(): Record<number, MockProject> {
 const projects: Record<number, MockProject> = {};
 for (const item of buildAdminProjectItems()) {
  const detail = buildAdminProjectDetail(item.id)!;
  const exhibitionId = MOCK_ADMIN_YEARS.find(e=>e.year===detail.year)!.id;
  projects[item.id] = { ...detail, exhibitionId, createdByUserId: item.createdByUserId, createdAt: '2025-01-01T00:00:00.000Z', updatedAt: item.updatedAt, version: 1, webglNetworkPolicyVersion: 1 };
  if (item.createdByUserId===3) projects[item.id].members[0].userId=3;
 }
 for (let i=0;i<18;i++) {
  const id=9100+i, base=structuredClone(projects[9001]);
  const exhibitionId=[1,2,5,6][i%4];
  projects[id]={...base,id,slug:`mock-project-${i+1}`,title:`개발 환경 작품 ${String(i+1).padStart(2,'0')}`,exhibitionId,year:MOCK_ADMIN_YEARS.find(e=>e.id===exhibitionId)!.year,
   visibility: ['PUBLIC','AUTHENTICATED','STAFF'][i%3] as MockProject['visibility'],status:['PUBLISHED','ARCHIVED','DRAFT'][Math.floor(i/3)%3] as MockProject['status'],createdByUserId: i%3===2?5:3,
   members:[{id:id*100,name:i%3===2?'다른 학생':'학생',studentId:i%3===2?'2088101':'2088099',sortOrder:0,userId:i%3===2?5:3},{id:id*100+1,name:'참여 학생',studentId:'2088100',sortOrder:1,userId:4}],
   assets: base.assets.map((a,j)=>({...a,id:id*100+50+j})),posterAssetId:id*100+50,
   createdAt:new Date(Date.UTC(2025,0,i+1)).toISOString(),updatedAt:new Date(Date.UTC(2025,0,i+1)).toISOString()};
 }
 const featured=projects[1];
 featured.createdByUserId=3; featured.members[0].userId=3; featured.members[1].userId=4;
 featured.videos=[0,1].map(i=>({assetId:190+i,sortOrder:i,role:i===0?'MAIN':'ADDITIONAL',url:mockFixtureUrl('/mock/files/demo.webm'),originalDownloadUrl:mockFixtureUrl('/mock/files/demo.webm'),mimeType:'video/webm',playbackStatus:'READY'}));
 featured.video=featured.videos[0];
 featured.assets.push(...featured.videos.map(v=>({id:v.assetId,kind:'VIDEO' as const,url:v.url!,originalName:'demo.webm',size:4096,videoSortOrder:v.sortOrder,playbackStatus:'READY' as const,playbackUrl:v.url})),{id:192,kind:'DOCUMENT',originalName:'readme.txt',mimeType:'text/plain',size:64,downloadUrl:mockFixtureUrl('/mock/files/readme.txt')});
 featured.attachments=[{assetId:192,kind:'DOCUMENT',originalName:'readme.txt',mimeType:'text/plain',sizeBytes:64,downloadUrl:mockFixtureUrl('/mock/files/readme.txt')}];
 featured.webglUrl=mockFixtureUrl('/mock/webgl/index.html'); featured.webglDeployment={id:'00000000-0000-4000-8000-000000000001',url:featured.webglUrl,createdAt:featured.createdAt};
 featured.webglDisplayMode='auto';
 const fixed=projects[2];
 fixed.webglUrl=mockFixtureUrl('/mock/webgl/fixed.html');fixed.webglDeployment={id:'00000000-0000-4000-8000-000000000002',url:fixed.webglUrl,createdAt:fixed.createdAt};
 fixed.webglDisplayMode='manual';fixed.webglDisplayWidth=800;fixed.webglDisplayHeight=600;
 for (const project of Object.values(projects)) {
  const localUrl = (value: unknown): unknown => {
   if (typeof value === 'string' && value.includes('/mock/')) { const url=new URL(value);url.searchParams.set('mock_project',String(project.id));return url.href; }
   if (Array.isArray(value)) return value.map(localUrl);
   if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,localUrl(item)]));
   return value;
  };
  projects[project.id]=localUrl(project) as MockProject;
 }
 return projects;
}
