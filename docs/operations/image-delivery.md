# imgproxy image delivery

The API emits optional `sources` alongside the existing `original` and
`renditions` image fields. Widths are 320, 480, 768, 960, 1440 and 1920; outputs
are WebP quality 82 without enlargement. Originals and retained vote snapshots
remain authoritative. Protected previews continue to use the existing original
download capability. No image enum or stored derivative is removed in this release.

## Request and authorization boundary

`PUBLIC_ASSET_ORIGIN/img/v1/{width}/{base64url(original-key)}` passes the public
gateway's existing file-access check. The API resolves the original key before
issuing or checking a capability. It validates a READY image ORIGINAL or retained
vote snapshot and returns an internal signed imgproxy path. It never accepts a
client-selected bucket, external URL, arbitrary width or processing option.

The gateway checks authorization before every cache lookup. Auth failures and
auth service outages fail closed, including warm caches. The internal cache stores
successful transformed bytes for seven days, evicts entries unused for seven days,
and has a 10 GiB size target. Reserve at least 11 GiB on its filesystem: Nginx cache
limits are eviction targets, not hard filesystem quotas. Concurrent fills use a
cache lock. Browser responses retain `private, no-store`; only the internal cache
may serve stale bytes after the outer gateway has approved the current request.

Both internal services must remain inaccessible to browsers. Their signed URLs
are processing capabilities, not substitutes for project visibility checks.
Original keys must remain immutable; replacement uploads get new keys.

## Configuration and local validation

- `IMAGE_DELIVERY_MODE=legacy|imgproxy`: API-only, default `legacy`.
- `IMAGE_OUTPUT_MODE=legacy|original`: common runtime env, default `legacy`.
- `IMGPROXY_KEY`, `IMGPROXY_SALT`: API-only hex secrets, each at least 32 bytes;
  the imgproxy service must receive the same values. Never use integration keys in production.
- `IMAGE_CACHE_UPSTREAM`: public gateway's exact internal HTTP(S) origin.
  Compose defaults to `http://image-cache:8081`. HTTPS verifies its certificate
  against the gateway trust bundle and uses the upstream hostname for SNI.

Use the existing integration stack with the additional overlay:

```sh
docker compose -f docker-compose.integration.yml -f docker-compose.images.yml up --build -d
node apps/db/runtime-gateway.test.mjs
```

The overlay enables original-only uploads and imgproxy API responses; imgproxy
and the cache have no host ports. Its static credentials are integration fixtures.
The real Nginx fixture checks a warm HIT followed by revocation and auth failure.
Use a public `sources[].url` from the running API to verify actual WebP conversion:

```sh
node scripts/smoke-images.mjs 'http://localhost:3904/img/v1/480/ENCODED_KEY'
```

The command checks MIME, WebP magic, browser cache policy and a second-request HIT.
The URL must be public and contain no capability token. It does not print the URL.

## Production adoption and rollout

Image infrastructure is adopted separately from the existing ten application
Quadlet definitions. Ordinary releases do not adopt, recreate the application pod,
or install new infrastructure automatically. `server/quadlet/render-images.py`
renders three additional definitions and `image-cache.conf` to a new private
directory; it does not read credentials or mutate active configuration.

1. Provision a Garage key with **read-only access to the public bucket only**.
   Create `${DEPLOY_DIR}/runtime-env/imgproxy.env` with mode 0600, containing:

   ```text
   IMGPROXY_KEY=<same hex key as api.env>
   IMGPROXY_SALT=<same hex salt as api.env>
   IMGPROXY_USE_S3=true
   IMGPROXY_S3_ENDPOINT=<existing trusted Garage S3 endpoint>
   IMGPROXY_S3_REGION=garage
   IMGPROXY_S3_ENDPOINT_USE_PATH_STYLE=true
   IMGPROXY_ALLOWED_SOURCES=s3://pcu-public/
   AWS_ACCESS_KEY_ID=<public-bucket read-only key>
   AWS_SECRET_ACCESS_KEY=<public-bucket read-only secret>
   ```

   Substitute the actual public bucket in `IMGPROXY_ALLOWED_SOURCES`, including
   the trailing slash. Leave local-file serving and unsigned trusted signatures
   disabled. The renderer accepts `S3_TLS_CA_HOST_PATH` and mounts it as the Go
   TLS trust file; do not disable certificate validation.

