import { labLastAttempt, type LabResult } from '@pcu/contracts';
import { z } from 'zod';
import { resultLabels } from './labels';

export function ResultDetail({ item, showReference = true }: { item: LabResult; showReference?: boolean }) {
  const out = item.output;
  const sources = item.sources;
  const research = item.history.flatMap(entry => {
    const parsed = z.object({ research: z.object({
      limitations: z.array(z.string()), inputTokens: z.number(), outputTokens: z.number(),
      steps: z.array(z.object({ kind: z.string(), query: z.string().optional(),
        durationMs: z.number(), inputTokens: z.number().optional(), outputTokens: z.number().nullable().optional(),
        action: z.object({ action: z.string(), hypotheses: z.array(z.object({ term: z.string(), basis: z.string() })) }).passthrough().optional(),
        error: z.string().optional(),
      }).passthrough()),
    }).passthrough() }).safeParse(entry);
    return parsed.success ? [parsed.data.research] : [];
  });
  return <div className="lab-detail">
    <p>{item.testCase.nickname}</p>
    <p className="lab-meta">{item.testCase.id}</p>
    <dl>
      <dt>처리 결과</dt><dd>{resultLabels[item.status]}{item.error && ` · ${item.error}`}</dd>
      <dt>JSON 검증</dt><dd>{item.jsonValid ? '통과' : item.status === 'FAILED' ? '유효한 결과 없음' : '미검증'}</dd>
      <dt>응답 시간</dt><dd>{item.durationMs === null ? '—' : `${item.durationMs.toLocaleString()} ms`}</dd>
      <dt>검색 / 시도</dt><dd>검색 {item.searchCount}회 · 실행 {item.attempts}회</dd>
      <dt>모델 네이티브 도구 호출</dt><dd>지원 {({ supported: '확인', unsupported: '미지원', unknown: '미확인' })[item.toolSupport]} · 조사 도구 성공 {item.toolSucceeded ? '확인' : '기록 없음'}</dd>
      {out && <>
        <dt>해석한 표현</dt><dd>{out.interpretedTerm ?? '특정하지 않음'}</dd>
        <dt>판단 근거</dt><dd>{out.reason}</dd>
        <dt>위험 점수</dt><dd>{out.score === null ? '판단 보류' : `${out.score} / 100`}{out.abstained && ' · 답변 유보'}</dd>
        <dt>판단 신뢰도</dt><dd>{Math.round(out.confidence * 100)}%</dd>
      </>}
      {showReference && <>
      <dt>사람의 기대 근거 (검토 가설)</dt><dd>{item.testCase.reference.expectedReason}</dd>
      <dt>기대 점수 / 범위</dt><dd>{item.testCase.reference.expectedScore} / {item.testCase.reference.scoreRange?.join('–') ?? '미지정'}</dd>
      <dt>실제 − 기대 점수</dt><dd>{out?.score == null ? '채점 불가' : `${out.score - item.testCase.reference.expectedScore}점 (절대 오차 ${Math.abs(out.score - item.testCase.reference.expectedScore)})`}</dd>
      </>}
      <dt>split / family</dt><dd>{item.testCase.split ?? '미지정'} / {item.testCase.familyId ?? '미지정'}</dd>
      <>
        <dt>검색 결과·출처</dt><dd>{sources.length === 0 ? '수집한 출처 없음' : <ul>{sources.map(source => <li key={source.id}>
          {/^https?:\/\//i.test(source.url) && <a href={source.url} target="_blank" rel="noopener noreferrer">{source.id} · {source.title}</a>}
          <small>{out?.sourceIds.includes(source.id) ? '모델 인용 · ' : '미인용 · '}{source.collectedAt} · 검색 발췌문 · 원문 미검증</small><span>{source.snippet}</span>
        </li>)}</ul>}</dd>
      </>
    </dl>
    <details><summary>원본 응답·전체 실행 이력</summary><pre>{JSON.stringify({ output: item.output, history: item.history }, null, 2)}</pre></details>
    {labLastAttempt(item)?.searchSteps?.map((step, i) => <p key={i}>검색: {step.query} · {step.durationMs} ms{step.error && ` · ${step.error}`}</p>)}
    {research.map((trace, i) => <section key={i}>
      <h3>모델 조사 기록</h3>
      <p>입력 {trace.inputTokens} · 출력 {trace.outputTokens}토큰 · 검색 발췌문만 사용, 원문 미검증</p>
      <ol>{trace.steps.map((step, n) => <li key={n}>
        <strong>{step.kind === 'search' ? `검색: ${step.query}` : step.kind === 'action' ? `조사 결정: ${step.action?.action ?? '실패'}` : '최종 판단'}</strong>
        <span> · {step.durationMs} ms{step.inputTokens !== undefined && ` · 입력 ${step.inputTokens} / 출력 ${step.outputTokens ?? '미확인'}토큰`}</span>
        {step.error && <p>{step.error}</p>}
        {step.action?.hypotheses.map((h, k) => <p key={k}>해석 가설: {h.term} · {h.basis}</p>)}
      </li>)}</ol>
      <details><summary>제공 자료·생성 설정·단계별 JSON</summary><pre>{JSON.stringify(trace, null, 2)}</pre></details>
    </section>)}
  </div>;
}
