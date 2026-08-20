# 객체 전송 control-plane cutover runbook

이 문서는 GAME·WEBGL의 browser-to-object-storage 전환과 공개 origin
전환을 한 번의 breaking cutover로 배포하는 절차다. 구 Web/API writer와 신 writer를
동시에 실행하지 않는다. schema downgrade는 지원하지 않으며 장애 시 기본 복구 전략은
forward-fix다.

## 완료 후 byte 경계

| 자산 | Client → data plane | API | Processing worker | Delivery |
| --- | --- | --- | --- | --- |
| GAME | Garage protected/staging multipart | 인증·인가, capability, Complete/Abort, 상태 전이 | 순차 검증 후 READY pointer commit | `assetId` 정책 판정 후 짧은 presigned GET으로 302 |
| WEBGL ZIP | Garage protected multipart | 인증·인가, capability, Complete/Abort, 검증 enqueue | 한 번의 source read로 검증·immutable generation 전개 | public origin의 immutable entry/artifact URL |
| VIDEO 신규 업로드 | 지원하지 않음; inline/generic contract에서 거부 | 신규 upload capability 없음 | 없음 | 기존 `READY` VIDEO만 `assetId` 정책 판정 후 302 |
| 소형 이미지·포스터·문서 | inline cap 이하의 Fastify stream | stream 단계와 logical size를 모두 제한 | 필요한 rendition 처리 | public origin immutable URL |

Fastify는 direct part, completed object 검증 stream, public image/WebGL response body를
읽지 않는다. `pcu-protected`와 `pcu-staging`은 website 공개 대상이 아니다.
VIDEO direct staging은 이번 cutover의 구현 범위에 포함되지 않았다. UI와 API는 신규
VIDEO upload를 명시적으로 비지원하며, 대형 VIDEO bytes를 Fastify로 우회 전송하는
경로도 없다. 기존에 이미 `READY`인 VIDEO의 조회·재생 delivery만 보존한다.

### Client-facing ingress inventory

`INLINE_UPLOAD_MAX_BYTES`의 기본값과 schema 상한은 모두 16 MiB이다. multipart route의
`bodyLimit`와 `preParsing` limiter는 multipart boundary와 header를 포함한 encoded request
전체에 같은 상한을 적용한다. 따라서 per-file logical 상한이 encoded 상한과 같거나 더 큰
경우에도 실제 허용 파일 크기는 multipart overhead만큼 더 작다.

| Route | Content type과 형식 | Encoded request 상한 | Logical 상한 | Fastify byte 역할 |
| --- | --- | --- | --- | --- |
| `POST /api/admin/projects/submit`, `POST /api/me/projects/submit` | JSON metadata만 허용 | 2 MiB (`min(INLINE_UPLOAD_MAX_BYTES, 2 MiB)`) | request schema | metadata control request만 처리 |
| `POST /api/admin/projects/:id/assets`, `POST /api/me/projects/:id/assets` | `kind` field 1개 후 `file` 1개; `POSTER`·`IMAGE`·`THUMBNAIL`만 허용 | 16 MiB 기본값; `bodyLimit`와 streaming `preParsing`에 동일 적용 | 일반 사용자 image/poster 10 MiB, ADMIN·OPERATOR 15 MiB; encoded 상한도 동시 적용 | 소형 inline 자산만 임시 파일과 processing pipeline으로 전달 |
| `POST /api/admin/exhibitions/:id/poster` | `poster` file 1개, field·추가 part 금지 | 16 MiB 기본값; `bodyLimit`와 streaming `preParsing`에 동일 적용 | ADMIN·OPERATOR image 15 MiB; PDF limiter는 50 MiB이지만 encoded 16 MiB 상한이 먼저 적용 | 소형 poster 원본만 처리 |
| `POST /api/admin/import/preview`, `POST /api/admin/import/execute` | `file` JSON file 1개, field·추가 part 금지 | 16 MiB 기본값; `bodyLimit`와 streaming `preParsing`에 동일 적용 | JSON file 10 MiB, buffer 최대 10 MiB | 제한된 JSON import만 처리 |
| GAME·WEBGL direct session control routes | JSON control payload | 전역 JSON 2 MiB 상한 | part body 없음 | capability, status, Complete·Abort만 처리; part bytes는 browser에서 Garage로 직접 전송 |
| VIDEO 신규 upload | 지원하지 않음 | 해당 file ingress route 없음 | 해당 없음 | 기존 `READY` VIDEO 조회·delivery만 유지 |

