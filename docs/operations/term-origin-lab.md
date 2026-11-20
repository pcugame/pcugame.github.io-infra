# 어원·사회언어학 평가 실험실

`/lab/term-origins`에서 `BETA_TESTER`와 `ADMIN`이 닉네임의 변형·은어·모욕 가능성을 평가한다. 관리자는 관리자 화면에서 일반 사용자를 검색하여 베타 권한을 부여·회수한다. 동일 세션의 다음 요청부터 변경된 권한을 적용한다. 변경 기록은 PostgreSQL의 `LabRoleAudit`에 관리자 ID, 대상 ID, 변경 전후 역할, 시각을 저장한다. 실험과 데이터셋의 열람 범위는 소유자와 관리자다.

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

1. 로그인 후 실험실에 [기준 JSONL](../../benchmarks/term-origins/benchmark-500.jsonl)을 업로드한다. UTF-8 파일의 500행은 각각 고유한 `id`와 `nickname`을 갖는다. 연구용 라벨은 업로드 대상에서 제외한다.
2. 시스템 프롬프트, 모델, 검색 모드, 생성 설정과 크기를 선택한다. 미리보기에서 케이스를 지정하거나 파일 순서를 사용한다. 데이터셋은 등록 이후 수정 경로가 없으며 재업로드한 다른 내용은 별도의 스냅샷으로 저장된다.
3. Run을 생성하면 API가 실행 ID를 반환한다. 진행 중 창을 닫아도 Worker가 케이스별 결과를 저장한다. 실험을 다시 열어 실패 건 재실행, ID별 비교, JSON·JSONL·CSV 다운로드를 수행한다.

## 상시 4B 서버 연결

전시용 추론 서비스에는 `LAB_MODEL_PROVIDER=transformers-generate`, `LAB_MODEL=Qwen3-4B-Instruct-2507-Q4_K_M`, `LAB_CONCURRENCY=1`을 사용한다. API와 Worker에서 같은 사설 서비스 루트에 접근할 수 있어야 한다. 개발 환경에서는 SSH 로컬 포워딩으로 원격 루프백 포트에 연결하고, `LAB_MODEL_URL`을 터널의 로컬 주소로 지정할 수 있다. API와 Worker가 컨테이너 안에 있으면 각각의 네트워크에서 주소가 도달 가능한지 확인한다.

모델 서버의 `qwen-coder.service`는 llama.cpp CUDA로 Q4_K_M 가중치를 실행한다. 호환 HTTP 서비스는 루프백의 8088번 포트를 사용하고 llama.cpp에는 전용 Unix 소켓으로 연결한다. `transformers-generate`는 이 HTTP 요청 형식을 지정한다. 신규 실행에는 `/health`에서 읽은 모델 ID를 사용한다. 이전 실험의 모델 ID는 당시 실행 기록에 보존된다.

Worker는 `GET /health`에서 모델 ID와 토큰 한도, 사용 중 여부를 확인한 다음 `POST /generate`로 실험 프롬프트와 출력 토큰 한도를 보낸다. 서버의 시스템 지시는 고정되어 있으며 실험 프롬프트 원문은 사용자 메시지 안에 전달된다. 생성은 greedy 방식이고 서버 한도는 입력 1,024토큰, 출력 256토큰, 생성 시간 90초이다. 전체 입력에는 서버 지시, 케이스, 출력 형식, 검색 발췌문도 포함된다. 긴 프롬프트가 한도를 초과하면 케이스 실패로 기록한다.

이 서버에서 선택 가능한 검색 모드는 `no_search`와 `backend_retrieval`이다. Worker는 선검색 자료 중 입력 예산에 맞는 발췌문을 최대 두 건까지 전달한다. 이 어댑터는 시간 제한 안에서 JSON을 완성할 수 있도록 한 줄 150토큰 이내, 설명 필드당 6단어 이내의 응답을 요청한다. 모델은 텍스트로 JSON을 생성하며 Worker가 스키마, 케이스 식별자, 전달한 출처 ID를 검사한다. 결과 이력의 `suppliedSourceIds`는 모델에 전달한 출처를, `generationUsage`는 각 생성의 실제 입력·출력 토큰 수와 서버 소요 시간(초)을 기록한다. 텍스트 전체가 단일 Markdown JSON 코드 블록이면 경계만 제거하고 같은 검사를 수행하며, 해당 생성의 `jsonFenceRemoved`를 `true`로 기록한다.

### 추론 호스트의 서비스 구성과 복구

기존 시스템 unit의 사용자 및 `ai.slice` 자원 한도를 상속한다. [서비스 프로그램](../../server/local-llm/server.py)은 `/opt/term-origin-llm/server.py`, [systemd drop-in](../../server/local-llm/40-local-4b.conf)은 `/etc/systemd/system/qwen-coder.service.d/40-local-4b.conf`에 설치한다. 같은 `/opt/term-origin-llm` 디렉터리의 `bin/`과 `runtime/`에는 llama.cpp b12559의 Ubuntu x64 CUDA 12.8 실행 파일과 라이브러리를 둔다. `weights.gguf`는 Unsloth Qwen3-4B-Instruct-2507 Q4_K_M 파일이며 SHA-256은 `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597`이다.

`systemctl enable qwen-coder.service`로 부팅 시 기동을 설정한다. 서비스는 GPU에서 준비용 추론을 마친 후 systemd에 준비 완료를 알린다. 엔진이 종료되면 systemd가 서비스를 다시 시작한다. `systemctl is-enabled qwen-coder`, `systemctl is-active qwen-coder`, `curl -fsS http://127.0.0.1:8088/health`로 상태를 확인한다. 응답의 `rss_mib`는 추론 프로세스의 RSS이며, 이전 PyTorch 전용 지표인 `gpu_peak_allocated_mib` 값은 이 엔진에서 `null`이다.

