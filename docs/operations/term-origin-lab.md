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

1. **닉네임 직접 입력**에서 닉네임과 시스템 프롬프트를 입력하고 **검색 후 평가**를 선택한다. 단건 실행은 데이터셋 등록 없이 시작한다. 같은 계정에서 같은 닉네임으로 재실행하면 같은 케이스 ID를 유지하므로 두 실행의 프롬프트와 판정 근거를 비교할 수 있다.
2. **데이터셋 실험**에서는 [기준 JSONL](../../benchmarks/term-origins/benchmark-500.jsonl)을 업로드한다. UTF-8 파일의 500행은 각각 고유한 `id`와 `nickname`을 갖는다. 연구용 라벨은 업로드 대상에서 제외한다.
3. 시스템 프롬프트, 모델, 검색 모드, 생성 설정과 크기를 선택한다. 미리보기에서 케이스를 지정하거나 파일 순서를 사용한다. 데이터셋은 등록 이후 수정 경로가 없으며 재업로드한 다른 내용은 별도의 스냅샷으로 저장된다.
4. Run을 생성하면 API가 실행 ID를 반환한다. 진행 중 창을 닫아도 Worker가 케이스별 결과를 저장한다. 실험을 다시 열어 실패 건 재실행, ID별 비교, JSON·JSONL·CSV 다운로드를 수행한다.

## 상시 4B 서버 연결

전시용 추론 서비스에는 `LAB_MODEL_PROVIDER=transformers-generate`, `LAB_MODEL=Qwen3-4B-Instruct-2507-Q4_K_M`, `LAB_CONCURRENCY=1`을 사용한다. API와 Worker에서 같은 사설 서비스 루트에 접근할 수 있어야 한다. 개발 환경에서는 SSH 로컬 포워딩으로 원격 루프백 포트에 연결하고, `LAB_MODEL_URL`을 터널의 로컬 주소로 지정할 수 있다. API와 Worker가 컨테이너 안에 있으면 각각의 네트워크에서 주소가 도달 가능한지 확인한다.

모델 서버의 `qwen-coder.service`는 llama.cpp CUDA로 Q4_K_M 가중치를 실행한다. 호환 HTTP 서비스는 루프백의 8088번 포트를 사용하고 llama.cpp에는 전용 Unix 소켓으로 연결한다. `transformers-generate`는 이 HTTP 요청 형식을 지정한다. 신규 실행에는 `/health`에서 읽은 모델 ID를 사용한다. 이전 실험의 모델 ID는 당시 실행 기록에 보존된다.

Worker는 `GET /health`에서 모델 ID, 토큰 한도, 사용 중 여부와 `supports_system_prompt: true`를 확인한다. `POST /generate`의 `system_prompt`에는 실험 지시 원문을, `prompt`에는 케이스·출력 형식·검색 발췌문을 담는다. 모델에는 각각 `system`과 `user` 메시지로 전달한다. 기존 호출자가 시스템 지시를 생략하면 서버 기본 지시를 사용한다. 생성은 greedy 방식이고 서버 한도는 입력 1,024토큰, 출력 256토큰, 생성 시간 90초이다. 전체 입력에는 서버 지시, 케이스, 출력 형식, 검색 발췌문도 포함된다. 긴 프롬프트가 한도를 초과하면 케이스 실패로 기록한다.

