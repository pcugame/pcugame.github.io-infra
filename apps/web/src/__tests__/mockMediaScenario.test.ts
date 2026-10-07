/* @vitest-environment jsdom */
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { ProjectVideo } from '../components/project/ProjectVideo';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicProjectDetailResponseSchema } from '@pcu/contracts';
import { publicApi } from '../lib/api/public';
import { chooseMockScenario } from '../lib/api/mock/scenarios';
import { forgetMockCacheForTests, getMockState, reloadMockState, resetMockState, setMockControls } from '../lib/api/mock/transport';

beforeEach(async()=>{
 await forgetMockCacheForTests();vi.stubGlobal('indexedDB',new IDBFactory());vi.stubEnv('VITE_MOCK','true');await resetMockState();
});
afterEach(async()=>{cleanup();await forgetMockCacheForTests();vi.unstubAllGlobals();vi.unstubAllEnvs();});
function expectAssetStatuses(status:'PENDING'|'READY'|'FAILED') {
 const state=getMockState()!,project=state.projects[1];
 const videos=project.assets.filter(a=>a.kind==='VIDEO');
 expect(videos).toHaveLength(2);expect(project.videos).toHaveLength(2);
 for(const asset of videos)expect(asset.kind==='VIDEO'&&asset.playbackStatus).toBe(status);
 expect(project.videos.map(v=>v.playbackStatus)).toEqual([status,status]);
 expect(project.video?.assetId).toBe(project.videos[0].assetId);
 return project;
}
describe('persisted media scenario worker lifecycle',()=>{
 it('pauses both videos across reload, then resumes into browser-playable READY assets',async()=>{
  await chooseMockScenario('media');const pending=await publicApi.getProjectDetail(1);
  const player=render(createElement(ProjectVideo,{video:pending.video,poster:pending.poster,title:pending.title}));
  expect(screen.getByText('재생용 영상이 아직 준비되지 않았습니다.')).toBeTruthy();
  expect(screen.getByRole('link',{name:'동영상 원본 다운로드'})).toBeTruthy();
  expect(pending.videos).toHaveLength(2);expect(pending.videos.every(v=>!v.url&&!!v.originalDownloadUrl)).toBe(true);expectAssetStatuses('PENDING');
  await forgetMockCacheForTests();await reloadMockState();expectAssetStatuses('PENDING');
  await setMockControls({worker:'auto'});
  const ready=PublicProjectDetailResponseSchema.parse(await publicApi.getProjectDetail(1));
  expect(ready.videos.map(v=>v.assetId)).toEqual(pending.videos.map(v=>v.assetId));expect(ready.videos.every(v=>!!v.url&&v.playbackStatus==='READY')).toBe(true);
  player.rerender(createElement(ProjectVideo,{video:ready.video,poster:ready.poster,title:ready.title}));
  expect(player.container.querySelector('video source')?.getAttribute('src')).toBe(ready.video?.url);
  expect(screen.queryByText('재생용 영상이 아직 준비되지 않았습니다.')).toBeNull();
  expectAssetStatuses('READY');
  expect(Object.values(getMockState()!.sessions).every(s=>s.state==='READY')).toBe(true);
  await forgetMockCacheForTests();await reloadMockState();expectAssetStatuses('READY');
 });
 it('resumes into FAILED fallback videos while preserving original downloads and durable failure state',async()=>{
  await chooseMockScenario('media');await setMockControls({worker:'fail'});
  const failed=PublicProjectDetailResponseSchema.parse(await publicApi.getProjectDetail(1));
  const player=render(createElement(ProjectVideo,{video:failed.video,poster:failed.poster,title:failed.title}));
  expect(screen.getByRole('link',{name:'동영상 원본 다운로드'})).toBeTruthy();
  expect(player.container.querySelector('video')).toBeNull();
  expect(failed.videos.every(v=>!v.url&&!!v.originalDownloadUrl&&v.playbackStatus==='FAILED'&&!!v.playbackError)).toBe(true);expectAssetStatuses('FAILED');
  expect(Object.values(getMockState()!.sessions).every(s=>s.state==='REJECTED')).toBe(true);
  await forgetMockCacheForTests();await reloadMockState();expectAssetStatuses('FAILED');
 });
});
