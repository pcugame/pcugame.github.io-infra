# 어원·사회언어학 평가 실험실

`/lab/term-origins`에서 `BETA_TESTER`와 `ADMIN`이 문맥별 어구 분석을 실행한다. 관리자는 관리자 화면에서 일반 사용자를 검색하여 베타 권한을 부여·회수한다. 동일 세션의 다음 요청부터 변경된 권한을 적용한다. 변경 기록은 PostgreSQL의 `LabRoleAudit`에 관리자 ID, 대상 ID, 변경 전후 역할, 시각을 저장한다. 실험과 데이터셋의 열람 범위는 소유자와 관리자다.

## 로컬 구성

API와 Benchmark Worker에는 같은 개발용 PostgreSQL, 설치된 모델 이름, provider와 endpoint를 설정한다. 기존 API의 Google 로그인·쿠키·Origin 설정을 사용한다. API 실행에 필요한 환경은 [저장소 개발 안내](../../README.md)에 있다. Worker는 DB와 아래 실험실 설정만 읽는다.

| 환경 변수 | 설정 |
| --- | --- |
| `LAB_ENABLED` | 기본 비활성. API와 Worker를 사용할 때 `true` |
| `LAB_MODEL_PROVIDER` | `ollama` 또는 `openai-compatible` |
| `LAB_MODEL` | 추론 서버에 이미 로드할 수 있는 모델의 정확한 ID |
| `LAB_MODEL_URL` | Ollama의 서비스 루트 또는 호환 서버의 API base URL(통상 `/v1` 포함) |
| `LAB_MODEL_API_KEY` | 추론 서버가 인증을 요구할 때 설정하는 비밀 값 |
| `LAB_SEARXNG_URL` | JSON 검색을 허용한 SearXNG의 서비스 루트 |
| `LAB_CONCURRENCY` | 기본 1, 허용 범위 1~4. 같은 DB를 처리하는 모든 Worker에 같은 값을 적용 |
| `DATABASE_URL` | 해당 환경의 실험 테이블에 접근 가능한 PostgreSQL 연결 |

개발 DB에 저장소 migration을 적용한 뒤 API·Web과 별도 터미널에서 `npm run worker:benchmark -w apps/api`를 실행한다. 빌드된 API 이미지의 Worker 진입점은 `node dist/benchmark-worker.js`이다. Worker는 수신 포트 없이 작업을 조회한다. API는 서버 상태 요청 시 메타데이터만 조회한다. 모델 URL, API key, 데이터베이스 자격 증명은 서버 환경에만 둔다.

1. 로그인 후 실험실에 [기준 JSONL](../../benchmarks/term-origins/benchmark-500.jsonl)을 업로드한다. UTF-8 파일에는 다섯 범주와 네 언어 그룹의 지정 분포를 충족하는 500행이 있어야 한다.
2. 시스템 프롬프트, 모델, 검색 모드, 생성 설정과 크기를 선택한다. 미리보기에서 케이스를 지정하거나 파일 순서를 사용한다. 데이터셋은 등록 이후 수정 경로가 없으며 재업로드한 다른 내용은 별도의 스냅샷으로 저장된다.
3. Run을 생성하면 API가 실행 ID를 반환한다. 진행 중 창을 닫아도 Worker가 케이스별 결과를 저장한다. 실험을 다시 열어 실패 건 재실행, ID별 비교, JSON·JSONL·CSV 다운로드를 수행한다.

## 해석과 실행 한도

