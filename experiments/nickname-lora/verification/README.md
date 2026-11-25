# 로컬 파이프라인 검증 기록

검증일은 2026-11-25 KST이다. 작업 브랜치는 `lab`이며, 실제 데이터 선별·학습은 사용자 요청에 따라 후속 작업으로 남긴다. 합성 smoke 사례는 모델 품질이나 일반화 성능을 평가하는 자료가 아니다.

## 확인된 환경

[환경 요약](environment.json)은 실제 로컬 장치 조사 결과이다.

| 항목 | 관측값 |
| --- | --- |
| 운영체제 | NixOS 26.05, Linux 7.1.2 |
| 호스트 Python | 3.13.13, torch 미설치 |
| 외장 GPU | AMD Radeon AI PRO R9700, `1002:7551`, `gfx1201`, amdgpu |
| 연결 | Thunderbolt / ASMedia 246x PCIe 경로 |
| 노출 VRAM | 34,208,743,424 bytes, 약 31.86GiB |
| 내장 GPU | Intel Meteor Lake Arc, i915 |
| 시스템 RAM | 약 30.87GiB, 최초 조사 시 가용 약 15.56GiB |
| 최초 디스크 여유 | 약 55.81GiB |
| 기존 로컬 추론 | Qwen3 8B Q4_K_M, llama-server/Vulkan, 변경 없음 |
| 운영 호스트 | 사용자 지정 `song@gameserver:5050`, 이번 작업에서 접속·변경 없음 |

최초 amdgpu 표본은 VRAM resident 약 57MiB, GTT 약 5.27GiB였다. 별도의 기존 추론 프로세스에서 VRAM 요청량과 GTT resident가 관찰되었으므로 resident VRAM 값만으로 추론 미점유 상태를 단정하지 않는다. 실행 전후 자원 상태는 `artifacts/*hardware*.json`에 보존한다.

## 완료된 코드 및 프로토콜 검증

- 새 Node 파이프라인 테스트 9개 통과: 승인·변경 검수·분할 누수, 실제 입력 형태, 인용 범위, replay miss, 지표 분모, 합격 기준 변경 거부, 실제 Worker를 이용한 A–D HTTP 실행, validation/test 승격 경계.
- Python 테스트 6개 통과: assistant loss mask, 길이 초과 거부, smoke/evaluation 자료의 일반 학습 진입 차단, 변경된 데이터 hash 거부, 파일 덮어쓰기 거부, GPU 미지원 시 CPU fallback 차단.
- TypeScript 타입 검사, API lint·architecture 검사 통과.
- 기존 API 단위 테스트 1,275개 통과, 환경 의존 349개 제외. Script 테스트 75개와 릴리스 artifact 검사 31개도 통과하였다. 최초 npm 명령의 인수가 뒤쪽 Node test runner로 전달되어 두 TS 파일 로딩 오류가 발생했으며, 올바른 Vitest 명령으로 해당 Worker·평가 22개 테스트를 다시 실행해 통과하였다.
- 원본 Qwen tokenizer의 실제 chat template로 합성 세 사례를 인코딩하였다. 전체/학습 대상 token은 각각 `623/38`, `951/151`, `861/109`이며, system/user·검색 자료에는 loss를 부여하지 않는다.
- LM Format Enforcer에서 실제 Worker처럼 닉네임 literal을 적용한 action·answer JSON 세 사례의 schema 수용을 확인하였다. 이는 실제 모델의 JSON 생성 성공률 측정은 아니다.

## GPU 학습 검증 상태

최초 Python 3.12 컨테이너에 AMD PyTorch 2.9.1/ROCm 7.2 wheel을 설치하였으나 `libroctx64.so.4`가 없어 import 단계에서 실패하였다. `doctor`는 실패를 기록하고 학습을 차단하였다. Dockerfile에 동일 ROCm 7.2의 사용자 공간 라이브러리를 추가한 뒤 빌드와 import가 통과하였다. 호스트 드라이버나 기존 추론 프로세스는 변경하지 않았다.

실제 R9700(`gfx1201`)에서 **FP16·BF16 matmul과 backward 모두 통과**하였다. PyTorch 보고값은 `2.9.1+rocm7.2.0.git7e1940d4`, HIP은 `7.2.26015-fc0010cf6a`, CUDA는 `null`이다. 검사 시 가용 VRAM은 34,139,537,408 bytes였다. 이 결과는 작은 연산의 실행 확인이며 전체 4B 학습 완료를 뜻하지 않는다.

원본 4B LoRA smoke는 세 차례 시작하였으나 **가중치 다운로드 단계에서 중단**하였다. Xet 병렬 전송에서 연결 timeout이 반복되었으며, 일반 HTTP 경로에서도 기본 10초 읽기 제한에 걸렸다. 제한을 180초로 늘린 재시도에서는 약 500MiB의 cache가 생성된 뒤 대용량 전송이 수분간 정체되었다. 이번에 시작한 다운로드 컨테이너만 종료하고 미완료 실행 기록과 부분 cache를 보존하였다. optimizer step은 0이며 adapter 생성·checkpoint 저장·재개·실제 모델 JSON 생성은 미검증이다.

로컬 제외 경로의 원본 기록은 `artifacts/rocm-hardware-verified.json`, `artifacts/build-runtime.log`, `artifacts/smoke-step-1*.log`, `runs/smoke-r9700-download*-incomplete/interruption.json`에 있다. 컨테이너 image ID는 [환경 요약](environment.json)에 기록하였다. 실제 데이터와 검수 이력은 아직 입력하지 않았다.

네트워크가 대용량 원본 파일을 수신할 수 있는 상태에서 다음 명령으로 재시도한다. 이미 사용한 출력 이름은 새 이름으로 바꾼다. 다운로드 cache는 재사용하며 GPU 사전 검사는 매번 실행한다.

```bash
docker build -f experiments/nickname-lora/Dockerfile.rocm \
  -t pcu-nickname-lora:rocm7.2 experiments/nickname-lora
experiments/nickname-lora/run-rocm.sh doctor --output artifacts/rocm-hardware-retry-001.json
node_modules/.bin/tsx experiments/nickname-lora/cli.mts smoke-data \
  --output experiments/nickname-lora/data/smoke-retry-001
experiments/nickname-lora/run-rocm.sh train --config config.json --smoke \
  --data data/smoke-retry-001 --output runs/smoke-retry-001 --stop-after 1
experiments/nickname-lora/run-rocm.sh train --config config.json --smoke \
  --data data/smoke-retry-001 --output runs/smoke-retry-001 \
  --resume runs/smoke-retry-001/checkpoint-1
```

실제 자료를 이용한 학습, 미학습 표현의 A–D 품질 평가, human review 기반 승격 판정, GGUF 변환과 운영 배포는 수행하지 않았다. CI는 시작하지 않았으며 변경은 로컬 작업 트리에 있다.
