import { LAB_PAGE_SIZE } from '@pcu/contracts';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useMe } from '../features/auth';
import { Button, SelectField } from '../components/ui';
import { labApi } from '../lib/api/lab';
import { useViewerKey } from '../lib/query/visibility';
import { Connections, LabError } from '../features/nickname-evaluation/common';
import { active, runLabel } from '../features/nickname-evaluation/labels';
import { RunEditor } from '../features/nickname-evaluation/RunEditor';
import { RunCompare, RunResults } from '../features/nickname-evaluation/RunResults';
import '../styles/features/nickname-evaluation.css';

function Workspace() {
  const viewerKey = useViewerKey();
  const [params, setParams] = useSearchParams();
  const status = useQuery({ queryKey: viewerKey(['lab-status']), queryFn: labApi.status, refetchInterval: 30000, retry: false });
  const runs = useInfiniteQuery({
    queryKey: viewerKey(['lab-runs']), queryFn: ({ pageParam }) => labApi.runs(pageParam),
    initialPageParam: 1, getNextPageParam: (last, pages) => last.length === LAB_PAGE_SIZE ? pages.length + 1 : undefined, enabled: status.isSuccess && status.data.enabled,
    refetchInterval: query => query.state.data?.pages.some(page => page.some(run => active(run) || run.bertScore.pending > 0 || run.bertScore.running > 0)) ? 2500 : false,
  });
  const history = runs.data?.pages.flat() ?? [];
  const id = params.get('run') || history[0]?.id || '';
  const selected = history.find(run => run.id === id);
  function select(id: string) {
    setParams(previous => { const next = new URLSearchParams(previous); next.set('run', id); return next; });
  }
  return <div className="lab-page">
    <h1>LLM 닉네임 평가 실험실</h1>
    <LabError error={status.error} />
    {status.isLoading && <p>서버 상태를 확인하는 중…</p>}
    {status.isSuccess && !status.data.enabled && <p>현재 실험실이 비활성화되어 있습니다.</p>}
    {status.isSuccess && status.data.enabled && <>
      {status.data.mock && <p className="lab-mock" role="status">Mock 실험실 · 개발용 모의 진행률과 합성 결과를 표시합니다.</p>}
      <Connections status={status.data} />
      <RunEditor key={JSON.stringify([status.data.provider, status.data.model])} status={status.data} onCreated={select} sourceRunId={id} />
      <section className="lab-panel">
        <h2>실험 결과</h2>
        <LabError error={runs.error} />
        {runs.isSuccess && (history.length ? <>
          <SelectField label="저장된 실험" value={id} onChange={e => select(e.target.value)}>
            {!selected && <option value={id}>{id}</option>}
            {history.map(run => <option key={run.id} value={run.id}>{runLabel(run)}</option>)}
          </SelectField>
          {runs.hasNextPage && <div><Button variant="secondary" size="small" disabled={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>이전 실험 더 보기</Button></div>}
          <RunResults key={id} id={id} />
        </> : <p>첫 실험을 실행하면 이곳에서 진행률과 결과를 확인할 수 있습니다.</p>)}
      </section>
      {runs.isSuccess && selected && history.length > 1 && <RunCompare key={id} left={selected} runs={history} />}
    </>}
  </div>;
}

export default function NicknameEvaluationPage() {
  const { user } = useMe();
  return user ? <Workspace key={`${user.id}:${user.role}`} /> : null;
}
