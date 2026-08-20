# Upload lifecycle and direct-transport runbook

## Release status and compatibility gate

This branch is a cutover candidate, not a change that can be merged into production
one component at a time. It deliberately makes every newly-created GAME/WEBGL
session `DIRECT_MULTIPART`. Rows that existed before the migration remain
`API_CHUNK_PROXY`, and the legacy chunk route remains capable of finishing those
rows. An old Web client connected to the new API, however, would create a direct
session and then try the incompatible chunk route. Do not deploy this branch until
the Web/API pair and the browser-to-Garage network path have passed the cutover
matrix below.

Required pre-cutover evidence:

1. New Web + old API receives no `transport` field and uses the legacy chunk path.
   This verifies Web-before-API compatibility while production remains unchanged.
2. New Web + new API completes GAME and WEBGL through browser-to-Garage `PUT`,
   including resume, URL refresh, cancellation, validation, and replacement.
3. A migrated `API_CHUNK_PROXY` row can still be resumed and completed through the
   legacy route. This is recovery compatibility, not a fallback for a failed direct
   session.
4. No Web code automatically switches a `DIRECT_MULTIPART` session to the legacy
   byte proxy after a direct failure.
5. Browser network capture shows part bytes only on the public Garage signing
   origin; API traffic contains JSON control requests only.
6. The production Garage CORS and reverse-proxy checks in this runbook pass from
   every configured Web origin.

When the release is approved, drain old API writers, apply the new migration, and
deploy the tested Web/API pair within the maintenance window. Each `BackendContext`
owns the maintenance and validation execution context. Do not run old and new upload
writers concurrently. After replacement, wait at least 60 minutes before
`reconcile-orphans.ts --apply`; always review its dry run first.

Rollback must stop and drain the new API and its validation/maintenance workers
before restoring an old writer. Preserve `game_upload_sessions`, `upload_intents`,
`multipart_abort_tasks`, and `orphan_objects`. A rollback does not make already
completed browser uploads disposable.

The legacy chunk route can be removed only after all of the following are true:

- no non-terminal `API_CHUNK_PROXY` session remains;
- direct upload completion, resume, and CORS metrics have been observed for the
  agreed support window;
- access logs show no legacy chunk requests from supported clients;
- the recovery and rollback procedure no longer needs the route;
- Web support for the legacy contract has been intentionally ended and the route
  removal has its own contract change.

## Direct multipart lifecycle

The API is the control plane and Garage is the client-facing upload data plane:

1. The API authenticates and authorizes session creation, chooses a session-unique
   key and generation, calls Garage `CreateMultipartUpload`, and commits the session
   in PostgreSQL.
2. The Web requests a bounded batch of part capabilities. The API rechecks current
   project write access, session state, expiration, active replacement, generation,
   and part-number bounds. It returns short-lived presigned `UploadPart` URLs.
3. The browser sends each part directly to Garage with bounded concurrency. An
   `ETag` is upload metadata, not a file checksum.
4. Completion rechecks authorization and fencing, compares the client manifest with
   Garage `ListParts` (numbers, ETags, and sizes), and builds the Garage
   `CompleteMultipartUpload` request only from the listed parts.
5. After `CompleteMultipartUpload`, API `HEAD` verifies object existence and size.
   The transaction moves the session to `VERIFYING`; it does not create a READY
   Asset or public pointer.
6. The PostgreSQL-backed validation worker claims `VERIFYING` rows with a lease,
   reads only the ranges needed for signature/ZIP validation, and commits Asset
   replacement plus session completion transactionally. WebGL deployment writes
   validated output to the public bucket. A GAME object stays in the protected
   bucket.
7. Deterministic validation failures become `REJECTED` only after durable object
   cleanup is recorded. Transient or ambiguous failures stay retryable and must not
   be forced to READY/REJECTED by an operator guess.

P0 uses the documented large-object exception: a direct upload targets a unique,
private key in `pcu-protected`. The object is an untrusted generation until its DB
session reaches READY; no Asset relation, public pointer, or download grant resolves
to it. API ownership of create/complete/abort plus generation fencing prevents an
expired part URL or old upload ID from replacing a READY generation. `pcu-staging`
is provisioned for later single-PUT and P2 upload flows; it is not falsely described
as the current GAME/WEBGL target.

`UploadIntent` remains separate. It tracks an object created before its business DB
commit and enables compensation. A `GameUploadSession` is the actor/project/
generation authorization record. Neither replaces the other.

## Storage endpoints, buckets, and CORS

- `S3_INTERNAL_ENDPOINT` is reachable by API/worker processes and is used for all
  privileged object I/O and inspection.
