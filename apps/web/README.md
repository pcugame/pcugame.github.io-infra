# PCU Web App

React 19 + Vite SPA for the PCU graduation project showcase.

## Responsibilities

- Public exhibition/year/project browsing.
- Google OAuth login entry points and session-aware navigation.
- Student project submission and editing flows.
- Admin screens for exhibitions, projects, settings, banned IPs, import/export,
  and asset management.
- Development mock mode for UI work without the API.

## Commands

```bash
npm run dev       # Vite dev server on :5173
npm run dev:mock  # Vite with VITE_MOCK=true mode
npm test          # Vitest
npm run lint      # ESLint
npm run build     # TypeScript build + Vite build + SPA post-build
npm run preview   # Preview production build
```

## Environment

Copy `.env.example` to `.env.local` for local development.

- `VITE_API_BASE_URL`: API origin, usually `http://localhost:4000`.
- `VITE_GOOGLE_CLIENT_ID`: Google OAuth web client ID.
- `VITE_DEV_AUTH_ENABLED`: shows the integration-only dev login panel when
  `true` and the app is not a production build.
- `VITE_BASE_PATH`: GitHub Pages base path. Use `/` for a custom domain.

## Project Notes

- Frontend implementation conventions and a shared form example are in
  [UI conventions](./src/components/ui/README.md). New forms should use `src/components/ui`.

- UI scale is managed centrally in `src/styles/foundation/tokens.css`:
  `--ui-scale-mobile` defaults to `100%`, and `--ui-scale-desktop` to `125%`.
  The existing compact layout boundary (`max-width: 50em`, normally 800px)
  selects the mobile scale by viewport width, including narrow desktop windows.
  `foundation/base.css` applies the selected scale to the root font size so
  rem-based text, spacing, and layout sizes change together across all pages.
  Adjust these tokens instead of adding per-page scale overrides; fixed pixel
  sizes and media-query boundaries are independent of the root scale.
- API calls live under `src/lib/api`.
- TanStack Query keys live in `src/lib/query/keys.ts`.
- Shared API transport types come from `@pcu/contracts` through
  `src/contracts`.
- Web form schemas live in `src/contracts/schemas.ts` and use Zod v4.
- Mock mode is intentionally lightweight for UI-only work. Use the root
  integration test environment for full API/PostgreSQL/Garage coverage.

## 게임 외부 연결 신청

새 신청은 호스트명(예: `assets.example.com`), HTTPS 또는 WSS 방식, 모든 포트를 기본으로 구성한다. URL의 경로·쿼리는 입력하지 않는다. **하위 도메인만** 선택 시 입력한 루트 호스트는 포함하지 않으며, 루트가 필요하면 별도로 신청한다. HTTPS와 WSS도 각각 신청한다.

특정 포트만 필요한 경우 **고급 설정 · 포트 정책 → 특정 포트**에서 1~65535를 입력한다. 붙여넣은 URL의 `:8443` 또는 `:443`이 선택한 포트 정책과 다르면 오류를 표시한다. 고급 설정에 같은 특정 포트를 지정하면 안전하게 정규화하며, 자격 증명·경로·쿼리·조각을 제거하여 허용하지 않는다. 특정 포트 443은 계약에 따라 포트가 생략된 origin으로 전송한다. 기존 신청·승인의 포트 생략은 계속 443을 의미하며, 전체 포트로 자동 변환하지 않는다.

서비스 예시는 실제 호스트와 방식·범위를 확인한 뒤 필요한 항목만 선택한다. 같은 호스트·방식·범위의 포트별 예시는 하나의 전체 포트 예시로 제공한다. 선택한 항목은 각각 신청하며, 일부 실패 시 성공한 항목을 제외하고 실패 항목만 재시도한다. 관리자 목록은 실제 호스트 범위, 루트 제외 여부, 모든 포트 또는 특정 포트를 표시한다.

Mock도 공용 계약으로 신청·승인을 검증하며, 기존 기록의 포트 정책을 보존한다. 승인 규칙 중복·16개 한도·보호 호스트 제한과 서버 보안 정책은 그대로 적용한다. 승인은 다음 게임 실행부터 적용되며, 외부 서버의 CORS·Origin 검사·인증 설정을 대체하지 않는다. Mock은 실제 외부 통신이나 CSP 적용을 검증하지 않는다.