`no_search`는 모델 자체 지식, `backend_retrieval`은 Worker의 사전 검색, `model_tool_call`은 모델이 요청한 도구를 사용한다. 세 번째 모드는 자료 수집과 최종 JSON 생성을 분리한다. `web_open(sourceId)`에서 읽는 자료는 SearXNG가 반환한 발췌문이다. 서버가 원문 페이지에 직접 접속하는 단계는 없다. 검색에는 사례의 어구 또는 모델이 만든 질의와 언어가 전달되므로 검색 엔진의 데이터 처리 조건을 확인한다. [SearXNG 검색 API](https://docs.searxng.org/dev/search_api.html)

모델이 도구를 지원한다고 광고한 상태와 해당 케이스의 실제 도구 성공 여부를 각각 기록한다. 스키마 기반 출력을 거부하는 서버에는 제한적으로 JSON 모드를 시도하며, 응답은 양쪽 모두 같은 스키마·케이스 ID·인용 ID 검사를 거친다. 스키마를 만족한 결과의 어원과 원문 인용의 정확성은 별도 검수 대상이다. `null` 점수는 평균의 분모에서 제외한다. 기준 파일 500건의 검증 점수와 참고 출처는 비어 있으므로 평균 점수는 모델 출력의 분포로 해석한다. [Ollama 구조화 출력](https://docs.ollama.com/capabilities/structured-outputs) · [Ollama 도구 호출](https://docs.ollama.com/capabilities/tool-calling) · [llama.cpp 서버](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)

사용자당 대기·진행 중인 Run을 3개까지 허용한다. 한 케이스에는 총 5분, 검색 2회, 도구 호출 4회 상한이 있다. Worker는 30초 lease와 1초 heartbeat를 사용한다. 자동 시도는 한 차례의 작업당 3회, 명시적 재실행을 포함한 케이스별 누적 시도는 12회로 제한한다. 실행권을 잃은 Worker의 뒤늦은 쓰기를 거부한다. 모델이 요청을 받은 직후 Worker가 종료되면 복구 중 같은 추론 계산이 다시 발생할 수 있다. 취소는 DB에서 남은 케이스를 즉시 종료하고, 진행 중 HTTP 요청을 중단한다. 실제 엔진에서 GPU 연산을 해제하는 시점은 해당 엔진의 연결 종료 처리에 따른다.

## 통합 검증

격리된 PostgreSQL과 Fake HTTP Provider로 실제 세션·API·독립 Worker를 확인하는 suite 이름은 `term-origins`다. 저장소 통합 환경에서는 `npm run test:integration:suite -- term-origins`로 실행한다. [데이터셋 검증과 출처](../../benchmarks/term-origins/README.md)에는 재생성 명령과 분포가 있다. Web 단독 화면 검증은 `npm run dev:mock -w apps/web`로 실행하며 화면과 내보내기 결과에 모의 실행임을 표시한다.

## 운영 전 검증

일반 릴리스는 API와 기존 6개 Worker의 고정 Quadlet 구성을 검사한다. 현재 구성에서 실험실의 기본값은 비활성이며 추가 Worker를 자동 기동하지 않는다. 운영 활성화 전 다음 항목을 검증한다.

- 실제 API·Worker 실행 위치에서 모델 ID, 구조화 JSON, 도구 호출, SearXNG JSON 형식, 검색 출처를 1개·10개 실행으로 확인한다. 모델·검색 서비스는 사설 네트워크로 접근을 제한하고, 추론 서버 자체의 동시 실행 제한과 GPU 메모리·취소 동작을 확인한다.
- 별도 Worker unit의 전용 환경 파일과 리소스 한도를 구성한다. 기존 Worker 공용 환경 파일에 모델 비밀 값을 배포하지 않는다. 새 unit을 정식 topology에 편입할 때 drain·백업·migration·재기동·불변 이미지 확인·전체 health 검사를 함께 검증한다.
- migration은 역할 enum 추가와 실험용 테이블·인덱스 생성으로 구성된다. 신규 역할을 부여하기 전에 Web과 모든 기존 API 인스턴스가 새 역할을 학생 권한으로 처리하는지 확인한다. 기존 writer 호환성, 백업 복원, 500건 저장·내보내기의 메모리, DB 용량과 데이터 보존 기간을 점검한다. 내보내기는 API 프로세스당 한 건을 처리하며 결과와 발췌문을 응답 생성 중 메모리에 적재한다.
- 운영 migration은 기존 릴리스 절차에서 수행한다. migration 시도 이후 복구는 기존 runbook의 forward-fix 또는 데이터 복원 절차를 따른다. [배포 및 복구 절차](deployment.md)
