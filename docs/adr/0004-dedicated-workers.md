# ADR 0004 — Byte 처리·export·publication 전용 worker

상태: **기존 결정 기록** — 현재 구현의 소급 기록이며 신규 승인 기록이 아니다.

## 배경

Archive 검증, media 변환과 export는 object byte 및 workspace 접근이 필요하다.
HTTP 요청 graph에서 이러한 작업을 실행하면 요청 수명과 처리 수명·자원 한도가 결합된다.
Process 종료 후 작업 복구에는 durable job 상태와 동시 실행 소유권이 필요하다.

## 결정

GAME·DOCUMENT·ATTACHMENT source validation, WebGL validation·processing, video, image·PDF, export와 publication은 전용 worker entry point로 실행한다.
각 entry point는 DB·S3 자원, signal과 실행 loop의 수명을 소유한다.
API는 권한·metadata·upload capability·상태 전이를 담당하며 worker 처리 graph를 import하지 않는다.

Job repository의 claim·lease·token과 완료 조건을 사용한다.
Heartbeat와 소유권 검증은 lease 상실 이후 stale 결과의 반영을 제한한다.
Worker 처리에는 재시작과 재시도 가능성이 있으며 exactly-once 실행을 주장하지 않는다.

Session 정리, direct upload recovery와 orphan·upload lifecycle maintenance는 API context에 유지한다.
전용 처리 worker와 context-owned maintenance는 서로 다른 실행 경계이다.

## 대안과 절충

- 요청 내부 처리는 구현 경로를 단순화하지만 CPU·byte 처리·workspace 작업이 API 수명과 결합된다.
- 모든 background task를 별도 process로 분리하면 lifecycle 관리 범위와 운영 구성이 증가한다.
- 처리 worker 분리는 배포·상태 동기화 비용이 발생하지만 API의 byte 처리 권한과 자원 경계를 제한한다.

## 결과

API와 worker 변경은 durable 상태와 job 계약의 호환성을 함께 검토한다.
처리 worker의 동작을 API maintenance의 process 분리 완료로 해석하지 않는다.
정적 architecture guard와 lease·failure 테스트를 함께 적용한다.

## 근거와 검증 위치

- [Worker entry points](../../apps/api/src/image-worker.ts), [publication entry point](../../apps/api/src/project-publication-worker.ts)
- [실행 명령 목록](../../apps/api/package.json), [production service templates](../../server/quadlet/templates/)
- [Publication claim·heartbeat](../../apps/api/src/modules/project-publication/worker.ts)
- [API maintenance](../../apps/api/src/backend-context/maintenance.ts), [upload lifecycle](../../apps/api/src/modules/upload-lifecycle/runtime.ts)
- [Architecture guard](../../apps/api/scripts/architecture-guard.mjs), [dependency rules](../../apps/api/.dependency-cruiser.cjs)
- [Processing fences tests](../../apps/api/src/__tests__/processing-worker-fences.test.ts)
- [Publication tests](../../apps/api/src/modules/project-publication/worker.test.ts), [API maintenance tests](../../apps/api/src/__tests__/upload-lifecycle-runtime.test.ts)
