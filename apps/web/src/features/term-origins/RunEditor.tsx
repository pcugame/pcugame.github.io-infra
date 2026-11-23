import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LAB_JSONL_MAX_BYTES, LAB_PAGE_SIZE, type LabDataset, type LabSearchMode, type LabStatus } from '@pcu/contracts';
import { Button, SelectField, TextareaField, TextField } from '../../components/ui';
import { labApi, type RunSize } from '../../lib/api/lab';
import { useViewerKey } from '../../lib/query/visibility';
import { LabError, Pager } from './common';

const modeLabels: Record<LabSearchMode, string> = {
  backend_retrieval: '검색 후 평가', no_search: '검색 없이 평가', model_tool_call: '모델 도구 호출',
};

function DatasetCases({ dataset, size, selected, change }: {
  dataset: LabDataset; size: RunSize; selected: string[]; change: (ids: string[]) => void;
}) {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const viewerKey = useViewerKey();
  const cases = useQuery({
    queryKey: viewerKey(['lab-cases', dataset.id, page, q]),
    queryFn: () => labApi.cases(dataset.id, page, q),
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
          <span><small>{item.id}{'category' in item && ` · ${item.language} · ${item.category}`}</small>
            <strong>{'nickname' in item ? item.nickname : item.term}</strong>{'context' in item && <span>{item.context}</span>}</span>
        </label>
      </li>)}</ul>
      <Pager page={page} change={setPage} total={cases.data.total} />
    </>}
  </details>;
}