위 표의 multipart route 세 종류(project asset, exhibition poster, import) 외에는
client-facing multipart ingress를 등록하지 않는다. `GAME`·`VIDEO` kind는 project asset
contract에서 file stream 소비 전에 거부된다.

## 필수 환경과 권한

| 구분 | 설정 | 의미 |
| --- | --- | --- |
| storage | `S3_INTERNAL_ENDPOINT` | API/worker 전용 내부 S3 endpoint |
| signing | `S3_PUBLIC_SIGNING_ENDPOINT` | browser가 접근하며 서명 당시 Host/path/query가 보존되는 endpoint |
| public | `PUBLIC_ASSET_BASE_URL` | `S3_BUCKET_PUBLIC` root의 별도 public origin; API host 금지 |
| proxy upstream | `GARAGE_S3_UPSTREAM`, `GARAGE_PUBLIC_WEB_UPSTREAM` | production nginx가 연결할 Garage S3/website root origin |
| proxy TLS | `GARAGE_S3_TLS_SERVER_NAME`, `GARAGE_PUBLIC_WEB_TLS_SERVER_NAME` | HTTPS upstream SNI; browser-visible Host와 분리 |
| proxy bind | `UPLOAD_PART_PROXY_BIND_HOST/PORT`, `PUBLIC_ORIGIN_BIND_HOST/PORT` | host TLS proxy가 전달할 loopback listener |
| buckets | `S3_BUCKET_PUBLIC`, `S3_BUCKET_PROTECTED`, `S3_BUCKET_STAGING` | 공개 결과, 보호 원본, untrusted staging 분리 |
| capability | `UPLOAD_PART_URL_TTL_SEC`, `UPLOAD_PART_URL_BATCH_MAX` | part capability TTL과 batch 상한 |
| inline | `INLINE_UPLOAD_MAX_BYTES` 또는 현재 schema의 동등 설정 | Fastify stream/file/request cap의 단일 기준 |
| worker | `VALIDATION_WORKER_CONCURRENCY`, `VALIDATION_WORKER_POLL_MS` | claim 수와 실제 병렬 처리 수, poll 간격 |
| worker disk | `VALIDATION_WORKER_TEMP_ROOT`, `VALIDATION_WORKER_TEMP_DISK_BUDGET_BYTES` | API와 분리된 bounded temp storage |
| worker lease | `VALIDATION_WORKER_CLAIM_LEASE_MS` | PostgreSQL clock 기반 active claim lease |
| CORS | `S3_CORS_ALLOWED_ORIGINS` | direct PUT이 허용되는 정확한 Web origin 목록 |
| public CORS | `PUBLIC_CORS_ORIGIN_PRIMARY`, `PUBLIC_CORS_ORIGIN_SECONDARY` | public GET/HEAD가 반환할 정확한 origin |
| iframe | `WEB_PUBLIC_ORIGIN` | WebGL CSP `frame-ancestors`의 정확한 origin |
| lifecycle | `INCOMPLETE_MULTIPART_MAX_AGE` | 만료 session보다 충분히 긴 Garage incomplete multipart 보존 기간(기본 `2d`) |
| lifecycle CLI | `GARAGE_MAINTENANCE_CONFIG_HOST_PATH`, `GARAGE_MAINTENANCE_IMAGE` | read-only Garage admin config와 pinned CLI image |

credential은 가능한 한 API multipart administration/signing, validation protected read,
public generation write, protected download signing, cleanup exact delete/abort, public
website read 역할로 분리한다. Garage IAM이 operation 단위로 충분히 세분화되지 않으면
bucket, immutable key namespace, 별도 credential, process/container 경계를 함께
사용한다. presigned URL, signature query, access key, secret, raw upload ID는 로그에
남기지 않는다.

Garage v1.1의 incomplete multipart 정리는 API cleanup outbox와 별개인 age-based
safety net이다. `server/deploy.sh up`은 user-systemd timer를 설치해 protected/staging
bucket에 다음 명령을 주기적으로 실행한다. DB의 exact-key/upload-ID abort task를 이
명령으로 대체하거나 migration에서 broad cleanup을 수행해서는 안 된다.

