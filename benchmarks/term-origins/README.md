# 닉네임 기반 사회적 위험 표현 벤치마크

현재 기준 자료는 [한국 웹 표현 DB](expressions/README.md)와 [연결된 닉네임 평가셋](curated/README.md)이다. 첫 조사에서 의미군 후보 111개를 검토하여 71개를 채택하고 36개를 보류하고 4개를 제외하였다. 표현 전체를 닉네임으로 자동 변환하지 않는다.

- [유형·검토 상태별 표현 탐색](expressions/index.md): 표기·의미 근거와 보류 이유
- [사례별 해석과 채택 이유](curated/cases.md): 현재 22건의 검토 목록
- [수작업 원자료](curated/cases.json): 지칭 대상, 단서, 해석 근거, 다른 독법, 출처
- [모델 입력](curated/nicknames.jsonl): 정답 정보를 제외한 `id`와 `nickname`
- [검증기](curated/build.mjs): 개별 행과 원자료·생성 파일의 일치 검증

## 현재 자료 검증

저장소 루트에서 실행한다.

```sh
npm run build -w @pcu/contracts
node benchmarks/term-origins/curated/build.mjs
node --test benchmarks/term-origins/expressions/validate.test.mjs
```

원자료 수정 후에는 검증기에 `--write`를 지정하여 탐색 문서·집계·모델 입력·사례 목록을 재생성한다. 검증기는 정해진 건수를 요구하지 않는다. 미확인 제보는 확정 평가 입력에서 제외한다. 개별 입력 행의 스키마 검증과 웹 업로드 검증은 다르며, 현재 Lab 웹 업로드에는 500행 고정 조건이 남아 있다. 새 평가셋의 실제 모델 성능은 미측정이다.

## 이전 500건 판본

이전 입력, 라벨, 실행 결과는 당시 실험을 재현하는 자료로 보존한다. 새 초안의 사례 수나 해석 기준에 합산하지 않는다.

| 판본 | 입력·라벨 | 설명·검증 |
| --- | --- | --- |
| 표기 변형 중심 500건 | [입력](benchmark-500.jsonl) · [라벨](benchmark-500.labels.jsonl) | [분포 보고서](distribution.html) · [원자료](cases) · [검증기](benchmark.mjs) |
| 전시 검토 점수 500건 | [입력](exhibition/candidate.jsonl) · [라벨](exhibition/candidate.labels.jsonl) | [정책·채점·대표 실행](exhibition/evaluation.md) · [검증기](exhibition/review.mjs) |
