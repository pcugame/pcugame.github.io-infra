import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LAB_DATASET_MAX_BYTES, LAB_PAGE_SIZE, LAB_MAX_CASES, LAB_NICKNAME_SYSTEM_PROMPT, LAB_RESEARCH_SYSTEM_PROMPT, LAB_NICKNAME_JSONL_TEMPLATE, LAB_NICKNAME_CSV_TEMPLATE, type LabDataset, type LabSearchMode, type LabStatus } from '@pcu/contracts';
import { Button, CheckboxField, SelectField, TextareaField, TextField } from '../../components/ui';
import { labApi, type LabSplit } from '../../lib/api/lab';
import { useViewerKey } from '../../lib/query/visibility';
import { LabError, Pager } from './common';

const splitLabels: Record<LabSplit, string> = { train: '학습용', validation: '검증용', test: '최종 시험용' };
const searchHelp: Record<LabSearchMode, string> = {
  no_search: '인터넷 검색 없이 모델이 알고 있는 내용으로 판단합니다.',
  backend_retrieval: '서버가 닉네임을 먼저 검색하고, 찾은 자료를 모델에 전달합니다.',
  agentic_retrieval: '모델이 해석 후보와 검색어를 정하고, 자료를 더 찾아보며 판단합니다.',
  model_tool_call: '모델이 필요할 때 검색 도구를 호출합니다. 도구 호출을 지원하는 모델에서만 사용할 수 있습니다.',
};

function SplitOptions() {
  return Object.entries(splitLabels).map(([value, label]) => <option key={value} value={value}>{label} ({value})</option>);
}

function DatasetCases({ dataset, size, selected, change, split }: {
  dataset: LabDataset; size: number; selected: string[]; change: (ids: string[]) => void; split?: LabSplit;
}) {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const viewerKey = useViewerKey();
  const cases = useQuery({
    queryKey: viewerKey(['lab-cases', dataset.id, page, q, split]),
    queryFn: () => labApi.cases(dataset.id, page, q, split),
  });
  return <details className="lab-preview">
    <summary>테스트케이스 미리보기 · {dataset.count}개</summary>
    <TextField type="search" maxLength={160} label="케이스 검색" placeholder="닉네임 또는 케이스 ID" value={q} onChange={e => { setQ(e.target.value); setPage(1); }} />
    <p>직접 선택한 케이스가 없으면 파일 순서대로 {size}개를 실행합니다.</p>
    <div className="lab-actions"><strong>직접 선택 {selected.length} / {size}개</strong>
      {!!selected.length && <Button size="small" variant="secondary" onClick={() => change([])}>선택 해제</Button>}
    </div>
    <LabError error={cases.error} />
    {cases.isSuccess && <>
      <ul className="lab-cases">{cases.data.items.map(item => <li key={item.id}>
        <label><input type="checkbox" checked={selected.includes(item.id)}
          disabled={selected.length >= size && !selected.includes(item.id)} onChange={e =>
            change(e.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))} />
          <span><small>{item.id}</small>
            <strong>{item.nickname}</strong>
            <span>기대 근거 (가설): {item.reference.expectedReason}<br/>기대 점수: {item.reference.expectedScore} · 범위: {item.reference.scoreRange?.join('–') ?? '미지정'}<br/>데이터 용도: {item.split ? splitLabels[item.split] : '미지정'} · 표현군: {item.familyId ?? '미지정'}</span></span>
        </label>
      </li>)}</ul>
      <Pager page={page} change={setPage} total={cases.data.total} />
    </>}
  </details>;
}

