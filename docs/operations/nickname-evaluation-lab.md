# 닉네임 평가 Lab

`/lab/nickname-evaluation`에서 `BETA_TESTER`와 `ADMIN`이 닉네임의 변형·은어·모욕 가능성을 평가한다. 관리자는 관리자 화면에서 일반 사용자를 검색하여 베타 권한을 부여·회수한다. 동일 세션의 다음 요청부터 변경된 권한을 적용한다. 변경 기록은 PostgreSQL의 `LabRoleAudit`에 관리자 ID, 대상 ID, 변경 전후 역할, 시각을 저장한다. 실험과 데이터셋의 열람 범위는 소유자와 관리자다.

## 로컬 구성

API와 Benchmark Worker에는 같은 개발용 PostgreSQL, 설치된 모델 이름, provider와 endpoint를 설정한다. 기존 API의 Google 로그인·쿠키·Origin 설정을 사용한다. API 실행에 필요한 환경은 [저장소 개발 안내](../../README.md)에 있다. Worker는 DB와 아래 실험실 설정만 읽는다.

| 환경 변수 | 설정 |
| --- | --- |
| `LAB_ENABLED` | 기본 비활성. API와 Worker를 사용할 때 `true` |
| `LAB_MODEL_PROVIDER` | `ollama`, `openai-compatible`, `transformers-generate` |
| `LAB_MODEL` | 추론 서버에 이미 로드할 수 있는 모델의 정확한 ID |
| `LAB_MODEL_URL` | Ollama 또는 `/generate` 서비스의 루트 또는 OpenAI 호환 서버의 API base URL(통상 `/v1` 포함) |
| `LAB_MODEL_API_KEY` | 추론 서버가 인증을 요구할 때 설정하는 비밀 값 |
| `LAB_GENERATE_PROFILE` | 연구용 `/generate`에서 `nickname-research-v1`. API·Worker에 동일하게 설정하며 미지정 시 기존 1,024/256토큰 경로 유지 |
| `LAB_SEARXNG_URL` | JSON 검색을 허용한 SearXNG의 서비스 루트 |
| `LAB_CONCURRENCY` | 기본 1. `transformers-generate`는 1, 나머지 provider는 1~4. 같은 DB를 처리하는 모든 Worker에 같은 값을 적용 |
| `DATABASE_URL` | 해당 환경의 실험 테이블에 접근 가능한 PostgreSQL 연결 |

개발 DB에 저장소 migration을 적용한 뒤 API·Web과 별도 터미널에서 `npm run worker:benchmark -w apps/api`를 실행한다. 빌드된 API 이미지의 Worker 진입점은 `node dist/benchmark-worker.js`이다. Worker는 수신 포트 없이 작업을 조회한다. API는 서버 상태 요청 시 메타데이터만 조회한다. 모델 URL, API key, 데이터베이스 자격 증명은 서버 환경에만 둔다.

## 데이터셋과 실행 계약

Lab은 닉네임 평가 시스템 하나로 운영한다. 데이터 스키마는 `3`, 응답 스키마는 `2`, 기본 평가 프로토콜은 `nickname-risk-v1`, 연구 프로파일은 `nickname-research-v1`이다. Run에는 실제 지침과 hash를 저장하며 Worker 설정과 저장된 프로파일이 다르면 실행을 거부한다. 스키마 번호는 Phase 1 기록의 의미를 유지하며, 지원하지 않는 이전 데이터 형식을 실행하거나 변환하는 경로는 제공하지 않는다.

1. [JSONL 기본 양식](../../benchmarks/nickname-evaluation/templates/nickname-research.jsonl) 또는 [CSV 기본 양식](../../benchmarks/nickname-evaluation/templates/nickname-research.csv)에 사람이 작성한 데이터를 등록한다. 1~10,000행, 최대 4 MiB를 지원하며 고정 언어·범주 분포를 요구하지 않는다.
2. 데이터셋 미리보기에서 닉네임·ID를 검색하고 기대 근거·점수·범위·split·family를 확인한다. 실행 크기는 1개·10개·50개·현재 split 전체·사용자 지정이다. 직접 선택한 ID는 요청한 개수와 일치해야 하며, 선택하지 않으면 해당 split의 파일 순서대로 실행한다.
3. 검색 모드·생성 설정과 공통·검색·답변 지침을 선택한다. 기본 지침을 수정하여 명령 표현이나 판단 기준에 따른 결과를 비교한다. 실행 생성 후에는 저장한 지침을 유지한다.
4. 진행률 조회, 취소, 실패 재실행, 비교와 JSON·JSONL·CSV 내보내기를 수행한다. 비교 대상은 같은 데이터셋 hash·스키마로 제한한다.

