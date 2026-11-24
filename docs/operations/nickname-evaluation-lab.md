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
| `LAB_SEARXNG_URL` | JSON 검색을 허용한 SearXNG의 서비스 루트 |
| `LAB_CONCURRENCY` | 기본 1. `transformers-generate`는 1, 나머지 provider는 1~4. 같은 DB를 처리하는 모든 Worker에 같은 값을 적용 |
| `DATABASE_URL` | 해당 환경의 실험 테이블에 접근 가능한 PostgreSQL 연결 |

개발 DB에 저장소 migration을 적용한 뒤 API·Web과 별도 터미널에서 `npm run worker:benchmark -w apps/api`를 실행한다. 빌드된 API 이미지의 Worker 진입점은 `node dist/benchmark-worker.js`이다. Worker는 수신 포트 없이 작업을 조회한다. API는 서버 상태 요청 시 메타데이터만 조회한다. 모델 URL, API key, 데이터베이스 자격 증명은 서버 환경에만 둔다.

## 데이터셋과 실행 계약

Lab은 닉네임 평가 시스템 하나로 운영한다. 데이터 스키마는 `3`, 응답 스키마는 `2`, 고정 평가 지침은 `nickname-risk-v1`이다. 스키마 번호는 Phase 1 기록의 의미를 유지하며, 지원하지 않는 이전 데이터 형식을 실행하거나 변환하는 경로는 제공하지 않는다.

1. [JSONL 기본 양식](../../benchmarks/nickname-evaluation/templates/nickname-research.jsonl) 또는 [CSV 기본 양식](../../benchmarks/nickname-evaluation/templates/nickname-research.csv)에 사람이 작성한 데이터를 등록한다. 1~10,000행, 최대 4 MiB를 지원하며 고정 언어·범주 분포를 요구하지 않는다.
2. 데이터셋 미리보기에서 닉네임·ID를 검색하고 기대 근거·점수·범위·split·family를 확인한다. 실행 크기는 1개·10개·50개·현재 split 전체·사용자 지정이다. 직접 선택한 ID는 요청한 개수와 일치해야 하며, 선택하지 않으면 해당 split의 파일 순서대로 실행한다.
3. 검색 모드와 생성 설정을 선택한다. 평가 지침은 서버에서 고정한다. 실행 요청에 사용자 프롬프트를 지정하면 거부한다.
4. 진행률 조회, 취소, 실패 재실행, 비교와 JSON·JSONL·CSV 내보내기를 수행한다. 비교 대상은 같은 데이터셋 hash·스키마로 제한한다.

API 기준 경로는 `/api/lab`이다. 데이터 등록은 `POST /datasets`에 `{name, format, content, defaultSplit?}`를 전달한다. `format`은 `jsonl` 또는 `csv`이다. `POST /runs`는 데이터셋·크기·선택 ID·split·모델·검색 모드·생성 설정을 받는다. 공유 계약은 `packages/contracts/src/lab.ts`에 정의한다.

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
                           → { nickname } + 고정 지침 → 모델·검색
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

성공 후 새 API·Worker·Web을 함께 기동한다. 보존한 대기 작업과 만료 lease는 기존 재시도 절차로 재개한다. 고정 프롬프트·출처·비교·내보내기와 졸업전시 조회를 확인한다. 실험 자료는 DB 내부 JSON과 출처 URL이며 이 migration에서 S3 파일·삭제 outbox 등 외부 자원 참조를 제거하지 않는다.

적용 후 구형 binary를 자동 복원하지 않는다. 실패 원인을 확인하여 forward fix 또는 검증된 백업 복원 절차를 선택한다. 삭제한 구형 실험이 필요한 경우 백업에서 별도 복구하며 현재 Lab에 재등록하는 변환기는 제공하지 않는다. 운영 적용은 [배포 및 복구 절차](deployment.md)와 [migration 정책](../database-migration-policy.md)을 따른다.

## 상시 4B 서버 연결

전시용 추론 서비스에는 `LAB_MODEL_PROVIDER=transformers-generate`, `LAB_MODEL=Qwen3-4B-Instruct-2507-Q4_K_M`, `LAB_CONCURRENCY=1`을 사용한다. API와 Worker에서 같은 사설 서비스 루트에 접근할 수 있어야 한다. 개발 환경에서는 SSH 로컬 포워딩으로 원격 루프백 포트에 연결하고, `LAB_MODEL_URL`을 터널의 로컬 주소로 지정할 수 있다. API와 Worker가 컨테이너 안에 있으면 각각의 네트워크에서 주소가 도달 가능한지 확인한다.

