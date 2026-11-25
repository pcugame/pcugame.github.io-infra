# 닉네임 조사 행동 LoRA 실험

Qwen3-4B-Instruct-2507의 조사 action, 의미 후보·질의 생성, 자료에 근거한 판단, 불확실성 처리와 JSON 응답을 학습하는 로컬 CLI이다. 원본 가중치는 고정하고 PEFT adapter만 업데이트한다. 개별 은어의 정답 사전을 모델 입력에 제공하지 않는다.

운영 호스트는 `song@gameserver:5050`, 학습 장치는 로컬 랩탑의 Radeon AI PRO R9700이다. 이 디렉터리의 명령에는 운영 접속·배포·서비스 재시작 기능이 없다. 기존 Qwen3-4B-Instruct-2507-Q4_K_M GGUF와 로컬에서 별도로 실행 중인 Qwen3 8B Vulkan 프로세스는 유지한다. 실제 데이터 선별·품질 학습은 후속 작업이며, 이번 검증의 범위는 합성 사례를 이용한 파이프라인 동작이다.

## 실행 구성

| 구성 | 역할 |
| --- | --- |
| `cli.mts prepare` | Human Evaluation train JSONL·provenance 검증과 학습 자료 변환 |
| `lab.py doctor` | 실제 장치·RAM·디스크·프로세스 조사와 GPU 역전파 검사 |
| `lab.py train` | assistant 응답만을 대상으로 한 LoRA 학습, checkpoint 저장·재개 |
| `lab.py register`, `serve` | 별도 모델 등록, 선택한 모델의 루프백 추론 |
| `cli.mts freeze`, `evaluate` | 평가 조건 사전 고정과 A–D 실행 |
| `cli.mts corpus`, `review-template`, `gate` | 검색 replay, 사람 검수, 승격 기준 검증 |
| `cli.mts select`, `lab.py merge` | 로컬 모델 선택 기록, 별도 HF 가중치로 병합 |

Node CLI는 기존 `evaluateResearch` Worker와 공유 Zod 계약을 사용한다. Python 추론 프로세스는 `/health`, `/tokenize`, `/generate`만 제공하며 학습이나 임의 명령 실행 route가 없다. `ResearchTransport`는 실험 CLI의 모델 연결 경계이며 기존 Web API·Worker의 추론 연결 방식은 유지된다.

## 환경 및 설치

원본 모델은 `Qwen/Qwen3-4B-Instruct-2507`, revision은 `cdbee75f17c01a7cc42f958dc650907174af0554`로 고정한다. GGUF에 직접 학습하지 않는다. [Qwen 모델 카드](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507)는 이 모델을 비사고 모드 모델로 명시한다.

