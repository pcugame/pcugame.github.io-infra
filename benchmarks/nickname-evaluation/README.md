# 닉네임 평가 연구 자료

Lab은 사람이 제공한 닉네임·기대 판단 근거·위험 점수로 모델의 닉네임 평가 결과를 검토한다. 모델 입력에는 닉네임만 포함하며 사람이 제공한 근거와 점수는 전달하지 않는다.

Human Evaluation 이후의 승인 자료 변환, 로컬 R9700 LoRA 학습, A–D replay/live 비교와 승격 검증은 [닉네임 LoRA 실험](../../experiments/nickname-lora/README.md)에서 수행한다. 운영 모델 교체와 배포는 별도 절차이다.

## 데이터셋 양식

[JSONL 기본 양식](templates/nickname-research.jsonl)과 [CSV 기본 양식](templates/nickname-research.csv)은 형식 설명용 가상 사례 한 건이다. 1~10,000건, 최대 4 MiB를 지원하며 언어·범주별 고정 분포를 요구하지 않는다. 필수 필드, split·표현군, 모델 입력과 내보내기 계약은 [Lab 운영 문서](../../docs/operations/nickname-evaluation-lab.md#데이터셋과-실행-계약)에 명시한다.

## 사람의 근거 작성용 조사 자료

- [한국 웹 표현 조사 DB](expressions/README.md): 의미군·관측 표기·출처와 검토 상태
- [닉네임 의미 해석 조사 자료](curated/README.md): 개별 닉네임의 해석 가설·다른 독법·출처

조사 자료는 기대 근거를 작성할 때 참조한다. 위험 점수가 없는 자료에 점수를 자동 부여하거나 별도 Lab 데이터셋 유형으로 등록하지 않는다. Lab에 사용할 사례는 사람이 기대 근거·점수와 필요한 split·family를 검토하여 기본 양식으로 작성한다. 조사 자료의 사용 문맥은 사람이 근거를 검토하기 위한 기록이며 모델 입력이 아니다.

원자료 수정 후 탐색 문서와 출처 목록을 재생성한다.

```sh
npm run build -w @pcu/contracts
node benchmarks/nickname-evaluation/curated/build.mjs --write
node --test benchmarks/nickname-evaluation/expressions/validate.test.mjs
```