API 기준 경로는 `/api/lab`이다. 데이터 등록은 `POST /datasets`에 `{name, format, content, defaultSplit?}`를 전달한다. `format`은 `jsonl` 또는 `csv`이다. `POST /runs`는 데이터셋·크기·선택 ID·split·모델·검색 모드·생성 설정을 받는다. 공유 계약은 `packages/contracts/src/lab.ts`에 정의한다.

### 실행별 지침과 비교 조건

`POST /runs`의 선택적 `systemPrompt`는 공통 판단 지침, `actionPrompt`는 모델 검색 결정·도구 호출 지침, `answerPrompt`는 최종 판단 지침이다. 각 항목은 최대 8,000자이며 원문의 공백·줄바꿈을 보존한다. 항목을 생략하면 해당 프로파일의 기본값을 저장하고, 빈 문자열은 해당 지침의 명시적 생략으로 처리한다. 기본값은 `packages/contracts/src/lab-prompts.ts`와 `lab-research.ts`에서 관리한다.

각 생성 요청의 시스템 메시지는 공통 지침과 해당 단계 지침을 줄바꿈으로 연결한다. 닉네임·검색 발췌문은 사용자 메시지로 전달한다. `/generate`에도 `system_prompt`를 명시하므로 모델 서버의 별도 코딩용 기본 지침을 사용하지 않는다. 서버는 빈 시스템 지침을 받으면 시스템 메시지를 생략하며, 모델 자체의 chat template는 계속 적용한다. 검색 없는 평가와 서버 선검색에서는 `actionPrompt`를 사용하지 않는다.

API는 세 지침의 원문과 고정 키 순서 JSON의 SHA-256을 저장한다. Worker는 저장한 값을 읽어 재시도에도 동일하게 적용한다. 실행 상세와 JSON·JSONL·CSV 내보내기에 세 지침과 `promptHash`를 포함하며, 실제 생성 메시지·보정 요청은 결과 이력에 보존한다. 비교 시 데이터셋·선택 사례·모델·검색 모드·생성 설정을 통일하고 지침을 변경한다. 검색 결과는 시점에 따라 달라지므로 지침 차이만으로 결과 변화를 단정하지 않는다.

JSON schema, 닉네임 일치, 점수 범위, 인용 ID·발췌문 검증, 유보 시 `score=null`, 연구 모드의 미검증 복원 가설 유보 조건은 Worker 검증 조건이다. 지침 편집으로 이 조건을 해제하지 않는다. 형식·인용 오류에는 한 차례 보정 요청을 추가할 수 있으며 실패 응답도 이력에 보존한다. 토큰·시간·검색 횟수 제한을 유지하고 지침 원문은 자동으로 축약하지 않는다. 따라서 지침 비교 결과에는 성공 판단뿐 아니라 형식 오류·입력 한도 초과도 포함한다.

`e13fdeae`의 닉네임 평가 통합에서 사용자 지침 입력과 Worker 전달이 제거되었으며, 이후 도움말에는 동일 조건 비교를 위한 고정으로 설명되었다. 현재는 지침을 실험 변수로 저장한다. 기존 실행의 `systemPrompt`·hash·이력은 변경하지 않는다. 기본 `/generate` 경로는 이번 변경부터 평가 지침을 사용자 메시지 대신 시스템 메시지로 전달하므로 과거 실행과 비교할 때 실제 메시지 이력을 확인한다. 이전 hash는 공통 지침만 식별하므로 새 hash와 직접 비교하지 않으며, 단계 지침이 `null`인 이전 실행은 실제 이력으로 확인한다.

`20261125130000_lab_editable_prompts`는 nullable text 열 두 개를 추가하는 단일 SQL 문으로 원자적으로 적용한다. 기존 행을 갱신하지 않으며 구형 writer는 새 열을 생략할 수 있다. 실제 사용자 지침 적용에는 새 API·Worker·Web과 빈 시스템 지침을 지원하는 모델 서버를 함께 사용해야 한다. 배포 시 Lab 쓰기·Worker를 중단하고 migration과 각 구성 요소 갱신 후 재개한다. 적용 이후 복구는 기존 배포 runbook의 forward recovery 절차를 따른다.

### 사람의 입력과 연구 메타데이터

JSONL의 필수 필드는 `nickname`, `reference.expectedReason`, `reference.expectedScore`다. `id`를 생략하면 파일 행 순서에 따라 `nick-0001` 형태로 생성하며 명시한 ID와 충돌하지 않도록 구분한다. 기대 점수는 0~100 정수이며 정확히 일치해야 하는 절대 정답이 아니다. 기대 근거도 검증할 가설 또는 평가 기준이다. 정상·모호 사례를 같은 형식으로 등록할 수 있다.

