import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LabCurationPolicySchema, type LabCandidate, type LabCurationExport, type LabCurationExportRequest } from '@pcu/contracts';
import { Button, TextField } from '../../components/ui';
import { labApi } from '../../lib/api/lab';
import { useViewerKey } from '../../lib/query/visibility';
import { LabError } from './common';
import { CandidateCard } from './HumanReview';
import { errorLabels, cohortLabels } from './human-labels';

function downloadFiles(file: LabCurationExport) {
  for (const item of file.files) {
    const url = URL.createObjectURL(new Blob([item.content], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = item.filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
export function CurationPanel({ runId, completedAt }: { runId: string; completedAt: string | null }) {
  const viewerKey = useViewerKey();
  const client = useQueryClient();
  const [threshold, setThreshold] = useState(50);
  const [selected, setSelected] = useState<string[]>([]);
  const [approved, setApproved] = useState(false);
  const [policy, setPolicy] = useState(LabCurationPolicySchema.parse({}));
  const overview = useQuery({ queryKey: viewerKey(['lab-curation', runId, completedAt, threshold]), queryFn: () => labApi.curation(runId, threshold) });
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ['lab-curation', runId] }), client.invalidateQueries({ queryKey: ['lab-review', runId] })]);
  const release = useMutation({ mutationFn: (kind: LabCurationExportRequest['kind']) => labApi.createCurationExport(runId,
    { kind, candidateIds: kind === 'train' ? selected : [], policy, approved: true }),
    onSuccess: async file => { downloadFiles(file); setApproved(false); await refresh(); } });
  const download = useMutation({ mutationFn: (id: string) => labApi.curationExport(runId, id), onSuccess: downloadFiles });
  const data = overview.data;
  const groups = new Map<string, LabCandidate[]>();
  for (const candidate of data?.candidates ?? []) {
    const key = `${candidate.body.familyId} · ${candidate.body.errors.map(e => errorLabels[e]).sort().join(', ') || '정답 유지'}`;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  return <section className="lab-panel"><h2>Human Evaluation · 대표 학습 사례 선별</h2>
    <LabError error={overview.error || release.error || download.error} />
    {data && <>
      <p>전체 {data.metrics.total} · 최신 검수 {data.metrics.reviewed} · 재검수 필요 {data.metrics.staleReviews} · 실패 {data.metrics.failed} · 취소 {data.metrics.cancelled} · 미완료 {data.metrics.pending} · 실행 장애 {data.metrics.infrastructure} · 사례 유형 미분류 {data.metrics.unknownCohort}</p>
      <TextField label="위험 판정 임계점 (이상)" type="number" min={0} max={100} value={threshold} onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 0 && n <= 100) setThreshold(n); }} />
      <p className="lab-meta">미평가·유보·실패는 전체 건수에 남습니다. MAE·시간은 측정값이 있는 사례만 분모로 사용하며 누락 건수를 표시합니다. 오탐·미탐률은 사람이 분류한 사례 기준이므로 대상 미채점률과 함께 확인합니다. 출처 지표의 분모는 인용 ID 수입니다.</p>
      <div className="lab-metrics"><table><thead><tr><th>지표</th><th>값</th><th>분자 / 분모</th><th>미측정</th></tr></thead>
        <tbody>{data.metrics.metrics.map(metric => <tr key={metric.key}><th>{metric.label}</th><td>{metric.value === null ? '—' : metric.unit === 'rate' ? `${(metric.value * 100).toFixed(1)}%` : `${metric.value.toFixed(1)}${metric.unit === 'ms' ? ' ms' : ''}`}</td><td>{metric.numerator.toFixed(Number.isInteger(metric.numerator) ? 0 : 1)} / {metric.denominator}</td><td>{metric.missing}</td></tr>)}</tbody></table></div>
      <details><summary>대표 사례 선택 ({selected.length}개 선택 · 후보 {data.candidates.length}개)</summary>
        <p>표현군과 오류 유형으로 묶인 후보 중 대표 사례만 선택합니다. 정상·모호 사례와 근거에 충실한 정답을 함께 포함하세요. 후보 생성과 학습 승인은 별도 단계입니다.</p>
        {[...groups].map(([group, candidates]) => <fieldset key={group}><legend>{group}</legend>{candidates.map(candidate => <div key={candidate.id}>
          <label><input type="checkbox" disabled={candidate.status !== 'approved' || candidate.stale} checked={selected.includes(candidate.id)}
            onChange={e => setSelected(ids => e.target.checked ? [...ids, candidate.id] : ids.filter(id => id !== candidate.id))} />{candidate.caseId} · {cohortLabels[candidate.body.cohort]} · {candidate.body.retention ? '정답 보존' : '교정'} · {candidate.body.objective}</label>
          <CandidateCard runId={runId} candidate={candidate} refresh={refresh} />
        </div>)}</fieldset>)}
        {!groups.size && <p>검수를 저장하고 학습 후보를 생성하면 여기에서 선별할 수 있습니다.</p>}
      </details>
      <div className="lab-grid">
        <TextField label="표현군별 최대 건수" type="number" min={1} max={10} value={policy.maxPerFamily} onChange={e => setPolicy({ ...policy, maxPerFamily: Number(e.target.value) })} />
        <TextField label="표현군·오류별 최대 건수" type="number" min={1} max={3} value={policy.maxPerFamilyError} onChange={e => setPolicy({ ...policy, maxPerFamilyError: Number(e.target.value) })} />
        <TextField label="표현군별 최대 비중 (0.05–1)" type="number" min={0.05} max={1} step={0.05} value={policy.maxFamilyShare} onChange={e => setPolicy({ ...policy, maxFamilyShare: Number(e.target.value) })} />
        <TextField label="정답 보존 최소 비중 (0.1–1)" type="number" min={0.1} max={1} step={0.1} value={policy.minRetentionShare} onChange={e => setPolicy({ ...policy, minRetentionShare: Number(e.target.value) })} />
        <TextField label="정상 닉네임 정답 최소 비중 (0–1)" type="number" min={0} max={1} step={0.1} value={policy.minNormalShare} onChange={e => setPolicy({ ...policy, minNormalShare: Number(e.target.value) })} />
        <TextField label="모호 닉네임 정답 최소 비중 (0–1)" type="number" min={0} max={1} step={0.1} value={policy.minAmbiguousShare} onChange={e => setPolicy({ ...policy, minAmbiguousShare: Number(e.target.value) })} />
      </div>
      <label><input type="checkbox" checked={approved} onChange={e => setApproved(e.target.checked)} />선별 내용·비율을 확인했으며, 선택한 종류의 새 데이터 파일 생성을 승인합니다.</label>
      <div className="lab-actions">{(['train', 'validation', 'test'] as const).map(kind => <Button key={kind} disabled={!approved || release.isPending || (kind === 'train' && !selected.length)} onClick={() => release.mutate(kind)}>{kind === 'train' ? '승인한 학습' : kind === 'test' ? '최종 test 평가 전용' : 'validation 평가 전용'} JSONL 생성</Button>)}</div>
      <p className="lab-meta">train 파일에는 학습 메시지만 포함됩니다. 별도 이력 파일에 원본·검수·교정·승인자·해시를 보존합니다. test 파일은 학습·교정·반복 튜닝에 사용하지 않습니다.</p>
      <details><summary>데이터 생성 이력 ({data.exports.length})</summary>{data.exports.map(file => <p key={file.id}>{file.createdAt} · {file.kind} · 승인자 {file.actorId} <Button size="small" variant="secondary" disabled={download.isPending} onClick={() => download.mutate(file.id)}>보존된 파일 다운로드</Button></p>)}</details>
    </>}
  </section>;
}