```bash
garage -c /etc/garage.toml bucket cleanup-incomplete-uploads \
  --older-than 2d pcu-protected pcu-staging
systemctl --user status garage-incomplete-upload-cleanup.timer
journalctl --user -u garage-incomplete-upload-cleanup.service --since today
```

운영 로그에는 고정된 `action/result`만 남고 Garage CLI의 locator 포함 가능 출력은
노출하지 않는다. `INCOMPLETE_MULTIPART_MAX_AGE`는 `UPLOAD_SESSION_TTL_MINUTES`보다
반드시 길어야 하며 deploy가 이를 fail-closed로 검증한다.

## Garage와 ordinary public proxy

현재 pin은 `dxflrs/garage:v1.1.0`이다. 이 이미지의 CLI는 다음 명령을 제공한다.

```bash
garage -c /etc/garage.toml bucket website --allow pcu-public
```

`apps/db/garage-init*.sh`는 public bucket에만 이 명령을 적용한다. Garage website
endpoint는 요청 `Host`로 bucket 또는 bucket alias를 결정한다. production public
hostname이 bucket 이름과 다르면 먼저 global bucket alias를 생성한다.

```bash
garage -c /etc/garage.toml bucket alias pcu-public assets.example.org
garage -c /etc/garage.toml bucket website --allow pcu-public
```

`apps/db/public-origin.nginx.conf.template`는 Node/application proxy가 아닌 ordinary
byte-preserving nginx다.

- 원래 `Host`, escaped path, query를 Garage `s3_web` endpoint로 보존한다.
- GET, HEAD, OPTIONS 이외의 method를 거부한다.
- buffering과 gzip 변환을 끄고 bytes, ETag, Last-Modified, Content-Encoding, MIME,
  Cache-Control, Range 의미를 보존한다.
- exact CORS, CORP, COEP, COOP, CSP, `nosniff`, `no-referrer`를 추가한다.
- WebGL deployment UUID가 entry URL에도 포함되지만 `index.html` entry는
  `public, max-age=60`으로 짧게 캐시한다. 같은 generation의 `.js`, `.wasm`, data
  artifact는 `public, max-age=31536000, immutable`로 게시한다. mutable alias나
  latest pointer를 추가하지 않는다.

direct UploadPart endpoint 앞 proxy도 signed `Host`, escaped path와 query를 변경하면
안 된다. URL 문자열을 내부 hostname으로 rewrite하지 않는다. 최대 part body 제한은
storage write 전 proxy ingress에서 적용하고 Garage integration test로 검증한다.

production에서 이 proxy들은 외부 전제가 아니다. CI가 두 template을 deploy directory로
복사하고 `server/deploy.sh up`이 `gp-upload-part-origin`과 `gp-public-origin` nginx
container를 API와 별개로 직접 기동한다. 두 container는 서로 다른 pod port를 사용하며
host에는 기본적으로 `127.0.0.1:3901`, `127.0.0.1:3904`로만 publish된다. 기존 host TLS
proxy/DNS가 각각 `S3_PUBLIC_SIGNING_ENDPOINT`, `PUBLIC_ASSET_BASE_URL` hostname을 이
listener에 연결해야 한다. deploy는 다음을 fail-closed로 확인한다.

- exact CORS/Web origin이며 wildcard 또는 복수 값을 단일 변수에 넣지 않았는지
- upstream과 public endpoint가 path/query/fragment 없는 root origin인지
- rendered nginx config에 미치환 변수가 없고 `nginx -t`가 성공하는지
- 각 transport health와 Garage website upstream probe가 성공하는지
- public/signing hostname이 API hostname과 다른지

UploadPart access log와 public access log는 `$uri`만 기록하고 `$args` 또는 전체 request
line을 기록하지 않는다. 따라서 SigV4 query, upload ID, credential은 nginx access
log에 남지 않는다. UploadPart는 `proxy_request_buffering on`과
`server/deploy.sh`는 `UPLOAD_CHUNK_SIZE_MB`에서 nginx의
`UPLOAD_PART_MAX_BYTES`를 파생한다. 운영 env에 assertion 값을 함께 적은 경우 두 값이
정확히 일치하지 않으면 배포를 중단하여, 큰 proxy cap의 storage exhaustion과 작은 cap의
정상 part 오거부를 모두 방지한다. nginx는 Garage upstream write 전에 물리 상한을 적용한다.