선택 필드는 `reference.scoreRange`, `reference.sources`, `familyId`, `tags`, `split`이다. 범위는 `[하한, 상한]`으로 기대 점수를 포함해야 한다. `split`은 `train`, `validation`, `test` 중 하나이며 미지정을 허용한다. 가져오기 기본 split은 파일에 split이 없는 행에만 적용한다. 같은 원형·파생형·난독화 표현에는 같은 `familyId`를 부여한다. 동일 데이터셋에서 같은 family가 여러 split 또는 지정·미지정 split에 분산되면 등록을 거부한다. family 문자열의 비교는 NFKC·공백·대소문자 정규화를 적용한다. 자동 family 추론과 서로 다른 데이터셋 사이의 누출 검사는 수행하지 않으므로, 평가에 사용할 전체 자료의 family와 split을 함께 확정한다.

CSV의 필수 열은 `nickname,expectedReason,expectedScore`이며 선택 열은 `id,scoreRange,sources,familyId,tags,split`이다. `scoreRange`, `sources`, `tags` 셀은 JSON 배열로 작성한다. 쉼표·큰따옴표·여러 줄 근거는 CSV 인용 규칙을 적용하며 UTF-8 BOM을 허용한다. 중복 ID·정규화한 중복 닉네임·알 수 없는 열·잘못된 범위는 등록을 거부한다.

등록된 데이터셋은 불변 스냅샷이다. 신규 등록의 hash는 검증·기본값 적용 후의 전체 행과 판본·스키마로 계산하므로 근거·split·점수를 변경하면 새 스냅샷이 생성된다. `version`은 데이터셋 판본 번호이며 현재 값은 `3`이다. `schemaVersion`은 저장 구조의 버전이다. 실제 데이터 내용의 버전 식별에는 SHA-256을 사용한다. Phase 1 스냅샷의 hash는 변경하지 않는다. 유형 필드를 제거한 이후의 신규 등록은 현재 계약으로 hash를 계산하므로, 동일 내용을 재등록해도 Phase 1 기록과 별개 스냅샷이 생성될 수 있다.

### 모델 입력과 결과

관리용 `LabCase`와 모델용 branded `LabNicknameInput`을 분리한다. Worker claim은 평가 본문·정답·태그·family·split을 조회하지 않고 닉네임 문자열만 전용 DTO로 구성한다. 케이스 ID는 실행 상태 저장에만 사용한다. Provider 경계에서 다시 닉네임만 투영하여 검색 도구 호출·JSON 재생성·schema fallback에도 관리 메타데이터를 전달하지 않는다.

```text
사람의 JSONL/CSV → API 검증 → 불변 Dataset + 관리용 Case
                           → Run 선택(split/ID) → lease·재시도 Worker
                           → { nickname } + 실행별 지침 → 모델·검색
                           → 응답 검증 + 수집 출처 → Result → 비교·내보내기
```

모델 응답은 `schemaVersion: "2"`, `nickname`, `interpretedTerm`, `reason`, `score`, `confidence`, `sourceIds`, `abstained`로 구성한다. `score`는 0~100 위험 검토 필요성, `confidence`는 0~1 판단 신뢰도다. 해석한 표현과 점수는 `null`을 허용한다. 판단 유보 시 점수는 `null`이어야 한다. 검색 결과 부재를 0점으로 변환하지 않으며 `null` 점수는 평균에서 제외한다. 평균 점수는 정확도 지표가 아니다.

모델은 수집한 출처 ID만 인용할 수 있다. API와 세 내보내기 형식의 각 결과에는 `sources`로 ID·실제 URL·제목·발췌문·수집 시각을 함께 제공한다. URL 형식·공개 주소 정책·ID 대응을 검증하며 출처 내용의 사실성이나 판단의 타당성을 자동으로 확정하지 않는다. `web_open`은 검색 서비스가 제공한 발췌문을 조회하며 원문 페이지 직접 수집은 수행하지 않는다. 사람의 `reference.sources`는 관리 자료로만 보존하며 검색 서비스나 모델에 전달하지 않는다.

### 정리 migration과 복구

`20261125100000_lab_nickname_only`는 별도 후속 migration이다. 이미 존재하는 `20261120000000_term_origin_lab`과 `20261125000000_lab_nickname_research`는 수정하지 않는다. 과거 migration 경로의 이름은 이력 식별자로 유지한다.