export function RunEditor({ status, onCreated }: { status: LabStatus; onCreated: (id: string) => void }) {
  const viewerKey = useViewerKey();
  const client = useQueryClient();
  const datasets = useInfiniteQuery({
    queryKey: viewerKey(['lab-datasets']), queryFn: ({ pageParam }) => labApi.datasets(pageParam), initialPageParam: 1,
    getNextPageParam: (last, pages) => last.length === LAB_PAGE_SIZE ? pages.length + 1 : undefined,
  });
  const datasetsList = datasets.data?.pages.flat() ?? [];
  const [datasetId, setDatasetId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [sizeMode, setSizeMode] = useState('1');
  const [customSize, setCustomSize] = useState('1');
  const [finalTest, setFinalTest] = useState(false);
  const [split, setSplit] = useState<LabSplit | ''>('');
  const [defaultSplit, setDefaultSplit] = useState<LabSplit | ''>('');
  const [searchMode, setMode] = useState<LabSearchMode>('no_search');
  const [temperature, setTemperature] = useState('0.2');
  const [maxTokens, setMaxTokens] = useState(String(Math.min(1024, status.generationLimits?.maxOutputTokens ?? 4096)));
  const limits = status.generationLimits;
  const outputLimit = limits?.maxOutputTokens ?? 4096;
  const effectiveMode = status.toolSupport === 'unsupported' && searchMode === 'model_tool_call' ? 'no_search' : searchMode;
  const searchUnavailable = effectiveMode !== 'no_search' && status.searchStatus !== 'available';
  const dataset = datasetsList.find(item => item.id === datasetId) ?? datasetsList[0];
  const available = useQuery({ queryKey: viewerKey(['lab-count', dataset?.id, split]), queryFn: () => labApi.cases(dataset!.id, 1, '', split || undefined), enabled: !!dataset });
  const count = available.data?.total ?? 0;
  const size = sizeMode === 'all' ? count : Number(sizeMode === 'custom' ? customSize : sizeMode);
  const validSize = Number.isInteger(size) && size > 0 && size <= count && size <= LAB_MAX_CASES;
  function selectDataset(id: string) { setDatasetId(id); setSelected([]); setSplit(''); }
  function template(format: 'jsonl' | 'csv') {
    const url = URL.createObjectURL(new Blob([format === 'csv' ? '\uFEFF' + LAB_NICKNAME_CSV_TEMPLATE : LAB_NICKNAME_JSONL_TEMPLATE], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `nickname-template.${format}`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > LAB_DATASET_MAX_BYTES) throw new Error('4 MiB 이하의 JSONL·CSV 파일을 선택하세요.');
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
      return labApi.upload({ name: file.name, format: file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'jsonl', content, ...(defaultSplit ? { defaultSplit } : {}) });
    },
    onSuccess: async data => {
      await client.invalidateQueries({ queryKey: ['lab-datasets'] });
      selectDataset(data.id);
    },
  });
  const create = useMutation({
    mutationFn: () => labApi.create({
      datasetId: dataset!.id, size, finalTest, ...(split ? { split } : {}), model: status.model, temperature: limits?.fixedTemperature ?? Number(temperature),
      maxTokens: Number(maxTokens), searchMode: effectiveMode, ...(selected.length ? { caseIds: selected } : {}),
    }),
    onSuccess: async ({ runId }) => {
      await client.invalidateQueries({ queryKey: ['lab-runs'] });
      onCreated(runId);
    },
  });
  return <section className="lab-panel">
    <h2>새 실험</h2>
    <div className="lab-grid">
      <SelectField label="데이터셋" help="평가할 닉네임과 사람이 작성한 기대 근거·점수를 모은 자료입니다." value={dataset?.id ?? ''} onChange={e => selectDataset(e.target.value)}>
        {!datasetsList.length && <option value="">등록된 데이터셋 없음</option>}
        {datasetsList.map(item => <option key={item.id} value={item.id}>{item.name} · v{item.schemaVersion} · {item.hash.slice(0, 8)}</option>)}
      </SelectField>
      <SelectField label="가져오기 기본 용도" help="파일에 용도(split)가 없는 항목에만 적용합니다. 이미 지정된 용도는 유지합니다." value={defaultSplit} onChange={e => setDefaultSplit(e.target.value as LabSplit | '')}>
        <option value="">미지정</option><SplitOptions />
      </SelectField>
      <label className="form-field"><span className="form-field__label">데이터셋 등록 · 최대 4 MiB</span>
        <input className="form-file" type="file" accept=".jsonl,.csv,application/x-ndjson,text/csv" disabled={upload.isPending} onChange={e => {
          const file = e.target.files?.[0];
          if (file) upload.mutate(file);
          e.target.value = '';
        }} />
      </label>
    </div>
    <div className="lab-actions"><Button variant="secondary" size="small" onClick={() => template('jsonl')}>JSONL 기본 양식</Button><Button variant="secondary" size="small" onClick={() => template('csv')}>CSV 기본 양식</Button></div>
    <p>닉네임·기대 근거·기대 점수는 필수입니다. 기대 근거와 점수는 사람이 작성한 비교 기준이며, 정답으로 확정된 값은 아닙니다.</p>
    <details className="lab-preview"><summary>파일의 선택 항목 안내</summary>
      <p>ID는 비워 두면 자동으로 부여합니다. 표현군(familyId)은 같은 표현에서 나온 닉네임을 묶는 이름입니다. 태그(tags), 데이터 용도(split), 허용 점수 범위(scoreRange), 참고 출처(sources)도 추가할 수 있습니다.</p>
    </details>
    {datasets.hasNextPage && <div><Button size="small" variant="secondary" disabled={datasets.isFetchingNextPage} onClick={() => void datasets.fetchNextPage()}>이전 데이터셋 더 보기</Button></div>}
    {upload.isPending && <p role="status">파일을 검증하고 등록하는 중…</p>}
    {upload.data && <p role="status">{upload.data.count}개 케이스를 검증해 등록했습니다.</p>}
    <LabError error={upload.error || datasets.error} />
    <form className="lab-form" onSubmit={e => { e.preventDefault(); if (dataset && validSize && !searchUnavailable && !create.isPending) create.mutate(); }}>
      <div className="lab-grid">
        <SelectField label="실험 크기" help="이번에 평가할 닉네임 수입니다. 직접 선택하지 않으면 파일에 적힌 순서대로 평가합니다." value={sizeMode} onChange={e => { setSizeMode(e.target.value); setSelected([]); }}>
          <option value="1">1개 · 동작 확인</option><option value="10">10개 · 간단한 시험</option>
          <option value="50">50개 · 예비 평가</option><option value="all">전체 · 선택한 용도</option><option value="custom">사용자 지정</option>
        </SelectField>
        <SelectField label="로컬 모델" help="서버에 설정된 평가 모델입니다. 모델 변경은 운영자에게 요청하세요." value={status.model} onChange={() => {}}>
          <option value={status.model}>{status.model || '설정된 모델 없음'} · {status.provider}</option>
        </SelectField>
      </div>
      {sizeMode === 'custom' && <TextField label="사용자 지정 개수" type="number" min={1} max={count || LAB_MAX_CASES} value={customSize} onChange={e => { setCustomSize(e.target.value); setSelected([]); }} />}
      <SelectField label="평가 대상 용도" help="학습용은 모델 학습에, 검증용은 설정 비교에, 최종 시험용은 설정을 확정한 뒤 성능 확인에 쓰는 자료입니다. 이번에 평가할 용도를 선택하세요." value={split} onChange={e => { setSplit(e.target.value as LabSplit | ''); setSelected([]); }}>
        <option value="">전체 (미지정 포함)</option><SplitOptions />
      </SelectField>
      {dataset && <p>자료 형식 v{dataset.schemaVersion} · 자료 식별값 {dataset.hash.slice(0, 12)} · 선택한 용도 {count}개</p>}
      <LabError error={available.error} />
      {dataset && <DatasetCases key={`${dataset.id}-${split}`} split={split || undefined} dataset={dataset} size={size} selected={selected} change={setSelected} />}
      <TextareaField label="고정 평가 지침" help="모델이 닉네임을 판단할 때 따르는 공통 기준입니다. 같은 조건에서 결과를 비교하도록 이 화면에서는 수정할 수 없습니다." readOnly rows={5} value={status.agenticRetrieval ? LAB_RESEARCH_SYSTEM_PROMPT : LAB_NICKNAME_SYSTEM_PROMPT} />
      <div className="lab-grid lab-grid--settings">
        <SelectField label="검색 모드" help={searchHelp[effectiveMode]} value={effectiveMode} onChange={e => setMode(e.target.value as LabSearchMode)}>
          <option value="no_search">검색 없이 분석</option>
          <option value="backend_retrieval">먼저 검색한 뒤 분석</option>
          <option value="agentic_retrieval" disabled={!status.agenticRetrieval}>모델이 검색하며 분석</option>
          <option value="model_tool_call" disabled={status.toolSupport === 'unsupported'}>모델 도구 호출</option>
        </SelectField>
        <TextField type="number" label="답변의 다양성" help={`낮을수록 비슷한 답변을, 높을수록 다양한 답변을 내도록 하는 값입니다.${limits ? ' 현재 모델은 비교 조건을 맞추기 위해 이 값을 고정합니다.' : ''}`} min={0} max={2} step="any" required disabled={!!limits} value={limits?.fixedTemperature ?? temperature} onChange={e => setTemperature(e.target.value)} />
        <TextField type="number" label="응답 길이 제한" help="답변에 쓸 수 있는 최대 토큰 수입니다. 토큰은 글을 나누어 세는 단위로, 글자 수와는 다릅니다." min={128} max={outputLimit} step={1} required value={maxTokens} onChange={e => setMaxTokens(e.target.value)} />
      </div>
      <LabError error={create.error} />
      {searchUnavailable && <p>검색 서비스에 연결할 수 없습니다. 연결 복구 후 실행하거나 검색 없이 분석을 선택하세요.</p>}
      {!validSize && dataset && <p>선택한 용도에서 평가할 수 있는 닉네임은 {count}개입니다.</p>}
      <CheckboxField label="설정을 확정하고 최종 평가로 실행" help="최종 시험용 자료나 같은 표현군의 닉네임이 포함되면 체크해야 합니다. 시험 결과를 보고 설정을 반복해서 바꾸면 성능을 공정하게 비교하기 어렵습니다." checked={finalTest} onChange={e => setFinalTest(e.target.checked)} />
      <div className="lab-actions">
        <Button type="submit" disabled={!validSize || !dataset || !status.model || searchUnavailable || upload.isPending || create.isPending || (selected.length > 0 && selected.length !== size)}>
          {create.isPending ? '요청 중…' : `${size}개 평가 실행`}
        </Button>
        {selected.length > 0 && selected.length !== size && <span>직접 선택하려면 {size - selected.length}개를 더 선택하세요.</span>}
      </div>
    </form>
  </section>;
}
