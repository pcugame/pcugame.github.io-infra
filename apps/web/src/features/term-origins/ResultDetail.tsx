import type { LabResult } from '@pcu/contracts';
import { resultLabels } from './labels';

export function ResultDetail({ item }: { item: LabResult }) {
  const out = item.output;
  const sources = item.sources.filter(source => out?.sourceIds.includes(source.id));
  return <div className="lab-detail">
    <p>{'nickname' in item.testCase ? item.testCase.nickname : item.testCase.context}</p>
    <p className="lab-meta">{item.testCase.id}{'category' in item.testCase && ` · ${item.testCase.language} · ${item.testCase.category}`}</p>
    <dl>
      <dt>처리 결과</dt><dd>{resultLabels[item.status]}{item.error && ` · ${item.error}`}</dd>
      <dt>JSON 검증</dt><dd>{item.jsonValid ? '통과' : item.status === 'FAILED' ? '유효한 결과 없음' : '미검증'}</dd>
      <dt>응답 시간</dt><dd>{item.durationMs === null ? '—' : `${item.durationMs.toLocaleString()} ms`}</dd>
      <dt>검색 / 시도</dt><dd>검색 {item.searchCount}회 · 실행 {item.attempts}회</dd>
      <dt>도구 호출</dt><dd>지원 {({ supported: '확인', unsupported: '미지원', unknown: '미확인' })[item.toolSupport]} · 성공 {item.toolSucceeded ? '확인' : '기록 없음'}</dd>
      {out && <>
        <dt>어원과 기원</dt><dd>{out.originSummary}</dd>
        <dt>최초 용례</dt><dd>{out.earliestAttestation ?? '미확인'}</dd>
        <dt>어원 신뢰도</dt><dd>{Math.round(out.originConfidence * 100)}%</dd>
        <dt>논란의 배경</dt><dd>{out.controversySummary}</dd>
        <dt>논란 가능성</dt><dd>{out.controversyScore === null ? '판단 보류' : `${out.controversyScore} / 100`} · {out.controversyReason}</dd>
        <dt>불확실성</dt><dd>{out.uncertainties.join(' / ') || '기재 없음'}{out.abstained && ' · 답변 유보'}</dd>
        <dt>참조 출처</dt><dd>{sources.length === 0 ? '인용된 출처 없음' : <ul>{sources.map(source => <li key={source.id}>
          {/^https?:\/\//i.test(source.url) && <a href={source.url} target="_blank" rel="noopener noreferrer">{source.id} · {source.title}</a>}
          <small>{source.collectedAt}</small><span>{source.snippet}</span>
        </li>)}</ul>}</dd>
      </>}
    </dl>
  </div>;
}