- 삭제 대상: `context_terms`, `nickname_legacy` 데이터셋과 그 데이터셋의 결과·실험·케이스. 결과에서 데이터셋 순으로 외래키 의존성을 따라 삭제한다.
- 보존 대상: Phase 1 `nickname_risk`의 케이스 본문, 기대 근거·점수·split·family, hash·판본, 프롬프트·모델 설정, 결과·출처·history·실행 상태·lease. 졸업전시 테이블과 권한 감사 기록은 변경하지 않는다.
- 스키마 변경: `LabTestCase.term`을 `nickname`으로 변경하고 `context`, `language`, Dataset·Run의 `datasetType`을 제거한다. 판본·스키마·평가 지침 기본값은 현재 계약으로 갱신한다.

향후 릴리스에서는 백업을 확보하고 Lab API 쓰기와 Benchmark Worker를 중단한 뒤 활성 lease가 만료될 때까지 대기한다. 구형 writer와 새 schema의 혼합 운영은 지원하지 않는다. 정리 migration은 Lab 네 테이블을 잠그고 하나의 transaction에서 실행한다. 알 수 없는 유형, Dataset·Run 메타데이터 불일치, 활성 lease, 손상된 Phase 1 본문·응답이 있으면 실패한다. 검증 실패 시 앞서 수행한 삭제와 DDL도 전체 롤백한다. 자동 변환이나 손상된 신규 데이터 삭제로 실패를 우회하지 않는다.

성공 후 새 API·Worker·Web을 함께 기동한다. 보존한 대기 작업과 만료 lease는 기존 재시도 절차로 재개한다. 저장된 프롬프트·출처·비교·내보내기와 졸업전시 조회를 확인한다. 실험 자료는 DB 내부 JSON과 출처 URL이며 이 migration에서 S3 파일·삭제 outbox 등 외부 자원 참조를 제거하지 않는다.

적용 후 구형 binary를 자동 복원하지 않는다. 실패 원인을 확인하여 forward fix 또는 검증된 백업 복원 절차를 선택한다. 삭제한 구형 실험이 필요한 경우 백업에서 별도 복구하며 현재 Lab에 재등록하는 변환기는 제공하지 않는다. 운영 적용은 [배포 및 복구 절차](deployment.md)와 [migration 정책](../database-migration-policy.md)을 따른다.

## 연구용 4B 프로파일

연구 서버는 `LOCAL_LLM_PROFILE=nickname-research-v1`로 실행한다. 호환 `/generate` 경로를 유지하며 프로세스·Unix 소켓·8089 포트를 기존 코딩 서비스와 분리한다. API와 Worker에는 `LAB_GENERATE_PROFILE=nickname-research-v1`, `LAB_MODEL_PROVIDER=transformers-generate`, `LAB_MODEL=Qwen3-4B-Instruct-2507-Q4_K_M`, `LAB_CONCURRENCY=1`을 동일하게 설정한다. [서버 구성·측정 명령](../../server/local-llm/README.md)

2026-11-25 사용자 요청으로 `gameserver`의 기존 `qwen-coder.service`를 중지하고 자동 시작을 해제하였다. 기존 서비스 파일·가중치는 보존하였다. 연구 검증은 임시 프로세스에서 수행하며 운영 API·Worker의 연구 프로파일 전환은 별도 릴리스 대상이다. 기존 SearXNG는 `gh-deploy`의 `gp-lab-search` 컨테이너 내부 `127.0.0.1:18888`에서 재사용하였다.

프로파일 미지정 경로는 기존 코딩 기본 지침, 선택적 `system_prompt`, 1,024/256토큰, 1,536토큰 컨텍스트와 8088 포트를 유지한다. Worker의 기존 JSON 텍스트 생성과 `model_tool_call`의 지원 조건도 유지한다. 신규 능동 조사는 연구 프로파일에서만 활성화한다.

### Chat template와 구조화 출력