- `S3_PUBLIC_SIGNING_ENDPOINT` is the browser-visible Garage S3 origin used by the
  separate presigning client. Never string-rewrite a signed internal URL.
- `S3_ENDPOINT` is a deprecated input alias only; new deployments must set both
  explicit endpoints.
- `pcu-protected` contains protected immutable objects and P0's untrusted unique
  multipart generations. `pcu-public` contains validated public objects.
  `pcu-staging` is reserved for untrusted staging workflows.

The local/integration initializer installs Garage bucket CORS, not Fastify CORS, on
`pcu-protected` and `pcu-staging`. `S3_CORS_ALLOWED_ORIGINS` must list exact Web
origins. The rules allow only `PUT` and `HEAD`, explicitly list signed request
headers, expose `ETag`, and reject wildcard origins. Production credentials should
be split as far as Garage permits: upload administration/signing on protected or
staging, validation read/write as needed, download signing with protected read, and
public origin with public read only. Bucket separation and key-scoped presigned
capabilities are the practical boundary when fine-grained IAM/STS is unavailable.

If a reverse proxy exposes Garage, it must be an ordinary byte-preserving transport
proxy. It must pass the signed Host, path, query string, request method, and headers
without normalization or reconstruction. A Fastify/Node service that reads a body
and makes a second SDK request is not an acceptable proxy.

Configure Garage lifecycle expiration for incomplete multipart uploads after an
operator-approved retention period. This is defense in depth; it does not replace
`MultipartAbortTask`, generation fencing, or worker alerts.

## Worker and request-path expectations

Business transactions commit pointer changes and their deletion/abort outbox rows
atomically. After commit, request handlers only call the context-owned wake method;
they do not wait for the global backlog. Repeated wakes are coalesced into one
active worker and at most one pending pass. Worker failures are emitted through the
context logger and retried by later wakes or the periodic maintenance schedule.

Persisted ownership leases use the PostgreSQL clock as their sole source of
truth. Claim, active-lease checks, renewal, takeover, and token-fenced final
mutations must compare against `clock_timestamp()`, and lease deadlines must be
derived as database time plus a duration in the same statement or transaction.
Application `Clock` values remain valid for business TTLs, retry/backoff
scheduling, and observations, but must never decide whether a persisted owner is
still active. Consequently, changing an API process clock must neither steal nor
revive an upload-intent, multipart-abort, idempotency, game-upload part,
game-upload completion/recovery, or orphan-deletion lease.

An expired token is stale even when no replacement owner has claimed the row
yet. Renewal and every token-owned final mutation must fail closed after database
expiry. Operators must not clear or extend lease columns manually to recover a
worker; allow the normal PostgreSQL-time takeover path to fence the previous
token or generation.

Orphan and upload-intent workers claim at most 50 rows and collect one immutable
reference inventory for the entire claimed batch. A malformed WebGL pointer makes
the affected buckets fail closed. Do not bypass this check to clear a backlog;
repair the pointer first and allow a later worker pass to converge.

## Critical untracked multipart cleanup failure

Alert on either of these context-local signals:

- log event `untracked_multipart_cleanup_unrecoverable` at fatal level;
- `untrackedMultipartCleanupFailureCount()` increasing above zero.

This event means a newly created multipart upload could neither be aborted in
object storage nor recorded in `multipart_abort_tasks`. The originating request is
failed. The log retains the key, reason, and sanitized error name/code/message, but
deliberately excludes the upload ID, raw error objects, signed URLs, query strings,
and credentials. Treat it as storage residue with no application queue record:

1. Use the exact logged key and event time to inspect multipart uploads through the
   restricted storage administration interface. Keep any discovered upload ID out
   of application logs, tickets, and chat.
2. Restore PostgreSQL and object-storage connectivity before retrying cleanup.
3. Abort the exact matching multipart upload in that restricted interface, then
   verify it no longer appears in the multipart listing.
4. If an immediate abort is unsafe or unavailable, insert an operator-reviewed
   durable abort task for the exact target and verify the maintenance worker claims
   it. Do not substitute a broad prefix deletion.
5. Correlate the failed HTTP mutation and confirm that no session/pointer row was
   committed for the untracked upload.

Prompt abort failures logged with
`tracking=durable-abort-task-committed` are different: the repository transaction
already committed the exact durable abort task. Verify the task remains queued and
the worker is progressing; those failures do not by themselves invalidate the
already committed business response.

## Protected download boundary

