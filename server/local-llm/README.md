# Qwen3 4B 닉네임 연구 서버

`server.py`는 같은 Qwen3-4B-Instruct-2507 Q4_K_M 가중치로 기존 호환 경로와 연구 프로파일을 분리한다. 연구 프로파일은 `/generate` 외부 계약을 유지하며 GGUF template로 렌더링한 토큰과 JSON schema를 llama.cpp `/completion`에 전달한다. b12559의 Qwen chat 출력 파서에서 관측한 긴 응답 오류를 피하기 위한 경로이며, 다른 엔진 버전으로 변경할 때 전체 action·판단 schema를 다시 확인한다.

| 설정 | 기존 호환 | 연구 |
| --- | --- | --- |
| `LOCAL_LLM_PROFILE` | 미지정 또는 `legacy` | `nickname-research-v1` |
| 포트 | 8088 | 8089 |
| 소켓 | `/run/qwen-coder/llama.sock` | `/run/nickname-research/llama.sock` |
| 입력 / 출력 / 컨텍스트 | 1,024 / 256 / 1,536 | 2,048 / 768 / 3,072 |
| 기본 지침 | 졸업전시 코딩 어시스턴트 | 닉네임 평가 |
| 구조화 출력 | 기존 chat 응답 | template 토큰 + completion JSON schema |

`LOCAL_LLM_ROOT`의 기본값은 `/opt/nickname-llm`이며 `bin/llama-server`, `runtime/`, `weights.gguf`가 필요하다. 기존 호스트의 가중치 위치는 `/opt/term-origin-llm`이며 복사 없이 이 경로를 지정할 수 있다. `LOCAL_LLM_SOCKET`, `LOCAL_LLM_PORT`로 연구 소켓과 포트를 별도 지정한다. 사용 중인 소켓을 교체하지 않으며 단일 추론 중 추가 요청에는 503을 반환한다. 서비스는 루프백에서만 수신하므로 Worker에는 사설 연결 또는 SSH 포워딩을 제공한다.

```sh
LOCAL_LLM_PROFILE=nickname-research-v1 \
LOCAL_LLM_ROOT=/opt/term-origin-llm \
LOCAL_LLM_SOCKET=/tmp/nickname-research/llama.sock \
python3 server/local-llm/server.py
```

영구 설치 템플릿은 [nickname-research.service](nickname-research.service)이다. 실행 사용자·경로를 해당 호스트에 맞게 구성하며 기존 `qwen-coder` drop-in을 연구 설정으로 덮어쓰지 않는다. 서버 설치나 기동은 운영 API·Worker·Web 전환과 별도이다. 릴리스에는 저장소의 PR·CI·배포 절차를 적용한다.

연구 요청은 `profile`, `weights_sha256`, `chat_template_sha256`, `prompt`, `system_prompt`, `max_new_tokens`, `max_input_tokens`, `timeout_ms`, `json_schema`를 사용한다. `/tokenize`는 같은 지침·template를 포함한 실제 입력 토큰 수를 반환한다. `/health`의 가중치·template hash와 준비용 schema 성공을 확인하며, Worker는 매 요청에서 hash를 고정한다. 생성 시 서버가 토큰 한도와 실제 사용량을 다시 검증한다. timeout으로 GPU 작업이 남으면 해당 연구 엔진만 종료한다.

GPU 호스트에서 길이별 측정을 수행한다. 기존 프로세스를 시작·종료하거나 설정을 변경하는 명령은 아니다.

```sh
python3 server/local-llm/measure.py --url http://127.0.0.1:8089 --output /tmp/nickname-model-measurement.json
python3 -m unittest discover -s server/local-llm -p 'test_*.py'
```

측정 JSON에는 약 1,024·2,000 입력토큰에 대한 256·768 출력 상한 실험, 실제 출력 길이, 입력·생성 속도, RSS, `nvidia-smi` GPU 메모리 표본을 기록한다. GPU 메모리 사용량은 NVML 표본이며 PyTorch allocator peak가 아니다. 측정 호스트에 `nvidia-smi`가 없으면 GPU 표본은 비어 있다. 반복한 중립 문장은 길이·메모리 측정용이며 정확도 평가 자료가 아니다.

세 검색 모드·근거 처리·단계별 예산·비교 명령은 [Lab 운영 문서](../../docs/operations/nickname-evaluation-lab.md#연구용-4b-프로파일)에 명시한다. 확인한 서버 API는 [llama.cpp b12559 문서](https://github.com/ggml-org/llama.cpp/blob/b12559/tools/server/README.md)이다.
