# NAS Garage data-plane runbook

`docker compose -f apps/db/docker-compose.yml up -d` continues to start the
existing local PostgreSQL and loopback-only Garage setup. The externally
published NAS byte-serving origins are explicitly opt-in:

```bash
docker compose -f apps/db/docker-compose.yml --profile nas-data-plane up -d --build
docker compose -f apps/db/docker-compose.yml --profile nas-data-plane ps
```

Run this profile on the NAS. The only externally published services are:

| Surface | Default port | Purpose |
| --- | ---: | --- |
| `upload-part-origin` | 3901 | Browser presigned `UploadPart` PUT |
| `protected-download-origin` | 3906 | Short-lived protected-object GET/HEAD capabilities |
| `public-origin` | 3904 | Authorized image and WebGL generation GET/HEAD |

Garage S3 is bound to NAS loopback solely for NAS-local API/workers. Garage
website and admin listeners have no host ports. Do not publish Garage admin,
management endpoints, raw Garage volumes, or the NAS filesystem export path.
The compose services share the private `garage_private` network; no Nginx
service mounts the Garage data/meta volumes or an export path.

## Required deployment values

Set explicit externally reachable bind addresses/ports and origins before
starting the profile. `UPLOAD_PART_MAX_BYTES` must equal (or exceed only by a
small documented transport allowance) the maximum part size issued by the API.

```bash
export NAS_UPLOAD_BIND_ADDRESS=203.0.113.10
export NAS_UPLOAD_PORT=443
export NAS_PUBLIC_BIND_ADDRESS=203.0.113.11
export NAS_PUBLIC_PORT=443
export NAS_PROTECTED_DOWNLOAD_BIND_ADDRESS=203.0.113.12
export NAS_PROTECTED_DOWNLOAD_PORT=443
export UPLOAD_PART_MAX_BYTES=16m
export UPLOAD_PART_GLOBAL_CONNECTIONS=512
export UPLOAD_PART_PER_IP_CONNECTIONS=128
export PROTECTED_DOWNLOAD_GLOBAL_CONNECTIONS=512
export PROTECTED_DOWNLOAD_PER_IP_CONNECTIONS=128
export S3_BUCKET_PROTECTED=pcu-protected
export S3_BUCKET_PUBLIC=pcu-public
export GARAGE_PUBLIC_BUCKET_HOST=pcu-public.web.garage.localhost
export S3_CORS_ALLOWED_ORIGINS=https://www.example.edu,https://admin.example.edu
export PUBLIC_CORS_ORIGIN_PRIMARY=https://www.example.edu
export PUBLIC_CORS_ORIGIN_SECONDARY=https://admin.example.edu
export WEB_PUBLIC_ORIGIN=https://www.example.edu
# Reachable from both NAS gateway containers; use private authenticated TLS
# across hosts. Configure the same independent random secret on the API.
export FILE_GATEWAY_API_UPSTREAM=https://api.private.example.edu
export FILE_GATEWAY_SECRET=replace-with-independent-32-plus-character-gateway-secret
```

In production front these ports with the NAS TLS terminator or make it the
published listener; this compose file deliberately does not manage
certificates. UploadPart bodies stream to Garage with request buffering off.
The global connection ceiling bounds slow/invalid requests, while the higher
per-IP abuse ceiling permits at least 50 users behind a school NAT. A Garage
restart fails the in-flight part without an Nginx body replay; the browser
refreshes/retries that idempotent part through the control plane.

## Boundary and recovery checks

```bash
docker compose -f apps/db/docker-compose.yml --profile nas-data-plane config
docker compose -f apps/db/docker-compose.yml --profile nas-data-plane exec upload-part-origin nginx -t
docker compose -f apps/db/docker-compose.yml --profile nas-data-plane exec protected-download-origin nginx -t
docker compose -f apps/db/docker-compose.yml --profile nas-data-plane exec public-origin nginx -t
node apps/db/deployment-boundaries.test.mjs
LIVE_GARAGE_PROXY_TEST=1 apps/db/live-data-plane.test.sh
```

The live wrapper now starts the full API/database/gateway integration stack in
a disposable Docker project. It needs the root integration ports (15432, 3900,
3902–3906, 4000, 5173) free and cleans only its own volumes. This verifies
canonical object ownership and sessions as well as transport semantics.