기본 검색 방식은 Worker 선검색이다. 검색 서비스 연결에 실패하면 검색 모드를 **검색 없이 평가**로 변경하여 별도 실행을 생성할 수 있다. 단건 선검색에서는 제목이나 발췌문에 닉네임이 있는 결과를 수집한다. 일치하는 발췌문이 없으면 판단 보류를 요구하며, 사용할 발췌문 0건과 모델의 출처 미인용을 구분해 표시한다. 이 서버에서 선택 가능한 검색 모드는 `no_search`와 `backend_retrieval`이다. Worker는 선검색 자료 중 입력 예산에 맞는 발췌문을 최대 두 건까지 전달한다. 이 어댑터는 시간 제한 안에서 JSON을 완성할 수 있도록 한 줄 150토큰 이내, 설명 필드당 6단어 이내의 응답을 요청한다. 모델은 텍스트로 JSON을 생성하며 Worker가 스키마, 케이스 식별자, 전달한 출처 ID를 검사한다. 결과 이력의 `suppliedSourceIds`는 모델에 전달한 출처를, `generationUsage`는 각 생성의 실제 입력·출력 토큰 수와 서버 소요 시간(초)을 기록한다. 텍스트 전체가 단일 Markdown JSON 코드 블록이면 경계만 제거하고 같은 검사를 수행하며, 해당 생성의 `jsonFenceRemoved`를 `true`로 기록한다.

### 추론 호스트의 서비스 구성과 복구

기존 시스템 unit의 사용자 및 `ai.slice` 자원 한도를 상속한다. [서비스 프로그램](../../server/local-llm/server.py)은 `/opt/term-origin-llm/server.py`, [systemd drop-in](../../server/local-llm/40-local-4b.conf)은 `/etc/systemd/system/qwen-coder.service.d/40-local-4b.conf`에 설치한다. 같은 `/opt/term-origin-llm` 디렉터리의 `bin/`과 `runtime/`에는 llama.cpp b12559의 Ubuntu x64 CUDA 12.8 실행 파일과 라이브러리를 둔다. `weights.gguf`는 Unsloth Qwen3-4B-Instruct-2507 Q4_K_M 파일이며 SHA-256은 `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597`이다.

`systemctl enable qwen-coder.service`로 부팅 시 기동을 설정한다. 서비스는 GPU에서 준비용 추론을 마친 후 systemd에 준비 완료를 알린다. 엔진이 종료되면 systemd가 서비스를 다시 시작한다. `systemctl is-enabled qwen-coder`, `systemctl is-active qwen-coder`, `curl -fsS http://127.0.0.1:8088/health`로 상태를 확인한다. 응답의 `rss_mib`는 추론 프로세스의 RSS이며, 이전 PyTorch 전용 지표인 `gpu_peak_allocated_mib` 값은 이 엔진에서 `null`이다.

기존 수동 기동 7B 구성으로 복구할 때는 4B drop-in을 설치한 상태에서 `systemctl disable qwen-coder.service`로 부팅 연결을 먼저 해제한다. 그 뒤 위의 `40-local-4b.conf`만 제거하고 `systemctl daemon-reload`, `systemctl restart qwen-coder.service`를 실행한다. `/health`에 `Qwen2.5-Coder-7B-Instruct`가 표시되고 `/generate`가 응답하는지 확인한다. 개발 환경의 API와 Worker에는 복구한 모델 ID를 `LAB_MODEL`로 지정한다. 운영 4B 구성은 지정된 Qwen3 모델 ID를 검사한다.

## 해석과 실행 한도