llama.cpp b12559와 실제 Qwen GGUF template에서 단순 JSON probe와 전체 action·판단 schema를 확인한다. 이 조합의 `/v1/chat/completions`는 긴 응답 뒤에 `peg-native` 출력 파서 오류를 반환한 사례가 있으므로 연구 서버는 `/apply-template` → `/tokenize` → `/completion`을 사용한다. `/completion`에 정확한 template token ID와 `json_schema`를 전달하며 네이티브 Tool Calling은 사용하지 않는다. 기존 호환 프로파일의 chat 경로는 유지한다. [llama.cpp b12559 서버 API](https://github.com/ggml-org/llama.cpp/blob/b12559/tools/server/README.md)

문자열의 PostgreSQL Unicode 검증 정규식을 GBNF에 그대로 적용하면 따옴표·줄바꿈까지 허용하는 문법이 생성될 수 있다. 생성용 schema에는 길이 제한이 있는 JSON 문자열을 사용하고, Unicode scalar 검증은 Worker의 후속 검사로 유지한다. 서버는 JSON을 금지하는 반대 지침에도 고정 JSON을 생성하는 준비 검사를 통과한 뒤 준비 완료를 알린다. `/health`에는 모델 ID, GGUF SHA-256, 실제 template와 hash, 엔진 버전, KV cache 형식, 컨텍스트, seed와 구조화 출력 경로를 제공한다. Worker는 요청마다 가중치·template hash를 전달하며 서버는 불일치를 거부한다. 생성 응답의 토큰 수는 실제 렌더링·토큰화 결과와 다시 대조한다. 잘린 응답, 잘못된 schema와 인용은 성공 결과로 저장하지 않는다.

### 세 가지 비교 모드

| 모드 | 자료 수집 |
| --- | --- |
| `no_search` | 검색 없이 모델 자체 지식으로 최종 판단 |
| `backend_retrieval` | 기존처럼 Worker가 원본 닉네임으로 1회 선검색 |
| `agentic_retrieval` | 모델이 해석 가설과 `search`·`finish` JSON action을 생성하고 Worker가 최대 2회 검색 |

세 모드의 기본 연구 지침·가중치·최종 생성 한도는 동일하며 지침은 실행별로 변경할 수 있다. action은 검색어와 최대 두 개의 짧은 해석 가설만 포함한다. NFKC 표기는 보조 가설이며 원본 닉네임은 보존한다. 기본 지침은 혼합 문자와 자모의 시각적·음성적 독법을 검토하되 유사성만으로 의미를 확정하지 않도록 한다. 원형 사전, 비속어 목록, 데이터셋의 기대 근거·점수·family를 사용하는 복원기는 없다.

최종 생성은 `evidenceChecks`를 먼저 작성하고 판단을 생성한다. 인용문·주장·관련성(`supports_concern`, `ordinary_usage`, `unrelated`)을 기록한다. Worker는 현재 제공한 ID와 정확한 발췌문 인용을 확인하고 `unrelated` 인용을 거부한다. URL은 Worker의 수집 기록에서 결합한다. 이 검사는 인용의 문자적 일치와 대응을 보장하며 의미 해석의 정확성을 자동 확정하지 않는다. 단어의 등장이나 커뮤니티 사용 사실만으로 위험성·사용자 소속을 단정하지 않도록 지시한다.

`interpretationStatus`는 문자 그대로의 독법, 자체 지식의 알려진 표현, 미검증 복원 가설, 인용으로 뒷받침한 복원 가설을 구분한다. 미검증 복원 가설은 `abstained=true`, `score=null`이어야 하며 인용으로 뒷받침하였다는 응답에는 출처가 필요하다. Worker가 이 조건을 확인하고 분류를 이력에 보존한다. 분류 자체도 모델 응답이므로 복원 정확도와 의미적 근거 적합성에는 사람의 검토가 필요하다.

### 발췌문 범위와 웹 문서 격리

현재 구현에는 원문 fetch가 없다. `web_open`도 기존 검색 발췌문 조회이다. 연구 이력에는 `evidenceKind=search_snippet`, `originalFetched=false`와 원문 미검증 한계를 기록하며 화면에도 표시한다. [SearXNG API](https://docs.searxng.org/dev/search_api.html)

네트워크 요청은 설정된 모델·SearXNG로 제한하고 redirect를 거부한다. 검색 응답은 384,000바이트·10초·최대 4개 결과로 제한하며 공개 URL 정책을 적용한다. 검색 결과 URL에는 직접 접속하지 않는다. 웹 문서는 JSON 문자열로 격리하며 `<`·`>`를 escape하여 template 제어 토큰으로 처리되지 않게 한다. 임의 도구·fetch action은 거부한다. 검색 실패와 무관한 결과는 기록하며 0점으로 자동 변환하지 않는다. 이러한 제약은 도구 실행 범위를 제한하지만 모델의 모든 prompt injection 오판을 배제하는 증거는 아니다.

### 자원 한도와 이력

| 항목 | 연구 프로파일 상한 |
| --- | --- |
| 입력 / 최종 출력 | 생성당 실제 입력 2,048 / 출력 768토큰 |
| action 출력 | 320토큰, Run 출력 설정이 더 작으면 해당 값 |
| 엔진 컨텍스트 | 3,072토큰, 단일 동시 추론, f16 KV cache |
| 검색 / 생성 | 검색 2회 / 생성 5회. JSON 재생성도 같은 상한에 포함 |
| 누적 입력 / 출력 | 8,192 / 2,304토큰 |
| 전체 / 단일 생성 | 240초 / 90초 |

실제 token count가 한도를 초과하면 두 검색 단계의 발췌문을 300→180→100자로 압축하고, 여전히 초과하면 일부 자료를 제외한다. 정확히 제공한 자료와 프롬프트를 기록한다. 다음 생성의 출력 예산을 먼저 예약하므로 응답 유실 시에도 한도를 초과하여 재시도하지 않는다. 누적 예산이 부족하면 최종 재생성을 생략할 수 있다. 연구 오류에는 전체 조사 자동 재시도를 적용하지 않는다. 기존 Worker의 lease 복구·명시적 재실행 횟수 제한은 유지한다.

`history[].research`에 가중치·template·엔진, 시스템 지침과 단계별 프롬프트·schema, 해석 후보, 모델 검색어, 실제 검색 결과, 제공 자료, 인용 검증, 생성 설정, 입력·출력 토큰과 소요 시간을 보존한다. 전체 시간에는 검색·토큰화도 포함된다. 응답 유실 시 실제 출력 토큰은 `null`이고 예약량을 별도로 기록한다. 숨겨진 사고 과정의 출력을 요구하지 않는다. 자료와 전체 이력은 JSON·JSONL export에 포함하고 CSV는 분석용 독립 열로 제공하므로 대규모 실행은 DB·export 메모리 용량을 함께 검토한다.

### 단일 평가와 비교 실행

API 화면에서 같은 데이터셋·케이스를 세 모드로 실행하거나 CLI를 사용한다. CLI는 DB 없이 같은 Worker evaluator를 호출하며 한 번에 최대 50개 닉네임을 허용한다. 기대 근거와 점수는 CLI의 비교 지표 계산에만 사용하며 모델용 DTO는 닉네임 하나로 구성한다.

```sh
npm run build -w @pcu/contracts
export LAB_ENABLED=true LAB_MODEL_PROVIDER=transformers-generate
export LAB_GENERATE_PROFILE=nickname-research-v1
export LAB_MODEL=Qwen3-4B-Instruct-2507-Q4_K_M LAB_CONCURRENCY=1
export LAB_MODEL_URL=http://127.0.0.1:8089
# Worker에서 접근할 수 있는 기존 SearXNG의 실제 주소
export LAB_SEARXNG_URL=http://127.0.0.1:18888
npm run lab:research -w apps/api -- --nickname '달빛산책' --mode all --output /tmp/nickname-comparison.json
npm run lab:research -w apps/api -- --dataset /path/to/research.jsonl --limit 10 --mode all --output /tmp/nickname-dataset-comparison.json
# 선택적 JSON 파일: {"systemPrompt":"공통 지침", "actionPrompt":"검색 지침", "answerPrompt":"답변 지침"}
npm run lab:research -w apps/api -- --nickname '달빛산책' --mode all --prompts-file /path/to/prompts.json --output /tmp/nickname-prompt-comparison.json
```

비교 JSON에는 동일 데이터셋 hash·선택 ID, 모드별 JSON 성공 수·유보 수·채점 수·MAE·기대 범위 충족률·시간·토큰을 기록한다. MAE와 범위 충족률은 유효 점수가 있는 사례만 분모로 사용한다. 채점·유보·실패 수를 함께 비교하며, 평균 점수나 일부 성공 사례를 정확도 향상으로 해석하지 않는다. 검색 시점의 결과는 달라질 수 있으므로 수집 결과 전체를 함께 보존한다.

## 통합 검증

실제 Qwen3 4B·기존 SearXNG의 두 사례, 세 모드 비교와 GPU 측정은 [2026-11-25 검증 기록](../../benchmarks/nickname-evaluation/validation/2026-11-25/README.md)에 보존하였다. Fake Provider 결과와 실제 모델 결과, 복원 실패와 발췌문 한계를 구분하였다.

격리된 PostgreSQL과 Fake HTTP Provider로 실제 세션·API·독립 Worker를 확인하는 suite 이름은 `nickname-evaluation`이다. 저장소 통합 환경에서는 `npm run test:integration:suite -- nickname-evaluation`로 실행한다. [데이터셋 검증과 출처](../../benchmarks/nickname-evaluation/README.md)에는 데이터 양식과 조사 자료 검증 명령이 있다. Web 단독 화면 검증은 `npm run dev:mock -w apps/web`로 실행하며 화면과 내보내기 결과에 모의 실행임을 표시한다.

## 운영 전 검증

일반 릴리스는 API와 기존 6개 Worker의 고정 Quadlet 구성을 검사한다. 현재 구성에서 실험실의 기본값은 비활성이며 추가 Worker를 자동 기동하지 않는다. 운영 활성화 전 다음 항목을 검증한다.

- 실제 API·Worker 실행 위치에서 모델 ID, 구조화 JSON, 도구 호출, SearXNG JSON 형식, 검색 출처를 1개·10개 실행으로 확인한다. 모델·검색 서비스는 사설 네트워크로 접근을 제한하고, 추론 서버 자체의 동시 실행 제한과 GPU 메모리·취소 동작을 확인한다.
- 별도 Worker unit의 전용 환경 파일과 리소스 한도를 구성한다. 기존 Worker 공용 환경 파일에 모델 비밀 값을 배포하지 않는다. 새 unit을 정식 topology에 편입할 때 drain·백업·migration·재기동·불변 이미지 확인·전체 health 검사를 함께 검증한다.
- 초기 Lab migration은 역할 enum 추가와 실험용 테이블·인덱스 생성으로 구성되며, 후속 정리 migration은 위 정리·복구 절차를 적용한다. 신규 역할을 부여하기 전에 Web과 모든 기존 API 인스턴스가 새 역할을 학생 권한으로 처리하는지 확인한다. writer 중단·전환, 백업 복원, 최대 10,000건 저장·내보내기의 메모리, DB 용량과 데이터 보존 기간을 점검한다. 내보내기는 API 프로세스당 한 건을 처리하며 결과와 발췌문을 응답 생성 중 메모리에 적재한다.
- 운영 migration은 기존 릴리스 절차에서 수행한다. migration 시도 이후 복구는 기존 runbook의 forward-fix 또는 데이터 복원 절차를 따른다. [배포 및 복구 절차](deployment.md)

## Human Evaluation과 다음 연구 단계

[Human Evaluation 운영 절차](nickname-human-evaluation.md)에 독립적인 벤치마크·행동 평가, 일괄 승인, 표현군 단위 분할과 preference JSONL 내보내기를 명시한다. 학습 파일은 실제 입력·원본 응답·긍정 또는 부정 label만 포함한다. 교정 JSON 작성과 신규 SFT 후보 생성은 제공하지 않으며 과거 기록은 연구 이력으로 보존한다. 판단 지표는 각 분모·미측정 수와 함께 제공한다. GPU 학습 알고리즘 변경과 모델 개선 효과 측정은 후속 단계이다.


## 지침 파일과 결과 다운로드

지침 편집 영역의 **현재 지침 다운로드**는 `systemPrompt`, `actionPrompt`, `answerPrompt` 세 문자열을 UTF-8 JSON으로 저장한다. **지침 JSON 가져오기**는 최대 256 KiB와 항목별 8,000자를 검증한 뒤 편집값에만 적용한다. 생략한 항목에는 현재 프로파일의 기본 지침을 적용하며 빈 문자열·공백·줄바꿈은 보존한다. 잘못된 JSON·UTF-8·항목은 전체 가져오기를 거부하고 기존 편집값을 유지한다. 실행 상세의 **사용한 지침 다운로드**는 실행 시 저장한 세 원문을 제공한다. CLI의 `--prompts-file`에도 같은 검증을 적용한다.

실험 결과 다운로드는 검색·처리 상태 필터·페이지와 관계없이 해당 실행 전체를 대상으로 한다. DB의 동일 시점 스냅샷에서 설정·결과·검수 이력을 읽으며, 실행 중인 경우에도 생성 시각과 당시 상태를 기록한다. 위험 판정 임계점은 화면의 입력값을 전달하고 Human Evaluation과 동일한 지표 계산 함수를 사용한다.

| 형식 | 내용 |
| --- | --- |
| 전체 JSON | `formatVersion=nickname-evaluation-v2`, 생성 시각, 실행 설정·지침, 데이터셋 식별정보, 전체 사례·응답·수집 출처·실행 이력, 검수 revision·원본 스냅샷·현재 결과에 대한 유효성, 평가 지표 |
| JSONL | 실행 순서대로 한 줄에 한 사례. 실행 식별정보·설정, 상세 결과·이력·검수, 사례별 평가값과 실행 지표 포함 |
| 분석용 CSV | 한 행에 한 사례. 기대·생성 근거, 기대·실제 점수·오차, 출처, BERTScore, 유효한 최신 검수, 상태·오류·시간을 독립 열로 제공. 전체 결과 JSON 셀 제외 |

CSV는 UTF-8 BOM과 CRLF를 사용하고 따옴표·셀 내부 줄바꿈을 보존한다. 수식으로 해석될 수 있는 문자열에는 작은따옴표를 접두하여 저장한다. 음수인 수치 오차는 숫자로 유지한다. 전체 검수 이력은 JSON·JSONL로 확인하며 CSV의 유효하지 않은 최신 검수는 판정 열을 비우고 `reviewValid=false`로 표시한다.

## CPU 근거 유사도 평가

생성 결과 저장 transaction에서 `LabBertScore` 작업을 등록하고 Benchmark Worker의 독립 loop에서 처리한다. 기대 근거는 이 평가 서비스에만 전달하며 생성 모델 입력에는 포함하지 않는다. 생성 실행의 완료 상태와 평가 진행 상태는 별도로 표시한다. **BERTScore만 재시도**는 실패·취소된 평가 작업만 다시 등록하고 모델 응답을 재생성하지 않는다.

[CPU 서비스 구현](../../server/bertscore/service.py)은 [BERTScore 공식 구현](https://github.com/Tiiiger/bert_score)의 P/R/F1을 사용한다. 모델은 `google-bert/bert-base-multilingual-cased`, revision은 `3f076fdb1ab68d5b2880cb87a0886f315b8146f8`이다. 9번째 층, CPU 4스레드, 배치 4, slow tokenizer, IDF·baseline 보정 없음으로 고정한다. 모델과 tokenizer를 같은 revision에서 내려받으며 설정·관련 라이브러리 버전과 SHA-256을 결과에 보존한다. 서비스 의존성은 [requirements](../../server/bertscore/requirements.txt)에 고정한다.

- 근거가 있는 유보 응답도 계산한다. 생성 실패·취소, 빈 근거, 512토큰 초과는 사유가 있는 미측정으로 기록한다. 길이 검사에는 특수 토큰을 포함하며 조용히 잘라 계산하지 않는다.
- DB 전체에서 한 배치만 처리한다. 30초 lease를 1초마다 갱신하고 token과 만료 시각을 확인한 뒤 완료한다. 일시 오류는 5초·10초 간격으로 재시도하며 회차당 3회, 사례당 총 12회로 제한한다. 처리 중 Worker가 종료되면 lease 만료 후 회수한다.
- 실행 취소는 미완료 생성과 대기·처리 중 평가를 취소한다. 이미 완료된 응답·평가는 보존한다. 취소 후 평가만 명시적으로 재시도할 수 있으며 실행의 생성 상태는 유지한다.
- BERTScore는 근거 문장 유사도의 보조 지표이다. 정답 여부·위험 판정의 정확도와 동일하지 않다. 사람 검수 화면은 기대 정답 공개 전 사례별 값을 숨긴다. 파생 평가값은 사람 검수의 원본 결과 hash에서 제외한다.
- Migration은 새 평가 table·index만 추가하고 transaction으로 적용한다. 기존 결과의 변환·재계산·backfill은 수행하지 않으며 데이터셋과 기존 검수 원본을 유지한다.

### 로컬 실행과 배포 설정

```sh
docker build -f server/bertscore/Dockerfile -t pcu-bertscore:local .
docker run -d --name pcu-bertscore --cpus=4 --memory=3g \
  -p 127.0.0.1:8090:8090 -v pcu-bertscore-cache:/cache pcu-bertscore:local
curl --fail http://127.0.0.1:8090/health
# 기존 Benchmark Worker의 전용 환경에 추가
export LAB_BERTSCORE_URL=http://127.0.0.1:8090
npm run worker:benchmark -w apps/api
```

최초 실행은 모델 다운로드와 로딩 이후 `/health`를 제공한다. cache volume을 재사용하면 다운로드를 생략한다. Worker가 컨테이너에서 실행되면 같은 사설 network에서 접근 가능한 주소를 지정한다. API와 Web에는 평가 서비스 주소를 노출하지 않는다. 서비스 URL을 지정하지 않으면 평가 작업은 대기 상태로 유지한다. 운영 적용은 기존 릴리스 절차에 따라 API·Benchmark Worker·Web과 별도 CPU 서비스를 갱신하고 image digest·health를 확인한다.

```sh
python3 -m unittest discover -s server/bertscore -p 'test_*.py'
# 실제 모델을 사용한 계산 검사: Docker 실행 권한과 최초 다운로드 필요
docker run --rm --cpus=4 --memory=3g -e RUN_BERTSCORE_INTEGRATION=true \
  -v pcu-bertscore-cache:/cache -v "$PWD/server/bertscore:/tests:ro" \
  pcu-bertscore:local python -m unittest discover -s /tests -p 'test_*.py'
# PostgreSQL·인증 API·독립 Worker 검사는 nickname-evaluation suite에 포함
npm run test:integration:suite -- nickname-evaluation
```

실제 평가 서비스가 준비된 로컬 환경에서는 `TEST_BERTSCORE_URL`과 `RUN_POSTGRES_INTEGRATION=true`, 격리 schema를 생성할 수 있는 개발용 `DATABASE_URL`을 지정하여 `lab-bertscore.postgres.test.ts`를 실행한다. CI는 모델을 다운로드하지 않고 HTTP fixture로 실패·재시도·취소·재시작을 검증한다.