공식 근거:

- <https://garagehq.deuxfleurs.fr/documentation/cookbook/exposing-websites/>
- <https://garagehq.deuxfleurs.fr/documentation/cookbook/reverse-proxy/>

## 배포 전 점검

1. 구 Web/API writer에 maintenance mode를 적용하고 in-flight JSON control request를
   drain한다. 이미 browser에서 Garage로 진행 중인 PUT은 API shutdown과 독립적이다.
2. direct part endpoint의 exact CORS origins, exposed `ETag`, allowed methods를 실제
   browser origin으로 확인한다.
3. public hostname이 Garage bucket name 또는 alias와 일치하는지 확인한다.
4. public proxy에서 GET/HEAD, Range 206, invalid Range 416, ETag 304,
   Last-Modified 304, If-Range, MIME, Content-Encoding, cache/security headers를 확인한다.
5. preserved DB backup 복구 시간과 storage cleanup backlog를 확인한다.
6. 다음 audit은 read-only다.

```bash
npm run audit:game-upload-cutover --workspace=apps/api
```

audit의 legacy 상태별 session 수, nonterminal 수, active slot, upload ID/key residue,
READY asset 충돌 후보, 기존 abort/deletion task, 삭제 예정 row와 비정상 참조를 변경
승인 기록에 첨부한다. 비정상 READY 참조나 cleanup target 충돌이 있으면 cutover를
시작하지 않는다.

## Breaking cutover 순서

아래 순서를 바꾸지 않는다.

1. old Web/API writer drain 및 종료
2. legacy session audit dry-run 결과 보존
3. PostgreSQL preserved DB backup 및 복구 가능성 확인
4. legacy residue cleanup/outbox follow-up migration 적용
5. 나머지 schema follow-up migration 적용 (`npx prisma migrate deploy`)
6. migration-generated exact abort/deletion task와 terminal state 수 대조
7. Garage exact CORS, incomplete multipart lifecycle, public bucket website/alias 설정
8. nginx template과 exact origin/upstream 환경을 배포 directory에 반영
9. candidate image로 `server/deploy.sh cutover`를 실행한다. 이 명령이 old API/worker를
   drain한 뒤 read-only audit → 검증 가능한 preserved backup → explicit migration 순서를
   fail-closed로 수행한다. transport 제거 migration만 적용되고 target-fence cleanup
   migration이 아직 pending인 preserved DB도 direct PENDING/COMPLETING/VERIFYING residue와
   canonical bucket을 audit한다. 두 cleanup migration이 모두 적용된 재실행에서만 destructive
   audit을 version-gate로 건너뛰고 backup과 pending forward migration을 다시 검증한다.
10. `server/deploy.sh up`으로 UploadPart/public nginx 검증 후 새 API를 배포한다. API
    image의 기본 CMD는 migration을 실행하지 않는다.
11. validation/transform worker를 별도 executable/container로 배포
12. API와 worker health가 확인된 뒤에만 새 Web을 배포한다. cutover release gate는
    matching API workflow 성공 전 Web workflow를 차단한다.
13. cleanup worker가 migration-generated task를 claim/처리하는지 확인
14. GAME·WEBGL direct upload canary(create → signed part PUT → Complete → VERIFYING → READY)
15. public image/WebGL origin canary(GET/HEAD/Range/validator/encoding/security header)
16. 구 chunk, raw storage key, public image/WebGL API byte route가 404인지 확인
17. queue lag, active worker, verification bytes/duration, cleanup backlog, untracked
    multipart와 storage residue가 정상 범위인지 확인

old writer와 new writer가 겹쳤거나 audit 이후 old writer가 row를 추가하였다면 배포를
중단한다. backup 시점부터 audit/migration을 다시 수행한다.

## Canary 명령

로컬/integration 구성은 public proxy를 `:3904`에, Garage website diagnostics를
`:3902`에 노출한다.

```bash
curl -fsSI \
  -H 'Host: pcu-public.web.garage.localhost:3904' \
  http://127.0.0.1:3904/integration-poster.png

curl -fsS -D- \
  -H 'Host: pcu-public.web.garage.localhost:3904' \
  -H 'Range: bytes=0-7' \
  http://127.0.0.1:3904/integration-poster.png
```

