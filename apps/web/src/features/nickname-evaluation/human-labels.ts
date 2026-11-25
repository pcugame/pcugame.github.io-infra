import type { LabReviewBody } from '@pcu/contracts';
export const verdictLabels: Record<LabReviewBody['verdict'], string> = { correct: '정답', partial: '부분 정답', incorrect: '오답', deferred: '평가 보류' };
export const errorLabels: Record<LabReviewBody['errors'][number], string> = {
  interpretation: '난독화·표현 해석 실패', search_decision: '검색 필요성 판단 실패', search_query: '부적절한 검색 질의',
  retrieval_failure: '검색 엔진·자료 수집 실패', evidence_interpretation: '근거 해석 오류', unsupported_guess: '근거 없는 추측',
  score: '부적절한 점수', false_positive: '과도한 위험 판단·오탐', unnecessary_abstention: '충분한 근거에도 판단 유보',
  citation: '잘못된 출처 인용', protocol: 'JSON·프로토콜 위반', reference: '기대 정답 자체의 문제',
};
export const causeLabels: Record<LabReviewBody['cause'], string> = { none: '문제 없음', search: '검색', prompt: '프롬프트', policy: '평가 정책',
  model: '모델 능력', infrastructure: '서비스·네트워크·Worker 장애', reference: '기대 정답', unknown: '미분류' };
export const cohortLabels = { normal: '정상 닉네임', problematic: '문제 닉네임', ambiguous: '모호한 닉네임' };
export const objectiveLabels = { A: 'A · 표현 해석·검색 행동', B: 'B · 동일 자료의 근거 판단', C: 'C · JSON 응답 구조' };

export const behaviorLabels = { positive: '긍정', negative: '부정', exclude: '학습 제외' } as const;
export const behaviorReasonLabels = {
  fabricated_fact: '근거 없는 사실 생성', contradicts_material: '제공 자료와 모순되는 주장',
  source_distortion: '출처 왜곡', excessive_risk: '과도한 위험 판단',
  topic_or_person_bias: '주제 또는 인물 자체에 대한 부당한 위험 판단', unverified_assertion: '미검증 가설의 단정',
  uncertainty_mishandling: '부적절한 불확실성 처리', model_contract_violation: '모델에 귀속되는 출력 계약 위반',
} as const;