export function RunEditor({ status, onCreated }: { status: LabStatus; onCreated: (id: string) => void }) {
  const viewerKey = useViewerKey();
  const client = useQueryClient();
  const [tab, setTab] = useState<'nickname' | 'dataset'>('nickname');
  const direct = tab === 'nickname';
  const [nickname, setNickname] = useState('');
  const datasets = useInfiniteQuery({
    enabled: !direct, queryKey: viewerKey(['lab-datasets']), queryFn: ({ pageParam }) => labApi.datasets(pageParam), initialPageParam: 1,
    getNextPageParam: (last, pages) => last.length === LAB_PAGE_SIZE ? pages.length + 1 : undefined,
  });
  const datasetsList = datasets.data?.pages.flat() ?? [];
  const [datasetId, setDatasetId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [size, setSize] = useState<RunSize>(1);
  const [searchMode, setMode] = useState<LabSearchMode>('backend_retrieval');
  const [temperature, setTemperature] = useState('0.2');
  const [maxTokens, setMaxTokens] = useState(String(Math.min(1024, status.generationLimits?.maxOutputTokens ?? 4096)));
  const [systemPrompt, setPrompt] = useState('닉네임에서 복원 가능한 원문과 변형 규칙을 찾고, 은어·모욕·논란성 용례를 근거와 함께 설명하세요. 어원과 현대 용례를 따로 평가하고 관련 발췌문을 인용하세요. 일반적인 해석도 고려하세요. 논란 가능성을 판단할 근거가 부족하면 점수를 null로 두고 판단을 보류하세요. 사용자 의도나 소속을 단정하지 마세요. 점수는 추가 검토 필요성을 나타냅니다.');
  const limits = status.generationLimits;
  const outputLimit = limits?.maxOutputTokens ?? 4096;
  const searchUnavailable = status.searchStatus === 'unavailable';
  const effectiveMode = status.toolSupport === 'unsupported' && searchMode === 'model_tool_call' ? 'backend_retrieval' : searchMode;
  const dataset = datasetsList.find(item => item.id === datasetId) ?? datasetsList[0];
  function selectDataset(id: string) { setDatasetId(id); setSelected([]); }
  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > LAB_JSONL_MAX_BYTES) throw new Error('4 MiB 이하의 JSONL 파일을 선택하세요.');
      const jsonl = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
      return labApi.upload(file.name, jsonl);
    },
    onSuccess: async data => {
      await client.invalidateQueries({ queryKey: ['lab-datasets'] });
      selectDataset(data.id);
    },
  });
  const create = useMutation({
    mutationFn: () => labApi.create({
      ...(direct ? { nickname: nickname.trim() } : { datasetId: dataset!.id, size, ...(selected.length ? { caseIds: selected } : {}) }),
      systemPrompt, model: status.model, temperature: limits?.fixedTemperature ?? Number(temperature),
      maxTokens: Number(maxTokens), searchMode: effectiveMode,
    }),
    onSuccess: async ({ runId }) => {
      await client.invalidateQueries({ queryKey: ['lab-runs'] });
      onCreated(runId);
    },
  });
  const validSelection = direct ? !!nickname.trim() : !!dataset && (!selected.length || selected.length === size);
  const canSubmit = validSelection && !!status.model && status.systemPromptSupported !== false && !!systemPrompt.trim()
    && (effectiveMode === 'no_search' || !searchUnavailable) && !create.isPending && (direct || !upload.isPending);
  return <section className="lab-panel">
    <h2>새 실험</h2>
    <div className="lab-actions" role="tablist" aria-label="실험 방식" onKeyDown={e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const next = e.key === 'Home' ? 'nickname' : e.key === 'End' ? 'dataset' : direct ? 'dataset' : 'nickname';
      setTab(next);
      e.currentTarget.querySelector<HTMLButtonElement>(`#lab-tab-${next}`)?.focus();
    }}>
      {(['nickname', 'dataset'] as const).map(value => <Button key={value} role="tab" id={`lab-tab-${value}`}
        variant={tab === value ? 'primary' : 'secondary'} tabIndex={tab === value ? 0 : -1}
        aria-selected={tab === value} aria-controls="lab-editor" onClick={() => setTab(value)}>
        {value === 'nickname' ? '닉네임 직접 입력' : '데이터셋 실험'}
      </Button>)}
    </div>
    <div id="lab-editor" role="tabpanel" aria-labelledby={`lab-tab-${tab}`}>
      <form className="lab-form"
        onSubmit={e => { e.preventDefault(); if (canSubmit) create.mutate(); }}>
        {direct
          ? <TextField label="닉네임" placeholder="예: 계집" required maxLength={300} value={nickname} onChange={e => setNickname(e.target.value)} />
          : <>
            <div className="lab-grid">
              <SelectField label="데이터셋" value={dataset?.id ?? ''} onChange={e => selectDataset(e.target.value)}>
                {!datasetsList.length && <option value="">등록된 데이터셋 없음</option>}
                {datasetsList.map(item => <option key={item.id} value={item.id}>{item.name} · {item.version}</option>)}
              </SelectField>
              <label className="form-field"><span className="form-field__label">데이터셋 등록 · JSONL 500개</span>
                <input type="file" accept=".jsonl,application/x-ndjson" disabled={upload.isPending} onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) upload.mutate(file);
                  e.target.value = '';
                }} />
              </label>
            </div>
            {datasets.hasNextPage && <div><Button size="small" variant="secondary" disabled={datasets.isFetchingNextPage} onClick={() => void datasets.fetchNextPage()}>이전 데이터셋 더 보기</Button></div>}
            {upload.isPending && <p role="status">파일을 검증하고 등록하는 중…</p>}
            {upload.data && <p role="status">{upload.data.count}개 케이스를 검증해 등록했습니다.</p>}
            <LabError error={upload.error || datasets.error} />
            <SelectField label="실험 크기" value={size} onChange={e => { setSize(Number(e.target.value) as RunSize); setSelected([]); }}>
              <option value="1">1개 · Smoke Test</option><option value="10">10개 · 간단한 시험</option>
              <option value="50">50개 · 예비 벤치마크</option><option value="500">500개 · 전체 벤치마크</option>
            </SelectField>
            {dataset && <DatasetCases key={dataset.id} dataset={dataset} size={size} selected={selected} change={setSelected} />}
          </>}
        <p>로컬 모델 · {status.model || '설정된 모델 없음'} ({status.provider})</p>
        {limits && <p>시스템 지시와 검색 발췌문을 포함한 입력 한도는 {limits.maxInputTokens}토큰입니다.</p>}
        <TextareaField label="시스템 프롬프트" rows={5} maxLength={16000} required value={systemPrompt} onChange={e => setPrompt(e.target.value)} />
        <div className="lab-grid lab-grid--settings">
          <SelectField label="검색 모드" value={effectiveMode} onChange={e => setMode(e.target.value as LabSearchMode)}>
            <option value="backend_retrieval">{modeLabels.backend_retrieval}</option>
            <option value="no_search">{modeLabels.no_search}</option>
            <option value="model_tool_call" disabled={searchUnavailable || status.toolSupport === 'unsupported'}>{modeLabels.model_tool_call}</option>
          </SelectField>
          <TextField type="number" label="Temperature" min={0} max={2} step="any" required disabled={!!limits} value={limits?.fixedTemperature ?? temperature} onChange={e => setTemperature(e.target.value)} />
          <TextField type="number" label="최대 출력 토큰" min={128} max={outputLimit} step={1} required value={maxTokens} onChange={e => setMaxTokens(e.target.value)} />
        </div>
        {searchUnavailable && effectiveMode !== 'no_search' && <p role="status">검색 서버에 연결할 수 없습니다. 검색 없이 평가하려면 검색 모드를 변경하세요.</p>}
        <LabError error={create.error} />
        <div className="lab-actions">
          <Button type="submit" disabled={!canSubmit}>
            {create.isPending ? '요청 중…' : direct ? modeLabels[effectiveMode] : `${size}개 평가 실행`}
          </Button>
          {!direct && selected.length > 0 && selected.length !== size && <span>직접 선택하려면 {size - selected.length}개를 더 선택하세요.</span>}
        </div>
      </form>
    </div>
  </section>;
}
