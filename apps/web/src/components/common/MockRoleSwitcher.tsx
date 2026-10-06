import { useEffect, useState } from 'react';
import { queryClient } from '../../lib/query/client';
import type { MockState, MockUserSelection } from '../../lib/api/mock/context';
import type { MockScenario } from '../../lib/api/mock/scenarios';

const USERS: Array<{key:MockUserSelection;label:string}> = [
  {key:'anonymous',label:'익명'}, {key:'owner',label:'소유 학생'}, {key:'participant',label:'공동 참여자'},
  {key:'other',label:'다른 학생'}, {key:'OPERATOR',label:'운영자'}, {key:'ADMIN',label:'관리자'},
];
export function MockRoleSwitcher() {
  const [state,setState]=useState<MockState>();
  const [error,setError]=useState('');
  const [open,setOpen]=useState(false);
  const [faultPath,setFaultPath]=useState('/api/admin/projects');
  useEffect(()=>{
    if(import.meta.env.VITE_MOCK!=='true') return;
    let disposed=false, unsubscribe=()=>{}, external=()=>{};
    void import('../../lib/api/mock/transport').then(async transport=>{
      if(disposed)return;
      const refresh=()=>{ if(!disposed) setState(transport.getMockState()); };
      unsubscribe=transport.subscribeMockState(refresh);
      external=transport.subscribeMockExternalChanges(()=>{void queryClient.cancelQueries().then(()=>queryClient.resetQueries());});
      await transport.reloadMockState(); refresh();
    }).catch(err=>{if(!disposed)setError(String(err));});
    return ()=>{disposed=true;unsubscribe();external();};
  },[]);
  if(import.meta.env.VITE_MOCK!=='true')return null;
  async function action(run:()=>Promise<unknown>,invalidate=false){
    try { setError(''); await run(); if(invalidate){await queryClient.cancelQueries(); await queryClient.resetQueries();} }
    catch(err){setError(err instanceof Error?err.message:String(err));}
  }
  return <div className="mock-switcher" style={{maxWidth:'95vw',flexWrap:'wrap'}}>
    <button className="mock-switcher__btn" onClick={()=>setOpen(!open)}>Mock 개발 패널 {open?'닫기':'열기'}</button>
    <select aria-label="Mock 사용자" value={state?.authUser??'ADMIN'} onChange={event=>{const user=event.target.value as MockUserSelection;void action(async()=>{
      const transport=await import('../../lib/api/mock/transport'); await transport.selectMockUser(user);
    },true);}}>{USERS.map(u=><option key={u.key} value={u.key}>{u.label}</option>)}</select>
    {open&&<>
      <select aria-label="Mock 시나리오" defaultValue="" onChange={event=>{
        const scenario=event.target.value as MockScenario; if(!scenario)return;
        if(window.confirm('시나리오를 변경하면 저장된 Mock 데이터와 작업이 삭제됩니다.')) void action(async()=>{
          const {chooseMockScenario}=await import('../../lib/api/mock/scenarios'); await chooseMockScenario(scenario);
          const {clearMockBrowserProgress}=await import('../../lib/api/mock/browser-progress'); clearMockBrowserProgress(window.sessionStorage); window.location.reload();
        },true); event.target.value='';
      }}><option value="">시나리오 선택</option><option value="default">기본 전시</option><option value="empty">빈 데이터</option><option value="permissions">권한·수정 종료</option><option value="media">미디어 처리</option><option value="review">변경 요청 검토</option><option value="failures">실패·재시도</option></select>
      <label>지연(ms) <input aria-label="요청 지연" type="number" min={0} max={30000} style={{width:75}} value={state?.controls.delayMs??0} onChange={event=>{const delayMs=Math.max(0,Math.min(30000,Number(event.target.value)));void action(async()=>{
        const transport=await import('../../lib/api/mock/transport'); await transport.setMockControls({delayMs});
      });}}/></label>
      <select aria-label="작업 결과" value={state?.controls.worker??'auto'} onChange={event=>{const worker=event.target.value as 'auto'|'paused'|'fail';void action(async()=>{
        const transport=await import('../../lib/api/mock/transport'); await transport.setMockControls({worker});
      },true);}}><option value="auto">작업 성공</option><option value="paused">작업 일시 정지</option><option value="fail">작업 실패</option></select>
      <input aria-label="일회성 실패 경로" value={faultPath} onChange={e=>setFaultPath(e.target.value)} style={{width:190}}/>
      <button onClick={()=>void action(async()=>{const transport=await import('../../lib/api/mock/transport');await transport.setMockControls({fault:{path:faultPath,status:429,code:'RATE_LIMITED',message:'Mock one-shot rate limit',retryAfter:'0'}});})}>다음 요청 429</button>
      <button onClick={()=>{if(window.confirm('저장된 Mock 데이터와 작업을 모두 삭제하시겠습니까?'))void action(async()=>{const transport=await import('../../lib/api/mock/transport');await transport.resetMockState();const {clearMockBrowserProgress}=await import('../../lib/api/mock/browser-progress');clearMockBrowserProgress(window.sessionStorage);window.location.reload();},true);}}>전체 초기화</button>
      <button onClick={()=>void action(async()=>{const transport=await import('../../lib/api/mock/transport');await transport.updateMockState(state=>{state.authExpiresAt=new Date(0).toISOString();});},true)}>세션 만료</button>
      {state?.projects[1] && <a href="/projects/1">다운로드·영상·문서 예시</a>}
      {state?.projects[2] && <a href="/projects/2">고정 크기 WebGL 예시</a>}
      {state?.projects[3] && <a href="/projects/3">첨부·긴 설명 예시</a>}
      {state?.projects[4] && <a href="/projects/4">포스터 없는 예시</a>}
      <span>저장 버전 {state?.version??'…'} · revision {state?.revision??'…'}</span>
    </>}
    {error&&<span role="alert">Mock 저장/요청 오류: {error}</span>}
  </div>;
}
