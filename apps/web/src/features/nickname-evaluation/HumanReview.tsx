import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { labDefaultReview, labInfrastructureFailure, labLastAttempt, LabReviewBodySchema,
  type LabResult, type LabReviewBody, type LabReviewBundle, type LabCandidate, type LabCreateCandidate } from '@pcu/contracts';
import { Button, SelectField, TextField } from '../../components/ui';
import { labApi } from '../../lib/api/lab';
import { useViewerKey } from '../../lib/query/visibility';
import { ResultDetail } from './ResultDetail';
import { LabError } from './common';
import { causeLabels, cohortLabels, errorLabels, objectiveLabels, verdictLabels } from './human-labels';

export function CandidateCard({ runId, candidate, refresh }: { runId: string; candidate: LabCandidate; refresh: () => Promise<unknown> }) {
  const [grounded, setGrounded] = useState(false);
  const [family, setFamily] = useState(false);
  const decision = useMutation({ mutationFn: (value: 'approved' | 'rejected') => labApi.decideCandidate(runId, candidate.id,
    { decision: value, contentHash: candidate.contentHash, grounded, familyVerified: family }), onSuccess: refresh });
  return <details className="lab-candidate"><summary>{objectiveLabels[candidate.body.objective]} · {candidate.body.familyId} · {candidate.stale ? '검수 변경됨' : ({ draft: '승인 대기', approved: '승인됨', rejected: '제외됨' })[candidate.status]}</summary>
    <p>{candidate.body.warnings.join(' ')}</p>
    <pre>{JSON.stringify(candidate.body.messages, null, 2)}</pre>
    <p>입력 출처: {candidate.body.suppliedSources.map(s => s.id).join(', ') || '없음'} · {candidate.body.contextOrigin}</p>
    <label><input type="checkbox" checked={grounded} onChange={e => setGrounded(e.target.checked)} />모델 입력 밖의 사실·URL을 정답으로 강요하지 않으며, 교정 내용의 근거를 확인했습니다.</label>
    <label><input type="checkbox" checked={family} onChange={e => setFamily(e.target.checked)} />동일 원형의 변형이 같은 familyId에 속하며 train 표현군임을 확인했습니다.</label>
    <div className="lab-actions">
      <Button disabled={!grounded || !family || candidate.stale || decision.isPending || candidate.status === 'approved'} onClick={() => decision.mutate('approved')}>이 후보를 학습용으로 승인</Button>
      <Button variant="secondary" disabled={decision.isPending || candidate.status === 'rejected'} onClick={() => decision.mutate('rejected')}>학습에서 제외</Button>
    </div><LabError error={decision.error} />
    <details><summary>생성·승인 이력</summary><pre>{JSON.stringify({ id: candidate.id, reviewId: candidate.reviewId, createdAt: candidate.createdAt, actorId: candidate.actorId, contentHash: candidate.contentHash, decisions: candidate.decisions }, null, 2)}</pre></details>
  </details>;
}
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
  const [body, setBody] = useState<LabReviewBody>(() => latest?.resultHash === bundle.resultHash ? latest.body : labDefaultReview(item));
  const [referenceShown, setReferenceShown] = useState(!!latest && latest.resultHash === bundle.resultHash && !latest.body.blind);
  const [dirty, setDirty] = useState(false);
  const [localError, setLocalError] = useState<Error | null>(null);
  const [stepIndex, setStepIndex] = useState('');
  const [actionEdited, setActionEdited] = useState(false);
  const [extraEdited, setExtraEdited] = useState(false);
  const [objective, setObjective] = useState<LabCreateCandidate['objective']>('A');
  const [actionText, setActionText] = useState(JSON.stringify(body.correctedAction ?? { action: 'search', query: '', hypotheses: [] }, null, 2));
  const [extraText, setExtraText] = useState(JSON.stringify({ evidenceChecks: body.correction.evidenceChecks ?? [], interpretationStatus: body.correction.interpretationStatus ?? 'literal' }, null, 2));
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ['lab-review', runId, item.caseId] }), client.invalidateQueries({ queryKey: ['lab-curation', runId] })]);
  function markDirty(value: boolean) { setDirty(value); onDirtyChange?.(value); }
  function update(patch: Partial<LabReviewBody>) { setBody(value => ({ ...value, ...patch })); markDirty(true); setLocalError(null); }
  function verdict(value: LabReviewBody['verdict']) {
    update({ verdict: value, ...(value === 'correct' ? { errors: [], cause: 'none' as const } : {}) });
  }
  const save = useMutation({ mutationFn: async () => {
    const parsed = LabReviewBodySchema.parse({ ...body, blind: !referenceShown,
      ...(actionEdited ? { correctedAction: JSON.parse(actionText) } : {}),
      ...(extraEdited ? { correction: { ...body.correction, ...JSON.parse(extraText) } } : {}) });
    return labApi.saveReview(runId, item.caseId, { previousReviewId: latest?.id ?? null, resultHash: bundle.resultHash, body: parsed });
  }, onSuccess: async review => { setBody(review.body); setActionEdited(false); setExtraEdited(false); markDirty(false); await refresh(); } });
  const candidate = useMutation({ mutationFn: () => labApi.candidate(runId, item.caseId, { reviewId: latest!.id, objective, ...(stepIndex ? { stepIndex: Number(stepIndex) } : {}) }), onSuccess: refresh });
  const terminal = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(item.status);
  async function saveNext() { try { await save.mutateAsync(); next?.(); } catch { /* Error remains visible beside the form. */ } }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (save.isPending) return;
      if (e.ctrlKey && e.key === 'Enter' && !save.isPending && terminal) { e.preventDefault(); void saveNext(); return; }
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest('input, textarea, select, button, a') || target?.isContentEditable || e.ctrlKey || e.metaKey || e.altKey) return;
      const value = (['correct', 'partial', 'incorrect', 'deferred'] as const)[Number(e.key) - 1];
      if (value) { e.preventDefault(); verdict(value); }
      if (!dirty && e.key === 'j') next?.();
      if (!dirty && e.key === 'k') previous?.();
    };
    const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('keydown', onKey); window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', warn); };
  });
  function correction(key: keyof LabReviewBody['correction'], value: unknown) { update({ correction: { ...body.correction, [key]: value } }); }
  return <>
    <div className="lab-review-toolbar">
      <strong>{item.caseId} · {item.testCase.nickname}</strong>
      <div className="lab-actions"><Button variant="secondary" disabled={!previous || dirty || save.isPending} onClick={previous}>이전 (K)</Button>
        <Button variant="secondary" disabled={!next || dirty || save.isPending} onClick={next}>다음 (J)</Button>
        <Button disabled={!terminal || save.isPending} onClick={() => void saveNext()}>저장 후 다음 (Ctrl+Enter)</Button></div>
      <small>1 정답 · 2 부분 정답 · 3 오답 · 4 평가 보류. 수정 내용은 저장한 뒤 이동합니다.</small>
    </div>
    <div className="lab-grid lab-review-columns">
      <section><h3>모델 응답과 근거</h3><ResultDetail item={item} showReference={referenceShown} />
        {!referenceShown && <Button variant="secondary" onClick={() => setReferenceShown(true)}>기대 정답 공개</Button>}
      </section>
      <section className="lab-form" inert={save.isPending}><h3>사람의 평가</h3>
        {labInfrastructureFailure(item) && <p role="status">실행 장애가 기록되어 있습니다. 모델 학습 후보 생성에서 제외됩니다.</p>}
        <p>검수 {latest ? `${latest.revision}차 · ${verdictLabels[latest.body.verdict]}` : '미평가'} · 분할 {bundle.effectiveSplit ?? '표현군 미지정'}</p>
        {bundle.splitError && <p role="alert">{bundle.splitError}</p>}
        <div className="lab-actions">{Object.entries(verdictLabels).map(([key, label], i) => <Button key={key} variant={body.verdict === key ? 'primary' : 'secondary'} aria-pressed={body.verdict === key} onClick={() => verdict(key as LabReviewBody['verdict'])}>{i + 1} {label}</Button>)}</div>
        <SelectField label="먼저 확인할 문제 영역" value={body.cause} onChange={e => update({ cause: e.target.value as LabReviewBody['cause'] })}>
          {Object.entries(causeLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </SelectField>
        <SelectField label="사례 유형" value={body.cohort ?? ''} onChange={e => update({ cohort: (e.target.value || null) as LabReviewBody['cohort'] })}>
          <option value="">미분류</option>
          {Object.entries(cohortLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </SelectField>
        <fieldset><legend>오류 유형 (복수 선택)</legend><div className="lab-error-types">{Object.entries(errorLabels).map(([key, label]) => <label key={key}>
          <input type="checkbox" checked={body.errors.includes(key as LabReviewBody['errors'][number])} onChange={e => update({ errors: e.target.checked ? [...body.errors, key as LabReviewBody['errors'][number]] : body.errors.filter(v => v !== key) })} />{label}</label>)}</div></fieldset>
        <div className="lab-grid"><BooleanRating label="판단 근거 적합성" value={body.rationaleFit} change={value => update({ rationaleFit: value })} />
          <BooleanRating label="해석·난독화 복원" value={body.interpretationSuccess} change={value => update({ interpretationSuccess: value })} /></div>
        {(item.output?.sourceIds ?? []).map(sourceId => {
          const check = body.sourceChecks.find(c => c.sourceId === sourceId) ?? { sourceId, relevant: null, supports: null };
          const change = (patch: Partial<typeof check>) => update({ sourceChecks: [...body.sourceChecks.filter(c => c.sourceId !== sourceId), { ...check, ...patch }] });
          return <div className="lab-grid" key={sourceId}><BooleanRating label={`${sourceId} 실제 관련성`} value={check.relevant} change={value => change({ relevant: value })} />
            <BooleanRating label={`${sourceId} 주장 지지`} value={check.supports} change={value => change({ supports: value })} /></div>;
        })}
        <label>검수 메모<textarea rows={3} maxLength={4000} value={body.notes} onChange={e => update({ notes: e.target.value })} /></label>
        <details><summary>필요한 부분만 교정</summary>
          <p>변경한 필드만 저장합니다. 기대 근거는 사람이 제공 자료와 대조한 후 승인할 초안입니다.</p>
          <Button variant="secondary" onClick={() => { setReferenceShown(true); update({ reusedReference: true, correction: { ...body.correction,
            reason: item.testCase.reference.expectedReason, score: item.testCase.reference.expectedScore, abstained: false } }); }}>기대 근거·점수로 교정 초안 채우기</Button>
          <label>교정 근거<textarea rows={5} value={body.correction.reason ?? item.output?.reason ?? ''} onChange={e => correction('reason', e.target.value)} /></label>
          <div className="lab-grid"><TextField label="교정 점수 (빈 값은 null)" type="number" min={0} max={100} value={body.correction.score !== undefined ? body.correction.score ?? '' : item.output?.score ?? ''} onChange={e => correction('score', e.target.value === '' ? null : Number(e.target.value))} />
            <TextField label="교정 해석 표현" value={body.correction.interpretedTerm !== undefined ? body.correction.interpretedTerm ?? '' : item.output?.interpretedTerm ?? ''} onChange={e => correction('interpretedTerm', e.target.value || null)} /></div>
          <label><input type="checkbox" checked={body.correction.abstained ?? item.output?.abstained ?? false} onChange={e => update({ correction: { ...body.correction, abstained: e.target.checked, ...(e.target.checked ? { score: null } : {}) } })} />교정 응답은 판단 유보</label>
          <TextField label="교정 신뢰도" type="number" min={0} max={1} step={0.1} value={body.correction.confidence ?? item.output?.confidence ?? 0} onChange={e => correction('confidence', Number(e.target.value))} />
          <TextField label="교정 출처 ID (쉼표 구분)" value={(body.correction.sourceIds ?? item.output?.sourceIds ?? []).join(',')} onChange={e => correction('sourceIds', e.target.value.split(',').map(s => s.trim()).filter(Boolean))} />
          <label>A 교정 action JSON<textarea rows={6} value={actionText} onChange={e => { setActionText(e.target.value); setActionEdited(true); markDirty(true); }} /></label>
          <Button variant="secondary" onClick={() => { try { update({ correctedAction: JSON.parse(actionText) }); } catch { setLocalError(new Error('action JSON을 확인하세요.')); } }}>교정 action 적용</Button>
          <label>B/C 인용문·해석 상태 JSON<textarea rows={6} value={extraText} onChange={e => { setExtraText(e.target.value); setExtraEdited(true); markDirty(true); }} /></label>
          <Button variant="secondary" onClick={() => { try { const value = JSON.parse(extraText); update({ correction: { ...body.correction, evidenceChecks: value.evidenceChecks, interpretationStatus: value.interpretationStatus } }); } catch { setLocalError(new Error('인용문 JSON을 확인하세요.')); } }}>인용문·해석 상태 적용</Button>
          <Button variant="secondary" onClick={() => { setActionEdited(false); setExtraEdited(false); update({ correction: {}, correctedAction: null, reusedReference: false }); }}>교정 초기화</Button>
        </details>
        <Button disabled={!terminal || save.isPending} onClick={() => save.mutate()}>검수 저장{dirty ? ' · 변경 있음' : ''}</Button>
        <LabError error={localError || save.error || candidate.error} />
        {save.isSuccess && !dirty && <p role="status">검수를 저장했습니다.</p>}
        <SelectField label="학습 목표" value={objective} onChange={e => { setObjective(e.target.value as LabCreateCandidate['objective']); setStepIndex(''); }}>
          {Object.entries(objectiveLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </SelectField>
        <SelectField label="교정할 생성 단계" value={stepIndex} onChange={e => setStepIndex(e.target.value)}>
          <option value="">{objective === 'A' ? '첫 action (기록 없으면 닉네임만 입력)' : '마지막 판단'}</option>
          {labLastAttempt(item)?.research?.steps.flatMap((step, index) => step.kind === (objective === 'A' ? 'action' : 'answer') ? [<option key={index} value={index}>{index + 1}번째 단계 · {step.kind}{step.action?.query ? ` · ${step.action.query}` : ''}</option>] : [])}
        </SelectField>
        <Button variant="secondary" disabled={dirty || !latest || latest.resultHash !== bundle.resultHash || bundle.effectiveSplit !== 'train' || candidate.isPending} onClick={() => candidate.mutate()}>검수 내용으로 후보 생성 (미승인)</Button>
        {bundle.effectiveSplit && bundle.effectiveSplit !== 'train' && <p>validation/test 표현군은 학습 후보 생성에서 제외됩니다.</p>}
        {bundle.candidates.map(c => <CandidateCard key={c.id} runId={runId} candidate={c} refresh={refresh} />)}
        <details><summary>검수 변경 이력 ({bundle.reviews.length})</summary><pre>{JSON.stringify(bundle.reviews, null, 2)}</pre></details>
      </section>
    </div>
  </>;
}
