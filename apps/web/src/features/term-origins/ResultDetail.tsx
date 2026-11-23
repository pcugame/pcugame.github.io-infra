import type { LabResult } from '@pcu/contracts';
import { controversyLabel, resultLabels } from './labels';

function failureMessage(error: string) {
  switch (error) {
    case 'SEARCH_ENGINES_UNAVAILABLE': return '일부 검색 엔진이 응답하지 않았고 사용할 검색 결과가 없습니다.';
    case 'SEARCH_PROVIDER_UNREACHABLE': return '검색 서버에 연결할 수 없습니다. 검색 없이 평가하려면 검색 모드를 변경하세요.';
    case 'SEARCH_NOT_CONFIGURED': return '검색 서버 주소가 설정되지 않았습니다.';
    case 'MODEL_SYSTEM_PROMPT_UNSUPPORTED': return '시스템 지시를 지원하는 모델 서버가 필요합니다.';
    default: return error.startsWith('SEARCH_') ? `검색 요청 실패 (${error})` : error;
  }
}

export function ResultDetail({ item }: { item: LabResult }) {
  const out = item.output;
  const sources = item.sources.filter(source => out?.sourceIds.includes(source.id));
  const attempt = item.history.at(-1);
  const supplied = attempt && typeof attempt === 'object' && 'suppliedSourceIds' in attempt ? attempt.suppliedSourceIds : undefined;
  const usableCount = Array.isArray(supplied) ? supplied.length : item.sources.length;
  return <div className="lab-detail">
    {out && <dl>
      <dt>논란 가능성</dt><dd><strong>{controversyLabel(item)}</strong></dd>
      <dt>판정 이유</dt><dd>{out.controversyReason}</dd>
      <dt>인용한 발췌문</dt><dd>{sources.length ? <ul>{sources.map(source => <li key={source.id}>
        {/^https?:\/\//i.test(source.url) && <a href={source.url} target="_blank" rel="noopener noreferrer">{source.id} · {source.title}</a>}
        <span>{source.suppliedSnippet ?? source.snippet}</span><small>{source.collectedAt}</small>
      </li>)}</ul> : usableCount ? '모델이 검색 출처를 인용하지 않았습니다.' : item.searchCount ? '사용할 검색 발췌문 0건' : '검색 없이 평가함'}</dd>
      <dt>논란의 배경</dt><dd>{out.controversySummary}</dd>
      <dt>어원과 기원</dt><dd>{out.originSummary}</dd>
      <dt>최초 용례</dt><dd>{out.earliestAttestation ?? '미확인'}</dd>
      <dt>어원 신뢰도</dt><dd>{Math.round(out.originConfidence * 100)}%</dd>
      <dt>불확실성</dt><dd>{out.uncertainties.join(' / ') || '기재 없음'}</dd>
    </dl>}
    {item.error && <p role="status">{failureMessage(item.error)}</p>}
    <details className="lab-metadata"><summary>케이스와 처리 기록</summary><dl>
      <dt>케이스 ID</dt><dd>{item.caseId}</dd>
      {'context' in item.testCase && <><dt>문맥</dt><dd>{item.testCase.language} · {item.testCase.category} · {item.testCase.context}</dd></>}
      <dt>처리 결과</dt><dd>{resultLabels[item.status]}</dd>
      <dt>JSON 검증</dt><dd>{item.jsonValid ? '통과' : item.status === 'FAILED' ? '유효한 결과 없음' : '미검증'}</dd>
      <dt>응답 시간</dt><dd>{item.durationMs === null ? '—' : `${item.durationMs.toLocaleString()} ms`}</dd>
      <dt>검색 / 시도</dt><dd>검색 {item.searchCount}회 · 실행 {item.attempts}회</dd>
      <dt>도구 호출</dt><dd>지원 {({ supported: '확인', unsupported: '미지원', unknown: '미확인' })[item.toolSupport]} · 성공 {item.toolSucceeded ? '확인' : '기록 없음'}</dd>
      {out?.abstained && out.controversyScore !== null && <><dt>유보 응답의 원점수</dt><dd>{out.controversyScore}점 · 평균에서 제외</dd></>}
    </dl></details>
  </div>;
}
