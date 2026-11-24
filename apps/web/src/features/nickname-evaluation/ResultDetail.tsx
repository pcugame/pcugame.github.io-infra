import type { LabResult } from '@pcu/contracts';
import { resultLabels } from './labels';

export function ResultDetail({ item }: { item: LabResult }) {
  const out = item.output;
  const sources = item.sources.filter(source => out?.sourceIds.includes(source.id));
  return <div className="lab-detail">
    <p>{item.testCase.nickname}</p>
    <p className="lab-meta">{item.testCase.id}</p>
    <dl>
      <dt>처리 결과</dt><dd>{resultLabels[item.status]}{item.error && ` · ${item.error}`}</dd>
      <dt>JSON 검증</dt><dd>{item.jsonValid ? '통과' : item.status === 'FAILED' ? '유효한 결과 없음' : '미검증'}</dd>
      <dt>응답 시간</dt><dd>{item.durationMs === null ? '—' : `${item.durationMs.toLocaleString()} ms`}</dd>
      <dt>검색 / 시도</dt><dd>검색 {item.searchCount}회 · 실행 {item.attempts}회</dd>
      <dt>도구 호출</dt><dd>지원 {({ supported: '확인', unsupported: '미지원', unknown: '미확인' })[item.toolSupport]} · 성공 {item.toolSucceeded ? '확인' : '기록 없음'}</dd>
      {out && <>
        <dt>해석한 표현</dt><dd>{out.interpretedTerm ?? '특정하지 않음'}</dd>
        <dt>판단 근거</dt><dd>{out.reason}</dd>
        <dt>위험 점수</dt><dd>{out.score === null ? '판단 보류' : `${out.score} / 100`}{out.abstained && ' · 답변 유보'}</dd>
        <dt>판단 신뢰도</dt><dd>{Math.round(out.confidence * 100)}%</dd>
      </>}
      <dt>사람의 기대 근거 (검토 가설)</dt><dd>{item.testCase.reference.expectedReason}</dd>
      <dt>기대 점수 / 범위</dt><dd>{item.testCase.reference.expectedScore} / {item.testCase.reference.scoreRange?.join('–') ?? '미지정'}</dd>
      <dt>split / family</dt><dd>{item.testCase.split ?? '미지정'} / {item.testCase.familyId ?? '미지정'}</dd>
      {out && <>
        <dt>참조 출처</dt><dd>{sources.length === 0 ? '인용된 출처 없음' : <ul>{sources.map(source => <li key={source.id}>
          {/^https?:\/\//i.test(source.url) && <a href={source.url} target="_blank" rel="noopener noreferrer">{source.id} · {source.title}</a>}
          <small>{source.collectedAt}</small><span>{source.snippet}</span>
        </li>)}</ul>}</dd>
      </>}
    </dl>
  </div>;
}
