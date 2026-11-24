import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type LabRun } from '@pcu/contracts';
import { Button, ProgressBar, SelectField, TextField } from '../../components/ui';
import { labApi, type LabFormat } from '../../lib/api/lab';
import { useViewerKey } from '../../lib/query/visibility';
import { LabError, Pager } from './common';
import { active, resultLabels, runLabel, runLabels } from './labels';
import { ResultDetail } from './ResultDetail';

async function download(id: string, format: LabFormat) {
  const file = await labApi.export(id, format);
  const type = { json: 'application/json', jsonl: 'application/x-ndjson', csv: 'text/csv' }[format];
  const url = URL.createObjectURL(new Blob([file.content], { type: `${type};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function RunResults({ id }: { id: string }) {
  const viewerKey = useViewerKey();
  const client = useQueryClient();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const run = useQuery({
    queryKey: viewerKey(['lab-run', id]), queryFn: () => labApi.run(id),
    refetchInterval: query => active(query.state.data) ? 1800 : false,
  });
  const info = run.data;
  const count = info ? info.success + info.failed + info.cancelled : 0;
  const rows = useQuery({
    queryKey: viewerKey(['lab-results', id, info?.completedAt, page, q, status]), queryFn: () => labApi.results(id, page, q, status),
    enabled: run.isSuccess,
    refetchInterval: active(info) ? 1800 : false,
  });
  const action = useMutation({
    mutationFn: (kind: 'cancel' | 'retry') => kind === 'cancel' ? labApi.cancel(id) : labApi.retry(id),
    onSuccess: () => Promise.all([
      client.invalidateQueries({ queryKey: ['lab-run', id] }), client.invalidateQueries({ queryKey: ['lab-runs'] }),
      client.invalidateQueries({ queryKey: ['lab-results', id] }),
    ]),
  });
  const save = useMutation({ mutationFn: (format: LabFormat) => download(id, format) });
  if (!info || run.error) return <><LabError error={run.error}/>{run.isLoading && <p>실험을 불러오는 중…</p>}</>;
  return <>
    <div className="lab-summary" aria-live="polite">
      <strong>{runLabels[info.status]} · {count} / {info.size}개 처리</strong>
      <ProgressBar aria-label="평가 진행률" value={count} max={info.size} />
      <div className="lab-connections">
        <span>성공 <b>{info.success}</b></span><span>실패 <b>{info.failed}</b></span><span>취소 <b>{info.cancelled}</b></span>
        <span>평균 점수 <b>{info.stats.meanScore?.toFixed(1) ?? '—'}</b> ({info.stats.scored}개)</span><span>답변 유보 <b>{info.stats.abstained}</b></span>
      </div>
    </div>
    <details className="lab-metadata"><summary>프롬프트와 실행 설정</summary>
      <p>{info.systemPrompt}</p><dl>
        <dt>모델 / 검색 모드</dt><dd>{info.provider} · {info.model} · {info.searchMode}</dd>
        <dt>생성 설정</dt><dd>Temperature {info.temperature} · 출력 {info.maxTokens} 토큰</dd>
        <dt>스키마 / 평가 지침</dt><dd>{info.schemaVersion} / {info.evaluationProtocol}</dd>
        <dt>평가 split</dt><dd>{info.split ?? '전체'}</dd>
        <dt>데이터셋 버전</dt><dd>{info.datasetVersion}</dd>
        <dt>데이터셋 SHA-256</dt><dd>{info.datasetHash}</dd><dt>프롬프트 SHA-256</dt><dd>{info.promptHash}</dd>
        <dt>시작 / 완료 시각</dt><dd>{info.startedAt ?? '대기'} / {info.completedAt ?? '—'}</dd>
      </dl>
    </details>
    <div className="lab-actions">
      {active(info) && <Button variant="danger" size="small" disabled={action.isPending} onClick={() => action.mutate('cancel')}>실행 취소</Button>}
      {!active(info) && info.failed > 0 && <Button size="small" disabled={action.isPending} onClick={() => action.mutate('retry')}>실패 케이스 재실행</Button>}
      {(['json', 'jsonl', 'csv'] as const).map(format =>
        <Button key={format} variant="secondary" size="small" disabled={save.isPending} onClick={() => save.mutate(format)}>{format.toUpperCase()} 다운로드</Button>)}
    </div>
    <LabError error={action.error || save.error} />
    <div className="lab-grid">
      <TextField label="결과 검색" type="search" maxLength={160} placeholder="닉네임 또는 케이스 ID" value={q} onChange={e => { setQ(e.target.value); setPage(1); }} />
      <SelectField label="처리 상태" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}>
        <option value="">전체</option>
        {Object.entries(resultLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </SelectField>
    </div>
    <LabError error={rows.error} />
    {rows.isSuccess && <>
      {rows.data.items.map(item => <details className="lab-row" key={item.caseId}>
        <summary><span>{item.caseId}</span> <strong>{item.testCase.nickname}</strong> <small>{resultLabels[item.status]} · {item.output?.score ?? '—'}점</small></summary>
        <ResultDetail item={item} />
      </details>)}
      {!rows.data.items.length && <p>조건에 맞는 결과가 없습니다.</p>}
      <Pager page={page} total={rows.data.total} change={setPage} />
    </>}
  </>;
}

export function RunCompare({ left, runs }: { left: LabRun; runs: LabRun[] }) {
  const viewerKey = useViewerKey();
  const [rightId, setRight] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const candidates = runs.filter(run => run.id !== left.id && run.datasetHash === left.datasetHash && run.schemaVersion === left.schemaVersion);
  const right = candidates.find(run => run.id === rightId);
  const compare = useQuery({
    queryKey: viewerKey(['lab-compare', left.id, rightId, left.status, right?.status, page, q]),
    queryFn: () => labApi.compare(left.id, rightId, page, q), enabled: !!right,
    refetchInterval: right && (active(left) || active(right)) ? 2500 : false,
  });
  return <section className="lab-panel">
    <h2>실험 비교</h2>
    <p>현재 실험을 기준으로 같은 데이터셋 스냅샷 내 케이스 ID의 결과를 나란히 확인합니다.</p>
    <SelectField label="비교할 실험" value={right?.id ?? ''} onChange={e => { setRight(e.target.value); setPage(1); }}>
      <option value="">실험 선택</option>{candidates.map(run => <option key={run.id} value={run.id}>{runLabel(run)}</option>)}
    </SelectField>
    {right && <>
      <p>평균 점수 · 기준 {left.stats.meanScore?.toFixed(1) ?? '—'} / 비교 {right.stats.meanScore?.toFixed(1) ?? '—'}</p>
      <TextField type="search" maxLength={160} label="비교 결과 검색" value={q} onChange={e => { setPage(1); setQ(e.target.value); }} />
      <LabError error={compare.error} />
      {compare.isSuccess && <>
        {compare.data.items.map(row => {
          const result = row.left ?? row.right;
          return <details className="lab-row" key={row.caseId}>
            <summary><span>{row.caseId}</span> <strong>{result && result.testCase.nickname}</strong>
              <small>기준 {row.left?.output?.score ?? '—'} / 비교 {row.right?.output?.score ?? '—'}</small></summary>
            <div className="lab-grid">{[row.left, row.right].map((value, i) => <section key={i}>
              <h3>{i === 0 ? '기준 실험' : '비교 실험'}</h3>{value ? <ResultDetail item={value} /> : <p>실행 대상에서 제외됨</p>}
            </section>)}</div>
          </details>;
        })}
        <Pager page={page} total={compare.data.total} change={setPage} />
      </>}
    </>}
  </section>;
}
