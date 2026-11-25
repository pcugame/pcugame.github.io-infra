# 닉네임 의미 해석 조사 자료

[사례별 해석과 채택 이유](cases.md) · [수작업 원자료](cases.json) · [출처 부분집합](sources.json) · [표현 DB](../expressions/README.md)

표면 표기와 사회적 의미를 구별하기 위한 22건의 조사 자료이다. 사례별 `meaningGroupIds`로 표현 DB의 근거를 연결한다. 관측 닉네임 2건, 관측 표현 2건, 합성 이름 18건이며 표기 관측과 의미 근거를 별도로 기록한다. 합성 이름의 전체 표기나 작성 의도를 출처가 관측한 것으로 처리하지 않는다.

## 검토 기준

- `probe` · 의미 탐지: 지칭 대상·사건·단어 관계에 따른 위험 독법을 설명한다.
- `ambiguous` · 판단 유보: 복수 독법과 구별에 필요한 추가 근거를 기록한다.
- `control` · 오탐 점검: 음식·게임·학습·인사·비판적 인용 등 이름에 나타난 일반 독법을 검토한다.

문자열의 의미와 사용자의 신원·성향·소속을 구분한다. 대상이 `unknown` 또는 `none`이라는 이유만으로 무해함을 확정하지 않는다. 원문이 없는 제보는 표현 DB의 보류 기록에만 보존한다.

## Lab 데이터셋 작성

이 자료에는 사람이 지정한 위험 점수가 없으므로 직접 업로드할 평가셋이 아니다. Lab에 사용할 사례는 사람이 가상 닉네임·기대 근거·기대 점수를 [기본 양식](../templates/nickname-research.jsonl)에 작성한다. `confirmed`는 조사 근거의 검토 상태이며 모델 성능이나 점수 정답을 의미하지 않는다. 별도 모델 입력 JSONL은 생성하지 않는다.

`cases.json`은 조사 원자료이며 출처의 기준 파일은 `../expressions/sources.json`이다. 이 디렉터리의 `sources.json`과 `cases.md`는 생성 파일이다. 검증기는 중복·의미군 참조, 관측·합성 구분, 문자열 단서·아나그램과 근거 상태를 검사한다. 해석의 타당성은 사람의 검토 대상이다.

```sh
npm run build -w @pcu/contracts
node benchmarks/nickname-evaluation/curated/build.mjs --write
node benchmarks/nickname-evaluation/curated/build.mjs
node --test benchmarks/nickname-evaluation/expressions/validate.test.mjs
```