`no_search`는 모델 자체 지식, `backend_retrieval`은 Worker의 사전 검색, `model_tool_call`은 모델이 요청한 도구를 사용한다. 세 번째 모드는 자료 수집과 최종 JSON 생성을 분리한다. `web_open(sourceId)`에서 읽는 자료는 SearXNG가 반환한 발췌문이다. 서버가 원문 페이지에 직접 접속하는 단계는 없다. 검색에는 사례의 어구 또는 모델이 만든 질의와 언어가 전달되므로 검색 엔진의 데이터 처리 조건을 확인한다. [SearXNG 검색 API](https://docs.searxng.org/dev/search_api.html)

모델이 도구를 지원한다고 광고한 상태와 해당 케이스의 실제 도구 성공 여부를 각각 기록한다. 스키마 기반 출력을 거부하는 서버에는 제한적으로 JSON 모드를 시도하며, 응답은 양쪽 모두 같은 스키마·케이스 ID·인용 ID 검사를 거친다. 스키마를 만족한 결과의 어원과 원문 인용의 정확성은 별도 검수 대상이다. 점수가 `null`이거나 모델이 판단을 보류한 결과는 평균에서 제외한다. 이전 응답에 유보 표시와 숫자 점수가 함께 있으면 처리 기록과 JSON에서 원점수를 확인할 수 있다. 사례별 출처와 해독 후보는 별도 라벨 파일에 있다. 평균 점수는 모델이 산정한 추가 검토 필요성의 분포로 해석한다. [Ollama 구조화 출력](https://docs.ollama.com/capabilities/structured-outputs) · [Ollama 도구 호출](https://docs.ollama.com/capabilities/tool-calling) · [llama.cpp 서버](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)

사용자당 대기·진행 중인 Run을 3개까지 허용한다. 한 케이스에는 총 5분, 검색 2회, 도구 호출 4회 상한이 있다. Worker는 30초 lease와 1초 heartbeat를 사용한다. 자동 시도는 한 차례의 작업당 3회, 명시적 재실행을 포함한 케이스별 누적 시도는 12회로 제한한다. 실행권을 잃은 Worker의 뒤늦은 쓰기를 거부한다. 모델이 요청을 받은 직후 Worker가 종료되면 복구 중 같은 추론 계산이 다시 발생할 수 있다. 취소는 DB에서 남은 케이스를 즉시 종료하고, 진행 중 HTTP 요청을 중단한다. 실제 엔진에서 GPU 연산을 해제하는 시점은 해당 엔진의 연결 종료 처리에 따른다.

## 통합 검증

격리된 PostgreSQL과 Fake HTTP Provider로 실제 세션·API·독립 Worker를 확인하는 suite 이름은 `term-origins`다. 저장소 통합 환경에서는 `npm run test:integration:suite -- term-origins`로 실행한다. [데이터셋 검증과 출처](../../benchmarks/term-origins/README.md)에는 재생성 명령과 분포가 있다. Web 단독 화면 검증은 `npm run dev:mock -w apps/web`로 실행하며 화면과 내보내기 결과에 모의 실행임을 표시한다.

## 운영 4B 실험실 활성화

운영자는 관리자 또는 베타 계정으로 평가를 실행하고 결과를 검토한다. `abstained`는 모델의 판단 보류 여부이고 `controversyScore`는 추가 검토 필요성이다. 두 값을 함께 표시한다. 구판 데이터셋으로 재실행하면 원래 문맥을 모델에 전달한다. 닉네임 판본에서는 닉네임과 케이스 식별 정보만 전달한다.

### 호스트와 SSH 키

`gp-lab-tunnel`은 운영 Pod의 `127.0.0.1:18088`에서 `gameserver`의 `127.0.0.1:8088`로 SSH 연결을 전달한다. SSH 목적지는 Pod에서 보이는 `host.containers.internal:5050`이다. API와 `gp-worker-benchmark`는 Pod의 루프백을 공유한다.

1. 서버 관리자는 호스트에서 `qwen-coder.service`의 활성 상태와 `curl -fsS http://127.0.0.1:8088/health`의 모델 ID를 확인한다. 전용 SSH 계정 `pcu-lab-forward`에 공개 키 인증을 설정한다. 해당 계정의 sshd 설정은 `AllowTcpForwarding local`, `PermitOpen 127.0.0.1:8088`, `AllowStreamLocalForwarding no`, `MaxSessions 0`으로 제한한다. 기존 관리자 세션을 유지한 상태에서 SSH 허용 목록에 이 계정을 추가한다. `sshd -t`와 사용자별 `sshd -T -C`로 구문과 유효 설정을 확인한 뒤 SSH 서비스를 reload한다. 새 연결에서 `song`과 `gh-deploy` 로그인을 각각 확인한다.
2. 배포 계정은 `${DEPLOY_DIR}/runtime-env/lab-ssh`를 권한 0700으로 만들고 전용 Ed25519 키를 `identity`에 생성한다. 개인 키 권한은 0600으로 유지한다. 서버 관리자는 공개 키를 위 계정의 `authorized_keys`에 등록한다.
3. 서버 관리자가 호스트에서 확인한 Ed25519 공개 키로 같은 디렉터리에 `known_hosts`를 작성한다. 한 줄 형식은 `[host.containers.internal]:5050 ssh-ed25519 <호스트 공개 키>`이다. 터널과 릴리스 사전 검사가 이 디렉터리를 읽기 전용으로 사용한다.

### Lab 전용 검색 서비스

배포 계정으로 API 호스트의 기존 Pod에 검색 서비스를 설치한다. 배포 경로 아래 `quadlet/lab-search`에 공식 이미지 digest를 지정한 unit과 JSON 검색 설정이 있다. 컨테이너는 Pod 루프백의 18888번 포트에서 요청을 받고 Naver, Brave와 DuckDuckGo에 HTTPS로 접속한다. 유료 검색 API 키는 사용하지 않는다. [SearXNG 컨테이너 설치](https://docs.searxng.org/admin/installation-docker.html) · [검색 API](https://docs.searxng.org/dev/search_api.html)

```bash
cd "${DEPLOY_DIR:-/srv/graduationproject_v2}/quadlet/lab-search"
install -d -m 700 ~/.config/pcu-lab-search ~/.config/containers/systemd
install -m 644 settings.yml ~/.config/pcu-lab-search/settings.yml
(umask 077; test -s ~/.config/pcu-lab-search/search.env || openssl rand -hex 32 | sed 's/^/SEARXNG_SECRET=/' > ~/.config/pcu-lab-search/search.env)
install -m 600 gp-lab-search.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start gp-lab-search.service
```

기존 실험실에서는 모델 어댑터를 먼저 갱신하고 `/health`의 시스템 지시 지원 여부를 확인한다. 다음 릴리스 기동 전에 `runtime-env/lab.env`에 `LAB_SEARXNG_URL=http://127.0.0.1:18888`을 설정한다. 검색 URL을 생략한 기존 환경 파일은 검색 없는 실행을 지원한다. API와 Worker 기동 후 아래 명령으로 각 클라이언트에서 한국어 질의의 첫 발췌문을 확인한다.

```bash
for client in gp-api gp-worker-benchmark; do
  podman exec "$client" node --input-type=module -e '
    const url = new URL("/search", process.env.LAB_SEARXNG_URL);
    url.search = new URLSearchParams({q: "계집", language: "ko", format: "json", categories: "general"});
    const response = await fetch(url, {signal: AbortSignal.timeout(10000)});
    if (!response.ok) throw Error("HTTP " + response.status);
    const hit = (await response.json()).results.find(row => row.content?.trim());
    if (!hit) throw Error("검색 발췌문 0건");
    console.log(hit.title, hit.content);
  '
done
```

### 배포 환경과 Quadlet 최초 구성

기존 구성을 유지한 상태에서 이 변경이 포함된 검토 완료 리비전을 표준 절차로 먼저 배포한다. 이후 같은 리비전·이미지를 사용하여 실험실을 활성화한다. 환경 파일을 준비하고 Quadlet 정의를 설치하는 동안 다른 배포와 호스트 재시작을 중지한다. [배포 및 복구 절차](deployment.md)

1. 배포 계정은 `runtime-env/common.env`의 `DATABASE_URL` 한 줄과 아래 설정을 권한 0600의 `runtime-env/lab.env.next`에 저장한다. DB 연결값은 기존 값을 그대로 복사한다. 운영 API와 평가 Worker가 같은 파일을 사용하며 검사기가 두 DB 연결값의 일치를 확인한다.

   ```dotenv
   LAB_ENABLED=true
   LAB_MODEL_PROVIDER=transformers-generate
   LAB_MODEL=Qwen3-4B-Instruct-2507-Q4_K_M
   LAB_MODEL_URL=http://127.0.0.1:18088
   LAB_CONCURRENCY=1
   LAB_SEARXNG_URL=http://127.0.0.1:18888
   ```

2. 첫 번째 `Deploy Release`는 `operation=release`, `activate_lab=false`로 실행한다. `runtime-env/lab.env`와 두 lab Quadlet이 없는 상태에서 배포 성공을 확인하고 병합 SHA·이미지 digest·실행 링크를 기록한다.
3. 같은 `master` SHA에서 `operation=release`, `activate_lab=true`로 두 번째 `Deploy Release`를 실행한다. 첫 활성화의 설치와 사전 검사는 이 실행에 포함된다. 이전 배포 기록과 실행 중인 컨테이너의 SHA·digest가 일치해야 진행한다. 배포 계정의 복구 디렉터리 `cutover-state/recovery-<run_id>-<attempt>`에 기존 API 정의와 실행 중인 서비스, `lab.env`와 두 lab 정의의 부재를 기록한다.
4. 릴리스는 기존 호스트 설정으로 렌더링한 `gp-api.container`, `gp-lab-tunnel.container`, `gp-worker-benchmark.container`와 준비한 환경 파일을 설치하고 user manager를 reload한다. `release-artifact-preflight phase2`가 운영 Pod에서 SSH 키·호스트 키·모델 ID·토큰 한도를 검사한다. 통과하면 터널과 Worker를 순서대로 시작하고 Worker의 모델 연결을 검사한다.
5. 기존 복구 기록을 유지한 채 DB 백업·앱 중지·migration·앱 기동을 수행한다. Web 게시 전과 최종 점검 시 API와 Worker 각각의 모델 상태와 실행 이미지 digest를 확인한다. 활성화가 완료되면 준비용 `runtime-env/lab.env.next`를 정리한다. 이후 일반 배포는 `activate_lab=false`와 설치된 `lab.env`를 사용한다.

### 최초 활성화 실패 시 복구

- 복구 기록 작성 전 실패하면 기존 API·환경 정의를 유지한다. 설정 설치 중에 실패하거나 사전 검사·DB 백업·앱 중지 이후 장애가 발생하면 해당 실행의 `migration-attempted` 기록을 확인한다.
- Migration 시도 전에는 표준 릴리스가 기존 Pages 상태를 검증한 뒤 새 Worker와 터널을 중지한다. 기존 API 정의를 복원하고 추가한 두 정의와 `lab.env`를 제거한 후 user manager를 reload한다. 기존 API의 이미지·비활성 설정·상태 응답과 기존 Worker의 실행 상태를 확인한다. 운영자가 설치 파일을 별도로 변경한 경우 복구를 중단하므로 해당 실행의 기록과 실제 파일을 대조한다.
- `migration-attempted`가 있으면 DB 이력과 실제 schema를 확인하고 전진 수정 또는 데이터 복원 절차를 따른다. [배포 및 복구 절차](deployment.md)

### 인증 사용자 검증

베타 계정으로 `/lab/term-origins`에서 `계집`을 입력하고 같은 모델·지시로 검색 전후를 비교한다. 현대 비하 용례가 포함된 발췌문의 ID, 논란 가능성 점수와 판정 이유를 대조한다. 시스템 지시만 수정해 다시 실행하고 두 결과의 케이스 ID 및 프롬프트를 확인한다. 중립 닉네임과 근거가 희박한 조어로 오탐과 판단 보류도 확인한다.

**데이터셋 실험**에서 닉네임 JSONL 500행을 등록하고 검색 없음·온도 0·출력 한도 256으로 1건과 10건을 차례로 실행한다. 두 실행이 각각 1/1건과 10/10건 성공하고 실패가 0건인지 확인한다. 결과 화면의 케이스 ID와 JSON 내보내기의 ID·건수가 일치하면 최초 사용 검증을 완료한다. 배포 기록에 계정 역할, 두 실행 ID, 배포 SHA·이미지 digest와 두 릴리스 링크를 남긴다. 결과를 검토할 때는 일반 표현, 문맥에 따른 비하 표현, 명시적 욕설의 오탐·누락·판단 보류를 구분한다.