Garage remains the SigV4 verifier. Both read gateways first make an internal
API authorization subrequest, authenticated with `FILE_GATEWAY_SECRET`.
A missing secret, API failure, expired session, revoked relationship, or denied
visibility must stop delivery before Garage is contacted. SigV4 alone does not
authorize a read. UploadPart keeps its existing upload-session policy. `garage-init`
uses Garage v1.1's standard internal S3 `PutBucketCors`/`GetBucketCors` API to
apply and read-back-verify exact origins. It rejects wildcards, credentials,
paths, queries and malformed origins; production must override the concrete
local default above. The protected bucket receives only `PUT`/`HEAD` with the
required SigV4 headers and exposed `ETag`; the public bucket receives only
`GET`/`HEAD`. No CORS rule enables credentials. The management/admin listener
is neither published nor proxied; only the private init job accesses Garage's
internal control/data-plane endpoints. The upload proxy intentionally permits
only PUT plus preflight and does not proxy Garage admin paths.

For a Garage restart, Nginx returns a non-cacheable error after bounded
timeouts; clients refresh their API-issued capability and retry through the
upload state machine. Do not point either origin at the NAS export filesystem.
Public-object responses preserve Garage Range/HEAD/304/416 semantics and
object metadata. All new read responses, including 200/206, use `private, no-store`. Previously
cached bytes cannot be recalled; do not use cache purging as an authorization
mechanism.
Protected delivery is a separate origin. Existing object paths under
`/${S3_BUCKET_PROTECTED}/` are checked against current anonymous access before
forwarding. New `/file/<token>` paths resolve through the gate to a freshly
signed, validated upstream locator, so renewing the same token does not leave
an expired signature in the browser URL. Bucket roots, public buckets, unknown
object paths, writes, preflights, and generic S3/admin paths fail closed. Access
logs omit capability paths and queries; every response is `private, no-store`.
Public images may use `?pcu_token=...`; WebGL keeps relative URLs under
`/play/<token>/`. File-origin requests never forward application cookies.


## Visibility rollout

Use the existing PR checks, review, `master` merge, exact-commit release image,
and `Deploy Release` workflow. A successful image build is not a deployment.
Apply the additive visibility/token migrations and deploy the API and both NAS
read-gateway configurations before enabling controls. Existing rows default to
`PUBLIC`; files stay in their existing buckets.

Keep the repository variable `VITE_VISIBILITY_CONTROLS_ENABLED` unset or `false`
until all checks below pass. The Pages and Phase 2 web builds pass that variable
to the web bundle. Setting it to `true` and publishing through the existing Pages
workflow enables the selectors. File access enforcement and token renewal are
active even while selectors are hidden.

Record the merged source SHA, immutable image digest, release workflow run,
gateway configuration revision, and the production verification results in the
release record. Verify the actual running revision and served web release SHA.
Before enabling controls, use controlled fixtures and real sessions to check:

- Anonymous, ordinary user, uploader, linked member, operator and administrator
  reads across all exhibition/project visibility pairs; counts, empty lists,
  ID/slug detail, duplicate-year exhibitions, and the inaccessible-year slug
  lookup must agree with the same policy.
- Known raw image/rendition/poster paths and previously signed download URLs
  must stop working anonymously as soon as their target becomes restricted.
  Confirm that NAS alternate hosts, raw Garage website/S3 ports and TLS virtual
  hosts cannot bypass the gateways from outside the private network.
- Expired, forged, cross-file and revoked-session tokens must fail. Removing a
  linked member, changing a role, logging out, or reducing visibility must affect
  the next request. A token can be shared during its valid window; delivered
  bytes cannot be recalled.
- A live WebGL fixture must load relative assets/workers and compressed files,
  renew the same token without restarting, and reject traversal and files absent
  from its deployment manifest. Confirm HEAD, Range, MIME and isolation headers
  at the real public and protected origins.
- Stop the authorization API in the isolated integration environment: both read
  gateways must fail closed, including formerly public paths and signed URLs.
  Do not perform outage injection against production.

Once restricted rows exist, recover with a visibility-aware forward fix. Do not
restore an older runtime or gateway that lacks these checks. The legacy Phase 1
rollback command also refuses restricted visibility data. Preserve the schema
and enforce authorization throughout recovery.