초기 환경은 Python 3.12, AMD 배포 PyTorch 2.9.1/ROCm 7.2, Transformers 4.57.3, PEFT 0.18.0이다. [AMD 호환표](https://rocm.docs.amd.com/projects/radeon-ryzen/en/docs-7.2/docs/compatibility/compatibilityrad/native_linux/native_linux_compatibility.html)에 R9700이 포함되며 NixOS는 공식 지원 OS 목록에 없다. 컨테이너도 호스트 kernel/드라이버를 공유하므로 설치 성공을 학습 지원으로 간주하지 않는다. `doctor`의 실제 matmul·backward 검사를 통과해야 학습이 시작된다. [AMD 설치 문서](https://rocm.docs.amd.com/projects/radeon-ryzen/en/docs-7.2/docs/install/installrad/native_linux/install-pytorch.html)의 고정 wheel을 사용한다.

32GB급 VRAM에서는 원본 BF16 가중치와 rank 8 LoRA를 우선한다. 원본 4B 모델의 16비트 가중치에 약 8GB, 추가로 activation·gradient·optimizer 공간이 필요하다. QLoRA/bitsandbytes는 이 ROCm 환경에서 검증하지 않았으므로 선택 시 명시적으로 거부한다. CUDA·ROCm을 혼동하거나 CPU로 자동 전환하지 않는다. FP16/BF16 모두 작은 역전파를 검사하며 실제 학습 precision은 설정으로 고정한다.

컨테이너·Python 라이브러리·원본 모델 cache·adapter·checkpoint와 Docker 빌드 중 임시 사본을 위해 설치 전 45–55GiB 정도의 여유 공간을 계획한다. 변환용 병합 가중치와 GGUF를 함께 보존하면 15GiB 이상을 추가로 확보한다. 이는 계획용 추정치이며 `doctor`의 실제 용량과 학습 시 여유 공간 검사를 우선한다. 학습 기본 사전 검사값은 VRAM 14GiB·디스크 16GiB 여유이다.

모든 Node 명령은 **저장소 루트**에서 실행한다. Docker wrapper의 파일 인수는 **이 실험 디렉터리 기준**이다. `/work`는 호스트의 `experiments/nickname-lora`에 대응한다.

```bash
npm run build -w @pcu/contracts
python3 experiments/nickname-lora/lab.py doctor \
  --output experiments/nickname-lora/artifacts/host-hardware.json
# 호스트 Python에 torch가 없으면 이 명령은 장치 기록 후 exit 2를 반환한다.
docker build -f experiments/nickname-lora/Dockerfile.rocm \
  -t pcu-nickname-lora:rocm7.2 experiments/nickname-lora
experiments/nickname-lora/run-rocm.sh doctor --output artifacts/rocm-hardware.json
```

GPU 검사가 실패하면 원본 4B 모델을 내려받거나 학습을 실행하지 않는다. 드라이버 교체·GPU reset·기존 추론 종료를 자동 수행하지 않는다. 실패 원인, backend stderr와 재현 명령을 남긴 뒤 환경을 별도로 복구한다. `artifacts/`, `data/`, `runs/`, `registry/`는 Git 제외 경로이다. 실험 파일에는 닉네임·검색 자료·검수자 정보가 들어갈 수 있으므로 공개 저장소에 추가하지 않는다.

wrapper는 원본 파일 다운로드에 `HF_HUB_DISABLE_XET=1`, `HF_HUB_DOWNLOAD_TIMEOUT=180`을 기본으로 사용한다. 로컬 검증에서 Xet 병렬 전송과 기본 10초 HTTP 읽기 제한에서 timeout이 반복되어 일반 HTTP 경로와 180초 제한을 선택하였다. 환경변수로 변경할 수 있으며, Xet 사용이 필요한 환경은 `HF_HUB_DISABLE_XET=0 experiments/nickname-lora/run-rocm.sh ...`으로 명시한다. 모델 ID와 revision, 파일 hash 검사는 동일하다.

## 합성 smoke 학습

```bash
node_modules/.bin/tsx experiments/nickname-lora/cli.mts smoke-data \
  --output experiments/nickname-lora/data/smoke
experiments/nickname-lora/run-rocm.sh train --config config.json \
  --data data/smoke --output runs/smoke-r9700 --smoke --stop-after 1
experiments/nickname-lora/run-rocm.sh train --config config.json \
  --data data/smoke --output runs/smoke-r9700 --smoke \
  --resume runs/smoke-r9700/checkpoint-1
```

실제 원본 4B 가중치를 로드하고 두 optimizer step을 수행한다. 첫 프로세스는 step 1에 checkpoint를 저장하고 종료한다. 두 번째 프로세스는 adapter·optimizer·scheduler·RNG 상태를 복구하여 step 2까지 진행한다. 결과에 재개 전 step, 변경된 LoRA tensor 수, 고정 tensor 검사, checkpoint·adapter hash와 GPU peak를 기록한다. 단순 loss 출력이나 GPU 인식만으로 성공을 처리하지 않는다. 합성 파일과 결과에는 `smokeOnly=true`를 표시하며 승격 평가에 사용할 수 없다.

출력 디렉터리는 재개를 제외하고 새 경로여야 한다. 학습 입력·설정·소스 파일이 달라지면 동일 checkpoint로 재개하지 않는다. 이전 smoke 자료가 있으면 재생성하지 않고 기존 경로를 사용하거나 새 실행 이름을 지정한다.

## 실제 데이터 준비와 학습

1. 기존 `/lab/nickname-evaluation`에서 사람이 닉네임과 평가용 reference를 등록한다. `familyId`, 고정 split, `obfuscation:none` 또는 `obfuscation:mixed-script` 등 **표기 방식 하나**를 tags에 지정한다. 같은 원형의 변형은 같은 family로 관리한다.
2. 모델에는 닉네임만 전달하여 조사한다. Human Evaluation에서 결과와 각 생성 단계의 근거·action을 검수한다.
3. 대표 오답과 정상·모호 사례를 선별하여 승인하고 train 파일 및 대응 provenance를 내려받는다. validation/test 파일은 별도로 내보낸다. 모든 은어를 사람이 미리 정답으로 등록할 필요는 없다. 학습 후보의 검수와 평가 reference 작성에 사람을 사용한다.
4. 현재 프로토콜로 기록된 승인 사례를 변환한다. 과거의 정확한 입력 기록이 없거나 첫 action을 임의 구성한 후보는 재실행 후 선별한다.

```bash
node_modules/.bin/tsx experiments/nickname-lora/cli.mts prepare \
  --train experiments/nickname-lora/data/inbox/nickname-train-ID.jsonl \
  --provenance experiments/nickname-lora/data/inbox/nickname-provenance-ID.json \
  --output experiments/nickname-lora/data/release-001
experiments/nickname-lora/run-rocm.sh train --config config.json \
  --data data/release-001 --output runs/experiment-001
```

`prepare`는 export/file hash, 후보 hash, 검수 판본과 원본 응답 hash, 승인·최신 여부, train split, 표현군, 선별 대표성 제한을 검사한다. 기존 계약의 `labBuildCandidate`로 입력과 target을 재구성하여 동일성을 확인한다. 입력에는 닉네임·모델의 이전 가설·실제 검색 결과만 남기고 reference·family·cohort·검수 메타데이터는 별도 manifest에 보존한다. URL 대신 실제 제공된 source ID와 정확한 발췌문을 검증한다. 의미적 근거 지지는 사람의 검수 대상이다.

| 학습 유형 | manifest category |
| --- | --- |
| 조사 action 선택 | `investigation_action` |
| 의미 후보·질의 생성 | `meaning_query` |
| 수집 자료 판단 | `evidence_judgment` |
| 근거 부족 시 유보 | `abstention` |
| 정상 사례·오탐 교정 | `normal_retention` |
| JSON 계약 준수 | `json_contract` |

category는 여러 개가 부여될 수 있으며 `categoryCounts`로 분포를 확인한다. 학습 JSONL은 `messages`만 포함한다. chat template의 system/user prefix 전체에 `labels=-100`을 적용하고 마지막 assistant JSON과 종료 token만 학습한다. 검색 도구의 반환값·사람의 metadata는 생성 target이 아니다. 길이를 초과한 사례는 근거 또는 JSON을 잘라내지 않고 거부한다.

`config.json`을 복사하여 learning rate, rank, alpha, dropout, target modules, micro batch, accumulation, checkpointing, precision, epoch/step 상한, seed와 자원 제한을 변경한다. 기본은 rank 8, micro batch 1, accumulation 4, gradient checkpointing, BF16, learning rate `5e-5`, 1 epoch 및 최대 40 step이다. 실제 step은 epoch와 step 상한 중 작은 값으로 결정한다. 원본 모델 학습과 자동 장시간 실행은 제공하지 않는다.

## 별도 모델 등록과 비교

```bash
experiments/nickname-lora/run-rocm.sh register --config config.json \
  --name qwen3-4b-original --output registry/base.json
# 실제 result-step-N.json의 N을 사용한다.
experiments/nickname-lora/run-rocm.sh register --config config.json \
  --name nickname-lora-001 --result runs/experiment-001/result-step-N.json \
  --output registry/candidate-001.json
```

등록은 adapter를 덮어쓰지 않는 별도 JSON이다. revision, adapter hash, 학습 결과 hash와 dataset hash를 연결한다. 기본 A/B는 원본 **HF 16비트 모델**, C/D는 같은 원본+adapter이다. 현재 운영 Q4_K_M과의 양자화 차이가 개선으로 혼입되지 않도록 정밀도와 engine을 동일하게 유지한다. 운영용 양자화 결과는 별도 비교 대상이다.

| arm | 모델 | 검색 |
| --- | --- | --- |
| A | 원본 | 없음 |
| B | 원본 | 능동 조사 |
| C | 원본 + LoRA | 없음 |
| D | 원본 + LoRA | 능동 조사 |

### validation live 조사와 replay 준비

실험 전에 `policy.json`을 검토한다. 예시 기본 기준은 정상 오탐률 5% 이하·오탐 증가 0, 미학습 표현군과 미학습 난독화 양쪽의 근거 적합률 5%p 개선·검색 행동 2%p 개선, 인용 지지율 95%, JSON 유효율 99%, 불확실성 적정률 90%, 정상 미해결률 5% 이하, token 1.25배·지연 1.5배 이내이다. 최소 표본·인용 수와 항목별 미측정을 함께 검사한다. 수치는 사업상 확정 기준이 아니라 초기 실행 설정이며 **결과를 보기 전에** 변경·고정해야 한다.

```bash
node_modules/.bin/tsx experiments/nickname-lora/cli.mts freeze \
  --data experiments/nickname-lora/data/inbox/nickname-validation-ID.jsonl \
  --training experiments/nickname-lora/data/release-001/manifest.json \
  --base experiments/nickname-lora/registry/base.json \
  --candidate experiments/nickname-lora/registry/candidate-001.json \
  --policy experiments/nickname-lora/policy.json --search live \
  --output experiments/nickname-lora/runs/validation-live-001
```

한 터미널에서 원본 모델을 시작하고 다른 터미널에서 A/B를 실행한다. `SEARCH_URL`은 사용자가 지정한 SearXNG endpoint이며 실제 검색을 수행한다. 운영 검색이 필요하면 기존 승인된 접근 경로를 별도로 구성한다. CLI가 운영 SSH 연결을 생성하지 않는다.

```bash
experiments/nickname-lora/run-rocm.sh serve --registration registry/base.json
```

```bash
node_modules/.bin/tsx experiments/nickname-lora/cli.mts evaluate \
  --plan experiments/nickname-lora/runs/validation-live-001/plan.json --arm A \
  --endpoint http://127.0.0.1:18089 --output experiments/nickname-lora/runs/live-A
node_modules/.bin/tsx experiments/nickname-lora/cli.mts evaluate \
  --plan experiments/nickname-lora/runs/validation-live-001/plan.json --arm B \
  --endpoint http://127.0.0.1:18089 --search-url "$SEARCH_URL" \
  --output experiments/nickname-lora/runs/live-B
```

실험용 원본 `serve`를 Ctrl-C로 종료하고 `serve --registration registry/candidate-001.json`을 실행한다. 같은 명령의 arm을 C/D, 출력 경로를 live-C/live-D로 변경한다. 기존 운영·로컬 추론 프로세스를 종료하는 절차가 아니다. `serve`의 등록 모델과 frozen plan의 hash가 다르면 실행을 거부한다.

```bash
node_modules/.bin/tsx experiments/nickname-lora/cli.mts corpus \
  --reports experiments/nickname-lora/runs/live-B/report.json \
  --reports experiments/nickname-lora/runs/live-D/report.json \
  --output experiments/nickname-lora/data/replay-001.json
```

양쪽 모델이 사용한 query별 실제 결과를 모아 첫 관측을 고정한다. 결과가 비어 있던 질의도 보존한다. `freeze`를 새 경로에서 `--search replay --corpus .../replay-001.json`으로 실행하고 A–D를 다시 평가한다. 각 arm의 생성 설정·시스템 프롬프트·데이터·corpus hash가 같다. 같은 질의는 동일 자료를 받으며 새 질의가 나오면 `REPLAY_MISS`를 기록한다. 이를 빈 검색이나 live fallback으로 대체하지 않으며 해당 비교는 승격 불가이다. 서로 다른 질의를 선택한 차이는 모델의 검색 행동 차이로 남는다.

live는 검색 환경 변동을 포함하는 운영 관찰이며 기본 승격 판단은 고정 replay를 사용한다. 전체 시간과 generation 시간, 실제 입력·출력 token을 보존한다. 원문은 수집하지 않고 기존 Worker와 동일하게 검색 발췌문만 사용한다.

최종 test용 자료를 모델 응답을 보기 전에 확보하려면 `{ "query": "사전에 정한 질의", "language": "ko" }` 형식의 JSONL을 작성하고 `cli.mts capture --data QUERY_JSONL --search-url "$SEARCH_URL" --output CORPUS_JSON`으로 검색 snapshot을 수집한다. 이 파일을 test plan에 고정한다. 누락 질의를 결과 확인 후 추가하여 같은 test를 반복하는 방식은 사용하지 않는다.

### 검수와 승격 판정

```bash
node_modules/.bin/tsx experiments/nickname-lora/cli.mts review-template \
  --reports experiments/nickname-lora/runs/replay-A/report.json \
  --reports experiments/nickname-lora/runs/replay-B/report.json \
  --reports experiments/nickname-lora/runs/replay-C/report.json \
  --reports experiments/nickname-lora/runs/replay-D/report.json \
  --output experiments/nickname-lora/data/reviews-001.json
```

사람은 모델명을 숨긴 검수 파일에서 `reviewer`, `reviewedAt`, 근거 적합성·해석 성공·불확실성 처리·검색 행동의 boolean 평가와 인용별 `relevant`/`supports`를 입력한다. 자동 인용문 일치는 의미적 지지 평가를 대신하지 않는다. 기존 baseline 응답 검수를 신규 응답에 복사하지 않는다. 결과 hash가 달라진 검수는 무효이며 누락은 성공으로 집계하지 않는다.

```bash
node_modules/.bin/tsx experiments/nickname-lora/cli.mts gate \
  --plan experiments/nickname-lora/runs/validation-replay-001/plan.json \
  --reports experiments/nickname-lora/runs/replay-A/report.json \
  --reports experiments/nickname-lora/runs/replay-B/report.json \
  --reports experiments/nickname-lora/runs/replay-C/report.json \
  --reports experiments/nickname-lora/runs/replay-D/report.json \
  --reviews experiments/nickname-lora/data/reviews-001.json \
  --output experiments/nickname-lora/runs/validation-gate-001.json
```

정상 오탐률은 정상 사례 전체를 분모로 계산하고 정상 미채점·유보율을 별도로 제한한다. Wilson 95% 상한도 보고하되 기본 기준은 관측 오탐률이다. 소표본 결과를 모집단 성능 보장으로 해석하지 않는다. 점수 MAE는 채점된 사례 수, 점수 범위 충족률은 전체 사례 수를 분모로 사용하며 문제 사례 미탐률과 미채점률도 보고한다. 기본 MAE 퇴화 허용치는 2점이다. JSON은 최종 성공률과 재생성을 포함한 생성 단계 유효율을 함께 검사한다. 기본 추론은 LM Format Enforcer를 사용하므로 JSON 지표에는 decoder 제약의 효과가 포함된다. 제약 없는 생성은 `freeze --unconstrained`와 `serve --unconstrained`를 양쪽 모델에 동일하게 적용한 별도 비교로 측정한다.

모델 선택은 validation에서 수행한다. test `freeze`에는 `--validation-gate`로 통과한 validation 결과를 지정해야 하며 동일 candidate·policy를 요구한다. 최종 test는 arm별로 한 번만 실행하고 candidate+dataset+arm에 대한 소비 기록을 `artifacts/final-tests`에 남긴다. 실행 실패도 소비되므로 결과를 보고 같은 test를 재시도하며 튜닝하지 않는다. 최종 replay corpus는 결과를 보기 전에 독립적으로 확보한 검색 자료로 준비한다. 미수록 질의가 생기면 해당 최종 비교는 불완전한 결과로 남기고 기존 모델을 유지한다. live 부가 관찰은 validation 또는 별도의 운영 관찰셋으로 수행한다.

`gate`가 `keep_base`이면 종료 코드 2와 실패 이유를 기록한다. validation 통과는 `eligible_for_final_test`, 최종 test 통과는 `eligible_for_local_adoption`이다. 어느 결과도 자동으로 배포하지 않는다.

```bash
# 최초 선택 또는 기존 모델 복귀: 로컬 pointer만 변경한다.
node_modules/.bin/tsx experiments/nickname-lora/cli.mts select \
  --registration experiments/nickname-lora/registry/base.json \
  --output experiments/nickname-lora/registry/selected.json
# 최종 test를 통과한 정확히 같은 adapter만 선택 가능
node_modules/.bin/tsx experiments/nickname-lora/cli.mts select \
  --registration experiments/nickname-lora/registry/candidate-001.json \
  --gate experiments/nickname-lora/runs/final-gate-001.json \
  --output experiments/nickname-lora/registry/selected.json
```

pointer를 변경해도 이미 실행 중인 프로세스는 그대로 유지된다. 다음 로컬 기동에 `run-rocm.sh serve --selection registry/selected.json`을 사용하면 hash를 확인한 뒤 선택된 모델을 로드한다. 운영 모델 전환은 별도 승인·릴리스 절차이다.

## 변환과 재현 기록

```bash
experiments/nickname-lora/run-rocm.sh merge --registration registry/candidate-001.json \
  --output artifacts/merged-001
```

이는 별도 HF safetensors를 생성한다. 이후 선택한 llama.cpp revision의 `convert_hf_to_gguf.py artifacts/merged-001 --outfile artifacts/nickname-001-bf16.gguf --outtype bf16`과 `llama-quantize ... Q4_K_M`을 사용하여 **새 파일**로 변환할 수 있다. 변환 도구 revision·실행 설정·GGUF hash를 추가 기록하고 양자화된 원본/신규 모델을 같은 decoder와 하드웨어에서 재평가한다. 변환·양자화·운영 배포는 이번 smoke 검증의 범위에 포함되지 않는다. 운영 절차는 [배포 runbook](../../docs/operations/deployment.md)을 따른다.

`run.json`은 원본 ID/revision, 데이터셋·검수 manifest, 설정, 코드 hash, GPU 환경, image ID와 Python package lock을 기록한다. `result-step-N.json`은 step·재개·실제 adapter 변경·GPU peak·checkpoint/adapter hash를 기록한다. frozen plan과 arm report, 사람 검수 및 gate를 함께 보존하면 학습 전후 비교를 재현할 수 있다. 별도 `registry`는 원본과 후보를 명시적으로 구분한다. hash는 변경 탐지 수단이며 외부 파일에 사람 승인 권한을 부여하는 전자서명은 아니다. 신뢰하는 Lab export만 사용한다.

## 로컬 검증

```bash
python3 -m unittest discover -s experiments/nickname-lora -p 'test_*.py'
node_modules/.bin/tsx --test experiments/nickname-lora/pipeline.test.mts
node_modules/.bin/tsc -p experiments/nickname-lora/tsconfig.json
npm exec -w apps/api -- vitest run src/modules/benchmark-worker/research.test.ts
```

Fake HTTP Provider 테스트는 A–D가 실제 Worker 프로토콜·입력 투영·인용 검사를 사용하는지 확인한다. 실제 모델의 일반화나 검색 품질 검증은 아니다. 실제 장치 검사와 smoke 실행 결과·제약은 [검증 기록](verification/README.md)에 구분한다.