기존 수동 기동 7B 구성으로 복구할 때는 4B drop-in을 설치한 상태에서 `systemctl disable qwen-coder.service`로 부팅 연결을 먼저 해제한다. 그 뒤 위의 `40-local-4b.conf`만 제거하고 `systemctl daemon-reload`, `systemctl restart qwen-coder.service`를 실행한다. `/health`에 `Qwen2.5-Coder-7B-Instruct`가 표시되고 `/generate`가 응답하는지 확인한다. 실험실을 연결하는 환경에서는 API와 Worker의 `LAB_MODEL`도 해당 모델 ID에 맞춘다.

## 해석과 실행 한도

`no_search`는 모델 자체 지식, `backend_retrieval`은 Worker의 사전 검색, `model_tool_call`은 모델이 요청한 도구를 사용한다. 세 번째 모드는 자료 수집과 최종 JSON 생성을 분리한다. `web_open(sourceId)`에서 읽는 자료는 SearXNG가 반환한 발췌문이다. 서버가 원문 페이지에 직접 접속하는 단계는 없다. 검색에는 사례의 어구 또는 모델이 만든 질의와 언어가 전달되므로 검색 엔진의 데이터 처리 조건을 확인한다. [SearXNG 검색 API](https://docs.searxng.org/dev/search_api.html)

모델이 도구를 지원한다고 광고한 상태와 해당 케이스의 실제 도구 성공 여부를 각각 기록한다. 스키마 기반 출력을 거부하는 서버에는 제한적으로 JSON 모드를 시도하며, 응답은 양쪽 모두 같은 스키마·케이스 ID·인용 ID 검사를 거친다. 스키마를 만족한 결과의 어원과 원문 인용의 정확성은 별도 검수 대상이다. `null` 점수는 평균의 분모에서 제외한다. 사례별 출처와 해독 후보는 별도 라벨 파일에 있다. 평균 점수는 모델이 산정한 추가 검토 필요성의 분포로 해석한다. [Ollama 구조화 출력](https://docs.ollama.com/capabilities/structured-outputs) · [Ollama 도구 호출](https://docs.ollama.com/capabilities/tool-calling) · [llama.cpp 서버](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)

사용자당 대기·진행 중인 Run을 3개까지 허용한다. 한 케이스에는 총 5분, 검색 2회, 도구 호출 4회 상한이 있다. Worker는 30초 lease와 1초 heartbeat를 사용한다. 자동 시도는 한 차례의 작업당 3회, 명시적 재실행을 포함한 케이스별 누적 시도는 12회로 제한한다. 실행권을 잃은 Worker의 뒤늦은 쓰기를 거부한다. 모델이 요청을 받은 직후 Worker가 종료되면 복구 중 같은 추론 계산이 다시 발생할 수 있다. 취소는 DB에서 남은 케이스를 즉시 종료하고, 진행 중 HTTP 요청을 중단한다. 실제 엔진에서 GPU 연산을 해제하는 시점은 해당 엔진의 연결 종료 처리에 따른다.

## 통합 검증

격리된 PostgreSQL과 Fake HTTP Provider로 실제 세션·API·독립 Worker를 확인하는 suite 이름은 `term-origins`다. 저장소 통합 환경에서는 `npm run test:integration:suite -- term-origins`로 실행한다. [데이터셋 검증과 출처](../../benchmarks/term-origins/README.md)에는 재생성 명령과 분포가 있다. Web 단독 화면 검증은 `npm run dev:mock -w apps/web`로 실행하며 화면과 내보내기 결과에 모의 실행임을 표시한다.

## 운영 전 검증

일반 릴리스는 API와 기존 6개 Worker의 고정 Quadlet 구성을 검사한다. 현재 구성에서 실험실의 기본값은 비활성이며 추가 Worker를 자동 기동하지 않는다. 운영 활성화 전 다음 항목을 검증한다.

- 실제 API·Worker 실행 위치에서 모델 ID, 구조화 JSON, 도구 호출, SearXNG JSON 형식, 검색 출처를 1개·10개 실행으로 확인한다. 모델·검색 서비스는 사설 네트워크로 접근을 제한하고, 추론 서버 자체의 동시 실행 제한과 GPU 메모리·취소 동작을 확인한다.
- 별도 Worker unit의 전용 환경 파일과 리소스 한도를 구성한다. 기존 Worker 공용 환경 파일에 모델 비밀 값을 배포하지 않는다. 새 unit을 정식 topology에 편입할 때 drain·백업·migration·재기동·불변 이미지 확인·전체 health 검사를 함께 검증한다.
- migration은 역할 enum 추가와 실험용 테이블·인덱스 생성으로 구성된다. 신규 역할을 부여하기 전에 Web과 모든 기존 API 인스턴스가 새 역할을 학생 권한으로 처리하는지 확인한다. 기존 writer 호환성, 백업 복원, 500건 저장·내보내기의 메모리, DB 용량과 데이터 보존 기간을 점검한다. 내보내기는 API 프로세스당 한 건을 처리하며 결과와 발췌문을 응답 생성 중 메모리에 적재한다.
- 운영 migration은 기존 릴리스 절차에서 수행한다. migration 시도 이후 복구는 기존 runbook의 forward-fix 또는 데이터 복원 절차를 따른다. [배포 및 복구 절차](deployment.md)
