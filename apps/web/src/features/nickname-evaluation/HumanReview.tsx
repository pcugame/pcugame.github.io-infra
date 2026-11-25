import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { labDefaultReview, labInfrastructureFailure, LabReviewBodySchema,
  type LabResult, type LabReviewBody, type LabReviewBundle } from '@pcu/contracts';
import { Button, SelectField } from '../../components/ui';
import { labApi } from '../../lib/api/lab';
import { useViewerKey } from '../../lib/query/visibility';
import { ResultDetail } from './ResultDetail';
import { LabError } from './common';
import { causeLabels, cohortLabels, verdictLabels, behaviorLabels, behaviorReasonLabels } from './human-labels';

function BooleanRating({ label, value, change }: { label: string; value: boolean | null; change: (value: boolean | null) => void }) {
  return <SelectField label={label} value={value === null ? '' : String(value)} onChange={e => change(e.target.value === '' ? null : e.target.value === 'true')}>
    <option value="">미평가</option><option value="true">적합·성공</option><option value="false">부적합·실패</option>
  </SelectField>;
}
export function HumanReview({ runId, item, next, previous, onDirtyChange }: { runId: string; item: LabResult; next?: () => void; previous?: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const viewerKey = useViewerKey();
  const bundle = useQuery({ queryKey: viewerKey(['lab-review', runId, item.caseId, item.attempts, item.status]), queryFn: () => labApi.review(runId, item.caseId) });
  return <section className="lab-review" aria-label="사람 검수">
    <LabError error={bundle.error} />
    {bundle.data ? <ReviewEditor key={item.caseId + bundle.data.resultHash} runId={runId} item={item} bundle={bundle.data} next={next} previous={previous} onDirtyChange={onDirtyChange} /> : <p>검수 이력을 불러오는 중…</p>}
  </section>;
}
function ReviewEditor({ runId, item, bundle, next, previous, onDirtyChange }: { runId: string; item: LabResult; bundle: LabReviewBundle; next?: () => void; previous?: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const client = useQueryClient();
  const latest = bundle.reviews[0];
  const [body, setBody] = useState<LabReviewBody>(() => {
    const saved = latest?.resultHash === bundle.resultHash ? latest.body : labDefaultReview(item);
    return { ...saved, feedbackVersion: 'preference-v1', behavior: saved.behavior ?? 'exclude', behaviorReasons: saved.behaviorReasons ?? [],
      correction: {}, correctedAction: null, reusedReference: false };
  });
  const [referenceShown, setReferenceShown] = useState(!!latest && latest.resultHash === bundle.resultHash && !latest.body.blind);
  const [dirty, setDirty] = useState(false);
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ['lab-review', runId, item.caseId] }), client.invalidateQueries({ queryKey: ['lab-curation', runId] })]);
  function markDirty(value: boolean) { setDirty(value); onDirtyChange?.(value); }
  function update(patch: Partial<LabReviewBody>) { setBody(value => ({ ...value, ...patch })); markDirty(true); }
  function behavior(value: NonNullable<LabReviewBody['behavior']>) { update({ behavior: value, behaviorReasons: value === 'negative' ? body.behaviorReasons : [] }); }
  const save = useMutation({ mutationFn: () => labApi.saveReview(runId, item.caseId, {
    previousReviewId: latest?.id ?? null, resultHash: bundle.resultHash,
    body: LabReviewBodySchema.parse({ ...body, blind: !referenceShown }),
  }), onSuccess: async review => { setBody(review.body); markDirty(false); await refresh(); } });
  const terminal = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(item.status);
  async function saveNext() { try { await save.mutateAsync(); next?.(); } catch { /* Visible mutation error. */ } }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (save.isPending || e.repeat) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && terminal) { e.preventDefault(); void saveNext(); return; }
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest('input, textarea, select') || target?.isContentEditable || e.ctrlKey || e.metaKey || e.altKey) return;
      const value = (['correct', 'partial', 'incorrect', 'deferred'] as const)[Number(e.key) - 1];
      if (value) { e.preventDefault(); update({ verdict: value }); }
      const feedback = ({ a: 'positive', s: 'negative', d: 'exclude' } as const)[e.key as 'a' | 's' | 'd'];
      if (feedback) { e.preventDefault(); behavior(feedback); }
      if (!dirty && e.key === 'j') next?.();
      if (!dirty && e.key === 'k') previous?.();
    };
    const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('keydown', onKey); window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', warn); };
  });
  return <>
    <div className="lab-review-toolbar">
      <strong>{item.caseId} · {item.testCase.nickname}</strong>
      <div className="lab-actions"><Button variant="secondary" disabled={!previous || dirty || save.isPending} onClick={previous}>이전 (K)</Button>
        <Button variant="secondary" disabled={!next || dirty || save.isPending} onClick={next}>다음 (J)</Button>
        <Button disabled={!terminal || save.isPending} onClick={() => void saveNext()}>저장 후 다음 (Ctrl+Enter)</Button></div>
      <small>1–4 정답 여부 · A 긍정 · S 부정 · D 학습 제외 · Tab·Space 사유 선택</small>
    </div>
    <div className="lab-grid lab-review-columns">
      <section><h3>모델 응답과 근거</h3><ResultDetail item={item} showReference={referenceShown} compact />
        {!referenceShown && <Button variant="secondary" onClick={() => { setReferenceShown(true); markDirty(true); }}>기대 정답 공개</Button>}
      </section>
      <section className="lab-form" inert={save.isPending}>
        <h3>벤치마크 정답 여부</h3>
        <div className="lab-actions">{Object.entries(verdictLabels).map(([key, label], i) => <Button key={key} variant={body.verdict === key ? 'primary' : 'secondary'} aria-pressed={body.verdict === key} onClick={() => update({ verdict: key as LabReviewBody['verdict'] })}>{i + 1} {label}</Button>)}</div>
        <h3>모델 행동 피드백</h3>
        <p>정답 여부와 독립적으로 선택합니다. 지식 부족·난독화 실패·점수 차이만 있으면 학습 제외로 유지하세요.</p>
        <div className="lab-actions">{Object.entries(behaviorLabels).map(([key, label], i) => <Button key={key} variant={body.behavior === key ? 'primary' : 'secondary'} aria-pressed={body.behavior === key} onClick={() => behavior(key as NonNullable<LabReviewBody['behavior']>)}>{['A', 'S', 'D'][i]} {label}</Button>)}</div>
        {body.behavior === 'negative' && <fieldset><legend>부정 피드백 사유 (복수 선택)</legend><div className="lab-error-types">{Object.entries(behaviorReasonLabels).map(([key, label]) => <label key={key}>
          <input type="checkbox" checked={body.behaviorReasons?.includes(key as NonNullable<LabReviewBody['behaviorReasons']>[number]) ?? false} onChange={e => update({ behaviorReasons: e.target.checked ? [...body.behaviorReasons ?? [], key as NonNullable<LabReviewBody['behaviorReasons']>[number]] : body.behaviorReasons?.filter(v => v !== key) })} />{label}</label>)}</div></fieldset>}
        {labInfrastructureFailure(item) && <p role="status">실행 장애가 기록되어 있어 학습 파일에서 제외됩니다.</p>}
        <details><summary>선택 사항 · 메모와 상세 평가</summary>
          <p>검수 {latest ? `${latest.revision}차 · ${verdictLabels[latest.body.verdict]}` : '미평가'} · 분할 {bundle.effectiveSplit ?? '표현군 미지정'}</p>
          {bundle.splitError && <p role="alert">{bundle.splitError}</p>}
          <label>검수 메모<textarea rows={3} maxLength={4000} value={body.notes} onChange={e => update({ notes: e.target.value })} /></label>
          <SelectField label="문제 영역 (통계용)" value={body.cause} onChange={e => update({ cause: e.target.value as LabReviewBody['cause'] })}>{Object.entries(causeLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</SelectField>
          <SelectField label="사례 유형" value={body.cohort ?? ''} onChange={e => update({ cohort: (e.target.value || null) as LabReviewBody['cohort'] })}><option value="">미분류</option>{Object.entries(cohortLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</SelectField>
          <BooleanRating label="판단 근거 적합성" value={body.rationaleFit} change={value => update({ rationaleFit: value })} />
          <BooleanRating label="해석·난독화 복원" value={body.interpretationSuccess} change={value => update({ interpretationSuccess: value })} />
          {(item.output?.sourceIds ?? []).map(sourceId => {
            const check = body.sourceChecks.find(c => c.sourceId === sourceId) ?? { sourceId, relevant: null, supports: null };
            const change = (patch: Partial<typeof check>) => update({ sourceChecks: [...body.sourceChecks.filter(c => c.sourceId !== sourceId), { ...check, ...patch }] });
            return <div key={sourceId}><BooleanRating label={`${sourceId} 실제 관련성`} value={check.relevant} change={value => change({ relevant: value })} /><BooleanRating label={`${sourceId} 주장 지지`} value={check.supports} change={value => change({ supports: value })} /></div>;
          })}
        </details>
        <Button disabled={!terminal || save.isPending} onClick={() => save.mutate()}>검수 저장{dirty ? ' · 변경 있음' : ''}</Button>
        <LabError error={save.error} />
        {save.isSuccess && !dirty && <p role="status">검수를 저장했습니다.</p>}
        <p className="lab-meta">저장한 행동 피드백은 아래에서 일괄 검토·승인할 수 있습니다.</p>
        <details><summary>검수 변경 이력 ({bundle.reviews.length})</summary><pre>{JSON.stringify({ reviews: bundle.reviews, historicalCandidates: bundle.candidates.filter(c => c.body.version === 'human-curation-v1') }, null, 2)}</pre></details>
      </section>
    </div>
  </>;
}
