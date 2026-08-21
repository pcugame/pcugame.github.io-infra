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
| `public-origin` | 3904 | Validated public image and immutable WebGL generation GET/HEAD |

Garage S3 is bound to NAS loopback solely for NAS-local API/workers. Garage
website and admin listeners have no host ports. Do not publish Garage admin,
management endpoints, raw Garage volumes, or the NAS filesystem export path.
The compose services share the private `garage_private` network; neither Nginx
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
export UPLOAD_PART_MAX_BYTES=16m
export UPLOAD_PART_GLOBAL_CONNECTIONS=512
export UPLOAD_PART_PER_IP_CONNECTIONS=128
export S3_BUCKET_PUBLIC=pcu-public
export GARAGE_PUBLIC_BUCKET_HOST=pcu-public.web.garage.localhost
export S3_CORS_ALLOWED_ORIGINS=https://www.example.edu,https://admin.example.edu
export PUBLIC_CORS_ORIGIN_PRIMARY=https://www.example.edu
export PUBLIC_CORS_ORIGIN_SECONDARY=https://admin.example.edu
export WEB_PUBLIC_ORIGIN=https://www.example.edu
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
docker compose -f apps/db/docker-compose.yml --profile nas-data-plane exec public-origin nginx -t
node apps/db/deployment-boundaries.test.mjs
LIVE_GARAGE_PROXY_TEST=1 apps/db/live-data-plane.test.sh
```

Garage is the SigV4 verifier. Nginx only limits/constrains transport;
it cannot determine whether a presigned request is valid before it sends the
request upstream, and it must not be treated as authorization. `garage-init`
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
object metadata. Only 200/206 immutable generation responses receive a
long-lived browser cache directive; 404, 429 and every 5xx are `no-store`.
