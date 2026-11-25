import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LabCurationPolicySchema, type LabCurationExport, type LabCurationExportRequest } from '@pcu/contracts';
import { Button, TextField, SelectField } from '../../components/ui';
import { labApi } from '../../lib/api/lab';
import { useViewerKey } from '../../lib/query/visibility';
import { LabError } from './common';
import { behaviorLabels, behaviorReasonLabels, verdictLabels } from './human-labels';

function downloadFiles(file: LabCurationExport) {
  for (const item of file.files) {
    const url = URL.createObjectURL(new Blob([item.content], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = item.filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
export function CurationPanel({ runId, completedAt, threshold, setThreshold, evaluationVersion, showBertScore }: { runId: string; completedAt: string | null; threshold: number; setThreshold: (value: number) => void; evaluationVersion: string; showBertScore: boolean }) {
  const viewerKey = useViewerKey();
  const client = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [scopeSelected, setScopeSelected] = useState(false);
  const [policy, setPolicy] = useState(LabCurationPolicySchema.parse({}));
  const overview = useQuery({ queryKey: viewerKey(['lab-curation', runId, completedAt, threshold, evaluationVersion]), queryFn: () => labApi.curation(runId, threshold) });
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ['lab-curation', runId] }), client.invalidateQueries({ queryKey: ['lab-review', runId] })]);
  const data = overview.data;
  const chosen = data?.feedback.filter(f => selected.includes(f.review.id)) ?? [];
  const validSelection = chosen.length === selected.length && chosen.every(f => f.eligible);
  const candidateIds = chosen.flatMap(f => f.candidateId ? [f.candidateId] : []);
  const approve = useMutation({ mutationFn: () => labApi.approveFeedback(runId, { reviewIds: selected, scope: data!.scope! }), onSuccess: refresh });
  const release = useMutation({ mutationFn: (kind: LabCurationExportRequest['kind']) => labApi.createCurationExport(runId,
    { kind, candidateIds: kind === 'train' ? candidateIds : [], scope: data!.scope!, policy, approved: true }),
    onSuccess: async file => { downloadFiles(file); await refresh(); } });
  const download = useMutation({ mutationFn: (id: string) => labApi.curationExport(runId, id), onSuccess: downloadFiles });
  const positive = chosen.filter(f => f.review.body.behavior === 'positive').length;
  const families = Object.fromEntries([...new Set(chosen.map(f => f.familyId))].map(family => [family ?? '미지정', chosen.filter(f => f.familyId === family).length]));
  const reasons = Object.entries(behaviorReasonLabels).flatMap(([reason, label]) => {
    const count = chosen.filter(f => f.review.body.behaviorReasons?.some(v => v === reason)).length;
    return count ? [[label, count]] : [];
  });
  return <section className="lab-panel"><h2>행동 피드백 · Preference 데이터</h2>
    <LabError error={overview.error || approve.error || release.error || download.error} />
    {data && <>
      <p>전체 {data.metrics.total} · 최신 검수 {data.metrics.reviewed} · 재검수 필요 {data.metrics.staleReviews}</p>
      <details><summary>벤치마크 지표와 상세 통계</summary>
      <TextField label="위험 판정 임계점 (이상)" type="number" min={0} max={100} value={threshold} onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 0 && n <= 100) setThreshold(n); }} />
      <p className="lab-meta">미평가·유보·실패는 전체 건수에 남습니다. MAE·시간은 측정값이 있는 사례만 분모로 사용하며 누락 건수를 표시합니다. 오탐·미탐률은 사람이 분류한 사례 기준이므로 대상 미채점률과 함께 확인합니다. 출처 지표의 분모는 인용 ID 수입니다.</p>
      <div className="lab-metrics"><table><thead><tr><th>지표</th><th>값</th><th>분자 / 분모</th><th>미측정</th></tr></thead>
        <tbody>{data.metrics.metrics.filter(metric => showBertScore || !metric.key.startsWith('bertScore_')).map(metric => <tr key={metric.key}><th>{metric.label}</th><td>{metric.value === null ? '—' : metric.unit === 'rate' ? `${(metric.value * 100).toFixed(1)}%` : `${metric.value.toFixed(metric.key.startsWith('bertScore_') ? 4 : 1)}${metric.unit === 'ms' ? ' ms' : ''}`}</td><td>{metric.numerator.toFixed(Number.isInteger(metric.numerator) ? 0 : 1)} / {metric.denominator}</td><td>{metric.missing}</td></tr>)}</tbody></table></div>
      </details>
      <SelectField label="학습에 사용할 평가 정책·프롬프트 범위" value={scopeSelected ? 'current' : ''} onChange={e => setScopeSelected(e.target.value === 'current')}>
        <option value="">범위를 선택하세요</option>
        {data.scope && <option value="current">현재 실험 · 프롬프트 {data.scope.promptHash.slice(0, 12)}</option>}
      </SelectField>
      {data.scope ? <details><summary>선택 가능한 평가 정책과 프롬프트</summary><p>{data.scope.feedbackPolicy}</p><p>프롬프트 SHA-256: {data.scope.promptHash}</p><p>이 파일에는 현재 실험의 피드백만 포함됩니다. 다른 평가 정책·프롬프트 실험은 별도 파일로 관리합니다.</p></details> : <p>행동 평가 정책이 없는 과거 실험입니다. 설정을 복사하여 재실행하세요.</p>}
      <p>개별 검수에서 저장한 피드백을 선택하고 한 번에 승인합니다. 원본 응답은 수정하지 않습니다.</p>
      <div className="lab-actions"><Button variant="secondary" onClick={() => setSelected(data.feedback.filter(f => f.eligible).map(f => f.review.id))}>학습 가능 피드백 모두 선택</Button><Button variant="secondary" onClick={() => setSelected([])}>선택 해제</Button></div>
      <ul className="lab-cases">{data.feedback.map(feedback => <li key={feedback.review.id}>
        <label><input type="checkbox" disabled={!feedback.eligible} checked={selected.includes(feedback.review.id)} onChange={e => setSelected(ids => e.target.checked ? [...ids, feedback.review.id] : ids.filter(id => id !== feedback.review.id))} />
          <span><strong>{feedback.nickname} · {behaviorLabels[feedback.review.body.behavior ?? 'exclude']}</strong><span>벤치마크 {verdictLabels[feedback.review.body.verdict]} · 표현군 {feedback.familyId ?? '미지정'} · {feedback.candidateId ? '승인됨' : '미승인'}</span>
            <span>{feedback.review.body.behaviorReasons?.map(r => behaviorReasonLabels[r]).join(' · ')}</span>{feedback.exclusion && <small>{feedback.exclusion}</small>}</span>
        </label>
        <details><summary>저장된 피드백 상세</summary><p>{feedback.review.body.notes || '메모 없음'}</p><small>검수 {feedback.review.revision}차 · {feedback.review.createdAt}</small></details>
      </li>)}</ul>
      {!data.feedback.length && <p>위 검수 화면에서 행동 피드백을 저장하세요.</p>}
      <p role="status">선택 {chosen.length}개 · 긍정 {positive} · 부정 {chosen.length - positive} · 승인 {candidateIds.length}</p>
      <p>표현군 분포: {Object.entries(families).map(([name, count]) => `${name} ${count}`).join(' · ') || '선택 없음'}</p>
      <p>부정 사유 분포: {reasons.map(([name, count]) => `${name} ${count}`).join(' · ') || '없음'}</p>
      <details><summary>선별 비율과 중복 제한</summary><div className="lab-grid">
        <TextField label="표현군별 최대 건수" type="number" min={1} max={10} value={policy.maxPerFamily} onChange={e => setPolicy({ ...policy, maxPerFamily: Number(e.target.value) })} />
        <TextField label="표현군·사유별 최대 건수" type="number" min={1} max={3} value={policy.maxPerFamilyError} onChange={e => setPolicy({ ...policy, maxPerFamilyError: Number(e.target.value) })} />
        <TextField label="표현군별 최대 비중 (0.05–1)" type="number" min={0.05} max={1} step={0.05} value={policy.maxFamilyShare} onChange={e => setPolicy({ ...policy, maxFamilyShare: Number(e.target.value) })} />
        <TextField label="긍정 피드백 최소 비중 (0.1–1)" type="number" min={0.1} max={1} step={0.1} value={policy.minPositiveShare} onChange={e => setPolicy({ ...policy, minPositiveShare: Number(e.target.value) })} />
      </div></details>
      <div className="lab-actions"><Button disabled={!scopeSelected || !validSelection || !selected.length || approve.isPending} onClick={() => approve.mutate()}>선택한 피드백 일괄 승인</Button>
        <Button disabled={!scopeSelected || !validSelection || !selected.length || candidateIds.length !== selected.length || release.isPending || approve.isPending} onClick={() => release.mutate('train')}>승인된 preference JSONL 다운로드</Button></div>
      <p className="lab-meta">학습 파일: prompt · completion · label. 정답·점수·BERTScore·오류 분류·사용자 정보는 별도 이력 파일에만 보존합니다.</p>
      <details><summary>평가 전용 파일</summary><div className="lab-actions">{(['validation', 'test'] as const).map(kind => <Button key={kind} variant="secondary" disabled={!scopeSelected || release.isPending} onClick={() => release.mutate(kind)}>{kind} 평가 전용 JSONL 다운로드</Button>)}</div></details>
      <details><summary>데이터 생성 이력 ({data.exports.length})</summary>{data.exports.map(file => <p key={file.id}>{file.createdAt} · {file.kind} · {String(file.manifest.version ?? '과거 기록')} <Button size="small" variant="secondary" disabled={download.isPending} onClick={() => download.mutate(file.id)}>보존된 파일 다운로드</Button></p>)}</details>
      {data.candidates.some(c => c.body.version === 'human-curation-v1') && <details><summary>과거 SFT 후보 이력</summary><pre>{JSON.stringify(data.candidates.filter(c => c.body.version === 'human-curation-v1'), null, 2)}</pre></details>}
    </>}
  </section>;
}