접수 시 기존 사용 목적·서버 설정 계획에 SDK/버전·Unity 버전·게임 모드, 외부 목적지별 용도, 비밀정보를 제외한 인증 방식, 외부 서비스 운영 담당자, 실제 2인 플레이 확인 절차를 기재한다. 신청 → 관리자 승인 → 새 실행 후 서로 다른 두 계정/클라이언트로 같은 방의 양방향 게임 상태와 재접속을 확인한다. 서비스 예시와 합성 통신 검증은 Photon/Relay 연동 보장이 아니다.

마감 후 신청 제한과 API 갱신 실패 시 iframe 제거·게임 종료는 현재 동작을 유지한다. 마감 이후 신청 권한과 일시적 갱신 오류의 제한적 재시도는 후속 과제이다. 현재 계약, 수동 전환 및 검증 범위는 [승인 연결 정책](../../docs/unity-webgl/003-approved-connections.md)을 참조한다.

## Direct upload creation recovery

The shared direct-upload task writes `<session-storage-key>:creation` before
POSTing. This record contains a new `clientUploadId` UUID, the exact request body,
owner/kind, authenticated user scope, queue position and optional cancellation
intent. It is separate from the existing session locator so records with a known
session ID remain readable. File bytes are not stored: resuming requires the same
file, while cancellation can use the persisted request without reselecting it.

Recovery reads the server creation contract. `NOT_OBSERVED` and lookup failures
never prove final failure; an explicit retry reuses the same ID and request.
`ALLOCATING` exposes an explicit retry/cancel path without a polling loop.
Cancellation can replay an unobserved request under the same ID to obtain and
cancel its session. Confirmed terminal sessions require an explicit new upload;
new queue entries never reuse the prior ID or the UI's `operationKey` as that ID.
Create, lookup and recovery cancellation requests have bounded transport deadlines.

Deploy the server creation contract and its additive migration before this Web
build. Legacy known-session records use session status/submission recovery;
unknown legacy records remain visible and preserved for submission/operator
verification. Session storage does not survive closing the tab or clearing browser
data.

The task owns four control states: open, cancelling, cancel-unconfirmed and
completion observation. Starting or resuming transfer requires open state;
views render the same task permission on start/retry/resume buttons. A failed
DELETE followed by UPLOADING (or a failed status request) remains unconfirmed:
one GET cannot fence a previously dispatched DELETE. Retry cancellation rather
than resume. The cancellation intent is persisted before DELETE, including for
legacy known-session locators, and survives view detach/reattach and reload.

COMPLETING may revert to UPLOADING, so the task observes it while blocking
transfer. CANCELLED or a successful DELETE delivers cancellation once; READY or
VERIFYING retires the cancellation intent and hands off to existing completion
observation. REJECTED/EXPIRED allow the existing explicit new-upload path without
reporting cancellation. Closing a cancelled session clears its creation identity;
the next upload creates a new logical operation. Run/operation fences reject
late callbacks, including the multipart client's onSession on resumed transfers.

On restoring a known session, a newly selected file is checked against its stored
`sourceIdentity` using the existing SHA-256 block manifest. A missing in-memory
`File` is never evidence of equality; name and size alone do not establish it.
A mismatch or an unreadable file does not consume the image/video READY locator,
advance the selected-file queue or report success. The user can reselect the
original file or reconcile the original operation before discarding the locator.
UPLOADING can be cancelled through the server. READY refuses cancellation; reopen
without a selected file to recover that original result independently instead.

Legacy locators without source identity cannot assign an existing READY result to
a reselected file and follow the same preservation/cancellation policy. An
UPLOADING session can still resume through the multipart client's authenticated
status and source-identity verification; name and size alone never permit it.
Without any file reselection,
server-confirmed READY can still recover the original operation's completion,
including legacy records; this recovery makes no claim about a new local file.
The original immutable `File` reference can establish identity within the same
in-memory task. No file content is persisted by this policy.