모델 서버의 `qwen-coder.service`는 llama.cpp CUDA로 Q4_K_M 가중치를 실행한다. 호환 HTTP 서비스는 루프백의 8088번 포트를 사용하고 llama.cpp에는 전용 Unix 소켓으로 연결한다. `transformers-generate`는 이 HTTP 요청 형식을 지정한다. 신규 실행에는 `/health`에서 읽은 모델 ID를 사용한다. 이전 실험의 모델 ID는 당시 실행 기록에 보존된다.

Worker는 `GET /health`에서 모델 ID와 토큰 한도, 사용 중 여부를 확인한 다음 `POST /generate`로 고정 평가 지침·닉네임·출처와 출력 토큰 한도를 보낸다. 서비스의 시스템 지시는 고정되어 있으며 Worker가 구성한 평가 입력은 사용자 메시지 안에 전달된다. 생성은 greedy 방식이고 서버 한도는 입력 1,024토큰, 출력 256토큰, 생성 시간 90초이다. 전체 입력에는 서버 지시, 케이스, 출력 형식, 검색 발췌문도 포함된다. 입력이 한도를 초과하면 케이스 실패로 기록한다.

이 서버에서 선택 가능한 검색 모드는 `no_search`와 `backend_retrieval`이다. Worker는 선검색 자료 중 입력 예산에 맞는 발췌문을 최대 두 건까지 전달한다. 응답은 닉네임 평가 필드와 짧은 한국어 근거를 요청하며 서버 출력 한도를 적용한다. 모델은 텍스트로 JSON을 생성하며 Worker가 스키마, 원래 닉네임, 전달한 출처 ID를 검사한다. 결과 이력의 `suppliedSourceIds`는 모델에 전달한 출처를, `generationUsage`는 각 생성의 실제 입력·출력 토큰 수와 서버 소요 시간(초)을 기록한다. 텍스트 전체가 단일 Markdown JSON 코드 블록이면 경계만 제거하고 같은 검사를 수행하며, 해당 생성의 `jsonFenceRemoved`를 `true`로 기록한다.

### 추론 호스트의 서비스 구성

기존 시스템 unit의 사용자 및 `ai.slice` 자원 한도를 상속한다. [서비스 프로그램](../../server/local-llm/server.py)은 `/opt/nickname-llm/server.py`, [systemd drop-in](../../server/local-llm/40-local-4b.conf)은 `/etc/systemd/system/qwen-coder.service.d/40-local-4b.conf`에 설치한다. 같은 `/opt/nickname-llm` 디렉터리의 `bin/`과 `runtime/`에는 llama.cpp b12559의 Ubuntu x64 CUDA 12.8 실행 파일과 라이브러리를 둔다. `weights.gguf`는 Unsloth Qwen3-4B-Instruct-2507 Q4_K_M 파일이며 SHA-256은 `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597`이다.

설치 경로를 갱신할 때는 가중치·`bin/`·`runtime/`을 새 경로에 먼저 배치하고 서비스 사용자에게 읽기·실행 권한이 있는지 확인한다.

`systemctl enable qwen-coder.service`로 부팅 시 기동을 설정한다. 서비스는 GPU에서 준비용 추론을 마친 후 systemd에 준비 완료를 알린다. 엔진이 종료되면 systemd가 서비스를 다시 시작한다. `systemctl is-enabled qwen-coder`, `systemctl is-active qwen-coder`, `curl -fsS http://127.0.0.1:8088/health`로 상태를 확인한다. 응답의 `rss_mib`는 추론 프로세스의 RSS이며, 이전 PyTorch 전용 지표인 `gpu_peak_allocated_mib` 값은 이 엔진에서 `null`이다.

## 해석과 실행 한도