The canonical route is `GET /api/assets/:assetId/download?variant=original|playback`.
It resolves a READY Asset and variant, evaluates the centralized delivery policy,
checks the manual denylist and transient limiter, then returns a short-lived 302
presigned GET with `Referrer-Policy: no-referrer`. GAME filename disposition is
preserved. The response never contains an object body and Fastify does not implement
GET, HEAD, or Range semantics for the protected object.

Protected delivery was already a presigned 302 before this branch. The P0 change is
the domain boundary: new serializers use `assetId`, variant and current Asset state
instead of exposing `storageKey` as the canonical identity. The old
`/api/assets/protected/:storageKey` route remains a deprecated compatibility route
that delegates to the same policy/grant path.

`BannedIp` is now a manual denylist only. A transient excess returns 429 and
`Retry-After`; it does not insert a row. The limiter scopes authenticated actor,
action, asset, and client IP where available, and the manual denylist fails closed
before the transient bucket. Administrator unban remains supported.

## Troubleshooting

### Direct upload or resume failure

1. Record actor/project/session/generation/part number and the stable API error code.
   Never paste a complete presigned URL into tickets, chat, or logs.
2. Query the session transport, status, expiry, generation, active-slot relation,
   storage key, and upload ID. Confirm the actor still has current write access.
3. For `PENDING`, compare the expected part layout with Garage `ListParts`. A part in
   Garage but absent from browser memory is resumable; status reconciliation must
   not force a re-upload solely because a control message was lost.
4. Inspect browser network traffic. Part `PUT` must target
   `S3_PUBLIC_SIGNING_ENDPOINT`; the API should see only create, sign, status,
   complete, and cancel control requests.
5. Do not switch the session to the legacy route. Cancel/recreate only after its
   abort task or prompt abort has been durably accounted for.

### CORS failure or unreadable ETag

- Verify the failing request is against Garage rather than Fastify.
- Read back bucket CORS with `get-bucket-cors`; confirm the exact browser Origin,
  `PUT`, required signed request headers, and exposed `ETag` are present.
- Check both the preflight response and the actual PUT response. A successful PUT
  with an unreadable `ETag` is still a client failure because completion cannot
  construct its manifest.
- Do not solve the issue with `AllowedOrigins: ["*"]`, a Fastify CORS change, or an
  application body proxy.

### Public signing endpoint or signature mismatch

- Decode only the non-secret URL origin/path for local inspection and confirm the
  origin equals `S3_PUBLIC_SIGNING_ENDPOINT`, not the container-only internal name.
- Confirm `S3_FORCE_PATH_STYLE` matches the proxy/Garage routing model.
- Replay a newly issued capability without copying it to logs. Compare the browser
  Host, raw path, raw query, method, and signed headers at the reverse proxy and
  Garage. Redirects, path decoding, slash normalization, query sorting/removal, or
  Host rewriting invalidate the signature.
- Test the same operation against `S3_INTERNAL_ENDPOINT` with server credentials to
  separate storage health from public signing/routing health. Never repair a signed
  URL by string replacement.

### Stuck COMPLETING or VERIFYING

- `COMPLETING`: inspect object `HEAD` and multipart `ListParts`. If object existence
  or upload existence is ambiguous, restore connectivity and let the fenced recovery
  path decide; do not manually mark a terminal state.
- `VERIFYING`: confirm the row is claimable after its PostgreSQL-time lease expires,
  the immutable object still exists with the expected size, and the context-owned
  worker is running. The worker logs transient failures and releases or expires its
  claim for retry.
- A deterministic validation failure should have a `REJECTED` session and a durable
  orphan/deletion record. A transient decoder, storage, DB, or claim-loss failure
  must remain retryable.

### Incomplete multipart and object cleanup

- Inspect `multipart_abort_tasks` before attempting any manual abort. A queued task
  is the durable source of truth; a prompt abort is only an optimization.
- Inspect `orphan_objects` and `upload_intents` before deleting an object. Never use
  a broad prefix deletion as a substitute for an exact durable task.
- Correlate session generation with key/upload ID so an old cleanup cannot target a
  replacement generation.
- For staging cleanup in later flows, require the same exact-key outbox discipline.
  `pcu-staging` lifecycle expiration is defense in depth, not the business record.

### Legacy use and byte-boundary audit

- `legacy_proxy_transport_selected` indicates a migrated legacy session used the
  old path. New session creation should emit `direct_transport_selected`.
- Direct lifecycle logs currently include `upload_session_created`,
  `upload_part_urls_issued`, `upload_session_completed_storage`, and
  `upload_session_verifying`, followed by `upload_session_ready`,
  `upload_session_rejected`, or `upload_session_expired` as applicable. Protected
  grants and throttles emit
  `protected_download_grant` and `protected_download_rate_limited`. Contexts contain
  IDs/action/result, not capability URLs.