2. Render with `DEPLOY_DIR` and optional `IMAGE_RUNTIME_ENV_FILE`, inspect the
   output, install the three units in the adopted user's Quadlet directory and
   install `image-cache.conf` at `${DEPLOY_DIR}/image-cache.conf`. Start the image
   services after `systemctl --user daemon-reload`. Images are pinned to registry
   digests (imgproxy v3.30.0 and Nginx 1.28-alpine). Resource defaults are two
   transformations, 512 MiB for imgproxy and a 15-second transformation timeout.

3. The Quadlet listeners are loopback-only: imgproxy 8090 and cache 8091. Connect
   the existing public gateway to the cache over the deployment's private
   transport. A gateway in another container or host cannot use its own
   `127.0.0.1` to reach these listeners. Use a private HTTPS reverse-proxy/tunnel
   endpoint restricted to the gateway, terminating at `127.0.0.1:8091`, and set
   `IMAGE_CACHE_UPSTREAM` accordingly. Never publicly expose the cache endpoint.
   Deploy the updated public-origin template before enabling imgproxy responses.

4. Keep both modes `legacy` for the first compatible API/Web/worker deployment.
   Run the new release inventory against existing objects, writing outside Git:

   ```sh
   npm run image:delivery -w apps/api -- audit /private/new-image-audit.jsonl
   # Explicit metadata-only repair when the report identifies missing dimensions:
   npm run image:delivery -w apps/api -- repair-dimensions /private/new-image-repair.jsonl
   ```

   The compiled equivalents are `dist-release/scripts/image-delivery.js`.
   Reports include object identifiers; keep them private. The tool never rewrites
   image bytes or deletes objects. Missing, oversized or inaccessible originals
   block the audit. Unknown dimensions retain legacy candidates until repaired.

5. Set API-only `IMAGE_DELIVERY_MODE=imgproxy` and the signing secrets. Set
   `IMAGE_SMOKE_URL` in the deployment `.env` to a stable public transform URL.
   Release preflight requires the separately adopted services to be active and
   healthy with at least 1 GiB free cache headroom. Activation verifies actual
   conversion and a warm HIT after API health and before worker startup.

6. Once display, visibility changes, vote snapshots and cache behavior pass,
   set `IMAGE_OUTPUT_MODE=original` in common.env and release/recreate the worker.
   A new upload must create exactly one original representation and publish
   successfully. Existing queued publication plans can still copy legacy outputs.

To disable transformed delivery, return `IMAGE_DELIVERY_MODE` to `legacy` on the
compatible API. Newly uploaded images display their originals. Do not roll back
to old binaries that require three image representations.

## Observation and deferred cleanup

Inspect image-cache logs for status, HIT/MISS, duration and bytes, and Podman
memory/disk use. Cache access logs omit URLs, query strings and capabilities.
Monitor conversion failures and the browser original fallback; a low HIT rate
or repeated source failures should be investigated before stopping pre-generation.

After at least seven days of verified operation, remove compatibility response
fields and legacy enum dependencies in a separate release. Produce a reviewed
deletion inventory and use the existing durable deletion/reference checks;
never delete by filename pattern. Retained vote posters, pending publication and
export jobs must keep their referenced bytes. No bulk-delete command is provided
in this release, and old migrations remain unchanged.

Repository validation is not production adoption. Real Garage/imgproxy/Nginx and
PostgreSQL integration checks must run on a Linux Docker/Podman host before rollout.