`no_search`는 모델 자체 지식, `backend_retrieval`은 Worker의 사전 검색, `model_tool_call`은 모델이 요청한 도구를 사용한다. 세 번째 모드는 자료 수집과 최종 JSON 생성을 분리한다. `web_open(sourceId)`에서 읽는 자료는 SearXNG가 반환한 발췌문이다. 서버가 원문 페이지에 직접 접속하는 단계는 없다. 선검색에는 닉네임과 고정 언어 `ko`, 도구 검색에는 모델이 만든 질의와 언어만 전달되므로 검색 엔진의 데이터 처리 조건을 확인한다. [SearXNG 검색 API](https://docs.searxng.org/dev/search_api.html)

모델이 도구를 지원한다고 광고한 상태와 해당 케이스의 실제 도구 성공 여부를 각각 기록한다. 스키마 기반 출력을 거부하는 서버에는 제한적으로 JSON 모드를 시도하며, 응답은 양쪽 모두 같은 스키마·닉네임·인용 ID 검사를 거친다. 스키마를 만족한 결과의 판단 근거와 인용의 정확성은 별도 검수 대상이다. `null` 점수는 평균의 분모에서 제외한다. 사람의 기대 근거와 점수는 각 케이스의 `reference`에 보존한다. 평균 점수는 모델이 산정한 추가 검토 필요성의 분포로 해석한다. [Ollama 구조화 출력](https://docs.ollama.com/capabilities/structured-outputs) · [Ollama 도구 호출](https://docs.ollama.com/capabilities/tool-calling) · [llama.cpp 서버](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)

사용자당 대기·진행 중인 Run을 3개까지 허용한다. 한 케이스에는 총 5분, 검색 2회, 도구 호출 4회 상한이 있다. Worker는 30초 lease와 1초 heartbeat를 사용한다. 자동 시도는 한 차례의 작업당 3회, 명시적 재실행을 포함한 케이스별 누적 시도는 12회로 제한한다. 실행권을 잃은 Worker의 뒤늦은 쓰기를 거부한다. 모델이 요청을 받은 직후 Worker가 종료되면 복구 중 같은 추론 계산이 다시 발생할 수 있다. 취소는 DB에서 남은 케이스를 즉시 종료하고, 진행 중 HTTP 요청을 중단한다. 실제 엔진에서 GPU 연산을 해제하는 시점은 해당 엔진의 연결 종료 처리에 따른다.

## 통합 검증

격리된 PostgreSQL과 Fake HTTP Provider로 실제 세션·API·독립 Worker를 확인하는 suite 이름은 `nickname-evaluation`이다. 저장소 통합 환경에서는 `npm run test:integration:suite -- nickname-evaluation`로 실행한다. [데이터셋 검증과 출처](../../benchmarks/nickname-evaluation/README.md)에는 데이터 양식과 조사 자료 검증 명령이 있다. Web 단독 화면 검증은 `npm run dev:mock -w apps/web`로 실행하며 화면과 내보내기 결과에 모의 실행임을 표시한다.

## 운영 전 검증

일반 릴리스는 API와 기존 6개 Worker의 고정 Quadlet 구성을 검사한다. 현재 구성에서 실험실의 기본값은 비활성이며 추가 Worker를 자동 기동하지 않는다. 운영 활성화 전 다음 항목을 검증한다.

- 실제 API·Worker 실행 위치에서 모델 ID, 구조화 JSON, 도구 호출, SearXNG JSON 형식, 검색 출처를 1개·10개 실행으로 확인한다. 모델·검색 서비스는 사설 네트워크로 접근을 제한하고, 추론 서버 자체의 동시 실행 제한과 GPU 메모리·취소 동작을 확인한다.
- 별도 Worker unit의 전용 환경 파일과 리소스 한도를 구성한다. 기존 Worker 공용 환경 파일에 모델 비밀 값을 배포하지 않는다. 새 unit을 정식 topology에 편입할 때 drain·백업·migration·재기동·불변 이미지 확인·전체 health 검사를 함께 검증한다.
- 초기 Lab migration은 역할 enum 추가와 실험용 테이블·인덱스 생성으로 구성되며, 후속 정리 migration은 위 정리·복구 절차를 적용한다. 신규 역할을 부여하기 전에 Web과 모든 기존 API 인스턴스가 새 역할을 학생 권한으로 처리하는지 확인한다. writer 중단·전환, 백업 복원, 최대 10,000건 저장·내보내기의 메모리, DB 용량과 데이터 보존 기간을 점검한다. 내보내기는 API 프로세스당 한 건을 처리하며 결과와 발췌문을 응답 생성 중 메모리에 적재한다.
- 운영 migration은 기존 릴리스 절차에서 수행한다. migration 시도 이후 복구는 기존 runbook의 forward-fix 또는 데이터 복원 절차를 따른다. [배포 및 복구 절차](deployment.md)

## 다음 연구 단계

Phase 1은 데이터 등록과 평가 실행 기반이다. 능동적 인터넷 검색 확대, 난독화 해석 개선, Human Evaluation, LoRA·QLoRA는 후속 개발 범위이다. 사람이 작성한 데이터와 family·split의 검토를 완료한 뒤 실제 소형 모델·검색 서비스로 지연, 토큰 한도, 출처 인용, 정상·모호 사례의 판단 유보를 측정한다. 기대 점수와의 차이, 허용 범위, 근거의 검증 가능성, 판단 유보율을 함께 고려한 평가 지표와 검수 기준을 확정한다. 모델 파인튜닝·학습용 export·학습 실행은 이번 구현 범위에 포함하지 않는다.