- Run `npm run architecture`. The guard reports exactly two known
  `legacy-client-delivery-relays`: public image and WebGL. Any new object read in a
  client-facing delivery module, feature-local S3 SDK client, Node/Fastify asset
  proxy, direct UploadPart body relay, or signer admin authority fails its fixture.
- Browser/API telemetry should show declared/verified object sizes separately and
  zero direct part bytes at API ingress. API restart during an already-started
  browser-to-Garage PUT must not terminate that PUT.

## Public asset delivery: known P1 boundary

P0 does **not** move public image or WebGL response bodies out of Fastify. The
existing `public/image.service.ts` and `public/webgl.service.ts` still call object
storage `HEAD`/`stream` and implement GET/HEAD/Range/conditional semantics. The
architecture guard carries an exact two-file debt allowlist so no additional
application origin can be introduced. Therefore a check that public assets already
go directly to Garage is expected to fail on this branch; do not report P1 complete.

P1 must be implemented as a separate, reviewable boundary change:

1. Introduce `PUBLIC_ASSET_BASE_URL` for a browser-accessible Garage public endpoint
   or an ordinary reverse proxy; do not add a Node/Fastify asset server.
2. Publish image renditions at immutable generation keys and have public serializers
   return origin URLs. Convert `/api/public/images/:storageKey` to a compatibility
   redirect, then remove the image relay allowlist entry.
3. Publish each validated WebGL generation under an immutable public prefix and
   return its entry URL. Garage/proxy must own GET, HEAD, Range, validators, MIME and
   content encoding. Use short/no-cache for an entry pointer or `index.html` and
   long `max-age, immutable` for generation artifacts. Preserve CSP and required
   CORS/CORP/COEP/COOP headers at the origin. Convert legacy API routes to redirects
   and remove the WebGL relay allowlist entry.
4. Add production integration evidence that public URLs bypass Fastify and that the
   proxy preserves response bytes and HTTP semantics.

Public revocation semantics must remain explicit. `PUBLIC_STATIC` means anyone with
the URL may fetch it and previously delivered/cache-held bytes cannot be recalled;
immutable caching is allowed. `PROTECTED` means each new access needs an API grant
and can be revoked by stopping short-TTL URL issuance. Confidential or immediately
revocable data must never be published to `pcu-public`.

## Sequenced follow-up work

- **P2:** add direct staging and PostgreSQL validation jobs for VIDEO and large PDF,
  then split project metadata submission from large-file transfer. Keep the current
  small-image proxy for bounded low-concurrency transforms; do not force every small
  file through direct upload.
- **P3:** only after P0/P1/P2 are stable, evaluate generalizing
  `GameUploadSession` into a purpose-based object session. Remove legacy chunk
  claims/body streaming only after the legacy removal gate above. Do not erase the
  existing generation fencing, leases, completion ambiguity recovery, UploadIntent,
  orphan outbox, or multipart abort task model during that refactor.

## Storage data-plane boundary verification status

| Boundary | Status in this branch | Evidence and limitation |
|---|---|---|
| `DIRECT_MULTIPART` part byte | Implemented | The direct route accepts JSON part-number batches; Web PUT targets presigned Garage URLs. The legacy readable route remains only for `API_CHUNK_PROXY` recovery. |
| Protected canonical download | Implemented | `assetId`/variant policy resolution returns a 302 presigned GET. No protected object body, HEAD, or Range is generated by Fastify. |
| Public image delivery | Follow-up required (P1) | Existing Fastify `HEAD`/`stream` relay remains under one exact guard allowlist entry. |
| Public WebGL delivery | Follow-up required (P1) | Existing Fastify GET/HEAD/Range/conditional relay remains under one exact guard allowlist entry. |
| New application asset proxy | Verified absent by architecture guard | Feature-local S3 SDK/GetObject, object read ports, Node HTTP/fetch proxy, stream piping, and Fastify object-body responses have forbidden fixtures. A normal nginx/Caddy/Traefik/Garage proxy is outside this prohibition. |
| Multipart Complete/Abort | Implemented as Garage operations | The fenced completion service invokes the storage adapter's Garage `CompleteMultipartUpload`; cancellation/cleanup invokes Garage `AbortMultipartUpload`. The browser receives neither authority. |
| Internal object byte read | Implemented and separated | Validation composition uses bounded `readRange` and WebGL transform reads internally. The guard prohibits those ports in new client-facing delivery modules; the two P1 legacy public relays are explicitly identified above. |