API-down independence와 proxy byte 보존은 aggregate integration 마지막 단계에서 API를
중지한 뒤 `scripts/check-public-origin-api-down.mjs`로 검증한다. 이 test는 public
proxy 응답과 Garage website 직접 응답의 SHA-256/ETag를 비교한다.

## Rollback과 장애 복구

이 cutover는 schema와 Web contract가 breaking이므로 old API 재실행을 rollback으로
간주하지 않는다.

1. 새 Web/API writer와 worker의 신규 claim을 중지하고 active item을 drain한다.
2. 이미 READY가 된 direct object와 immutable public generation을 보존한다.
3. VERIFYING row와 protected/staging object를 보존한다. 확인 없이 삭제 task를 만들지
   않는다.
4. durable abort/deletion outbox를 보존한다. cleanup worker를 중복 실행해도 exact
   target idempotency가 유지되어야 한다.
5. migration 후 schema에는 old writer를 연결하지 않는다. workflow와 deploy script도
   candidate 실패 시 old image를 자동 재기동하지 않는다. code/schema 문제는
   forward-fix migration과 새 image로 복구한다.
6. Web만 되돌려 direct-only contract와 불일치시키지 않는다. Web/API는 검증된 동일
   release pair로만 교체한다.
7. DB backup 복구는 migration 자체가 잘못되어 forward-fix로 데이터 의미를 복구할 수
   없고, cutover 이후 신규 READY mutation을 모두 폐기하기로 승인한 경우에만 수행한다.
   DB만 복구하지 말고 이후 storage object/outbox reconciliation 계획도 승인한다.

public origin 장애는 API byte relay를 되살리는 이유가 아니다. nginx/Garage website,
DNS/TLS, bucket alias와 public-read 경계를 복구한다. API가 public object body를 읽거나
새 Node proxy를 배포하는 우회는 금지한다.

## Troubleshooting

### public origin 404

- `garage bucket info pcu-public`에서 website enabled 상태를 확인한다.
- 요청 Host가 `pcu-public.<s3_web.root_domain>` 또는 configured global alias인지 확인한다.
- proxy가 `$http_host`를 upstream에 전달하고 path/query를 normalize하지 않는지 확인한다.
- DB pointer가 가리키는 immutable key가 public bucket에 실제 존재하는지 확인한다.

### Range/validator/encoding 불일치

- nginx gzip, content transform, cache revalidation override가 꺼져 있는지 확인한다.
- upload metadata의 Content-Type, Content-Encoding, Cache-Control을 HEAD로 확인한다.
- proxy와 Garage 직접 응답의 body digest, ETag, Last-Modified, Content-Range를 비교한다.
- `.wasm.br`는 `Content-Type: application/wasm`, `Content-Encoding: br`여야 한다.

### direct PUT 실패

- 요청이 Fastify가 아니라 `S3_PUBLIC_SIGNING_ENDPOINT`로 향하는지 확인한다.
- signed URL 전체를 로그에 남기지 말고 scheme/host/path template, session/generation,
  part number와 status만 비교한다.
- proxy가 signed Host/path/query와 required content type/checksum header를 바꾸지 않는지
  확인한다.
- CORS origin은 scheme/host/port까지 정확히 일치하고 response에서 `ETag`가 노출되어야
  한다.

### worker queue 정체

- capacity가 N이면 최대 N개 row만 claim하고 즉시 N개를 처리하는지 확인한다.
- active item에만 heartbeat가 있고 PostgreSQL `clock_timestamp()` lease/token fencing이
  적용되는지 확인한다.
- shutdown signal이 storage read, transform, pointer/outbox commit 경계에 전달되는지
  확인한다.
- temp disk budget을 초과하면 새 claim을 중단하고 active item을 fail-closed한다.

## 관측 항목

cutover 동안 direct session create, part capability issue/refresh, storage complete,
verification queued/started/bytes/duration/retry, READY/REJECTED/cancel/expire,
replacement/stale generation/quota/oversized rejection, worker queue lag/active/temp disk,
cleanup backlog/untracked multipart, public origin health를 확인한다. 모든 event는 stable
actor/project/session/asset/generation/action/result만 기록한다.
