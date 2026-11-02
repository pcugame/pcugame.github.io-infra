# 최초 초기화

[가이드](README.md) · [다음: 일반 운영](operations.md)

새 설치에 한 번 수행한다. 기존 DB·Garage에 이 순서를 재적용하지 않는다. 개발 `garage-init`와 seed는 운영에 사용하지 않는다. 각 명령이 실패하면 후속 단계를 중단하고 실제 상태를 확인한다.

## Garage node·layout·bucket·key

다음은 `pcu` 계정에서 실행한다. `NODE_ID`와 `NEXT_VERSION`은 앞 명령의 실제 출력으로 대체한다. capacity는 설치한 data volume의 사용 가능 공간보다 작게 설정한다. `100G`는 예시이며 전체 host 디스크 용량이 아니다.

```sh
podman exec pcu-garage /garage status
podman exec pcu-garage /garage layout show
podman exec pcu-garage /garage layout assign -z single-pc -c 100G NODE_ID
podman exec pcu-garage /garage layout show
podman exec pcu-garage /garage layout apply --version NEXT_VERSION
podman exec pcu-garage /garage status
podman exec pcu-garage /garage bucket create pcu-public
podman exec pcu-garage /garage bucket create pcu-protected
podman exec pcu-garage /garage bucket website --allow pcu-public
podman exec pcu-garage /garage key create pcu-app
podman exec pcu-garage /garage bucket allow pcu-public --read --write --key pcu-app
podman exec pcu-garage /garage bucket allow pcu-protected --read --write --key pcu-app
```

`key create` 출력에는 secret이 포함된다. 안전한 관리 terminal에서만 확인하고 `app.env`에 기록한다. 공유 log·ticket에 복사하지 않는다. RPC secret·admin token과 앱 access key는 서로 다른 자격증명이다. public bucket만 website를 허용한다. public website도 호스트에 직접 공개하지 않으며 파일 접근은 API 권한 검사 gateway를 통과한다.

## 정확한 origin의 CORS

`cors-protected.json`, `cors-public.json`의 origin을 실제 Web origin으로 직접 편집하고 `/srv/pcu/config/`에 복사한다. wildcard와 불필요한 origin을 추가하지 않는다. CORS 변경에는 잠시 owner 권한이 필요하므로 준비 후 제거한다. 아래 일회성 명령은 API 이미지에 포함된 AWS SDK를 사용하며 별도 앱 설치를 요구하지 않는다. `PCU_API_IMAGE`는 unit과 동일한 immutable reference이다.

```sh
PCU_API_IMAGE='REPLACE_WITH_API_IMAGE_AT_SHA256_DIGEST'
install -m 0644 server/manual/config/cors-*.json /srv/pcu/config/
podman exec pcu-garage /garage bucket allow pcu-public --owner --key pcu-app
podman exec pcu-garage /garage bucket allow pcu-protected --owner --key pcu-app
podman run --rm -i --pod graduationproject \
  --env-file /srv/pcu/config/app.env \
  -v /srv/pcu/config/ca.crt:/etc/pcu/ca.crt:ro,z \
  -v /srv/pcu/config/cors-public.json:/tmp/cors-public.json:ro,z \
  -v /srv/pcu/config/cors-protected.json:/tmp/cors-protected.json:ro,z \
  --entrypoint node "$PCU_API_IMAGE" --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from '@aws-sdk/client-s3';
const s3 = new S3Client({ endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION,
  forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });
for (const kind of ['public', 'protected']) {
  const Bucket = process.env[kind === 'public' ? 'S3_BUCKET_PUBLIC' : 'S3_BUCKET_PROTECTED'];
  const CORSConfiguration = JSON.parse(readFileSync(`/tmp/cors-${kind}.json`, 'utf8'));
  await s3.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration }));
  const actual = await s3.send(new GetBucketCorsCommand({ Bucket }));
  console.log(Bucket, JSON.stringify(actual.CORSRules));
}
s3.destroy();
JS
podman exec pcu-garage /garage bucket deny pcu-public --owner --key pcu-app
podman exec pcu-garage /garage bucket deny pcu-protected --owner --key pcu-app
podman exec pcu-garage /garage bucket info pcu-public
podman exec pcu-garage /garage bucket info pcu-protected
```

출력의 origin·method·header·expose header를 파일과 대조한다. 내부 S3 DNS·CA가 잘못되면 이 명령이 실패해야 한다. `NODE_TLS_REJECT_UNAUTHORIZED=0`·인증서 검증 생략 옵션으로 통과시키지 않는다.

## 빈 DB 확인·Prisma 적용

앱·worker·gateway가 시작되지 않은 상태를 유지한다. 예제 DB·계정 이름을 변경하였다면 `psql -U/-d`도 함께 수정한다. 첫 SQL은 사용자 table·sequence·view·enum이 없는지 확인하며 존재하면 실패한다.

```sh
podman exec -i gp-postgres psql -U pcu -d pcu -v ON_ERROR_STOP=1 \
  < server/manual/sql/empty-database.sql
podman run --rm --pod graduationproject \
  --env-file /srv/pcu/config/app.env \
  -v /srv/pcu/config/ca.crt:/etc/pcu/ca.crt:ro,z \
  --entrypoint npm "$PCU_API_IMAGE" run db:migrate:deploy
podman run --rm --pod graduationproject \
  --env-file /srv/pcu/config/app.env \
  -v /srv/pcu/config/ca.crt:/etc/pcu/ca.crt:ro,z \
  --entrypoint npm "$PCU_API_IMAGE" exec -- prisma migrate status
podman exec gp-postgres psql -U pcu -d pcu -v ON_ERROR_STOP=1 \
  -c 'SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name;'
```

모든 migration의 성공·실패 상태를 확인한다. 기존 migration 파일을 수정하거나 `db push`·seed·`migrate resolve`로 실패를 우회하지 않는다. 이 직접 Prisma 명령은 **독립된 새 빈 DB**에만 적용한다. 기존 DB의 `release:migrate` baseline·preflight·backup 요구는 그대로 유지한다. 중간 실패한 새 DB도 자동 삭제하지 않으며 로그·migration table·schema를 먼저 조사한다.

## Bucket registry

`buckets.sql`의 두 bucket 이름을 Garage·`app.env`와 정합한 뒤 실행한다. 다른 이름으로 이미 등록된 registry를 자동으로 갱신하지 않는다. FK·object reference가 존재하면 기존 release 절차로 처리한다.

```sh
podman exec -i gp-postgres psql -U pcu -d pcu -v ON_ERROR_STOP=1 \
  < server/manual/sql/buckets.sql
podman exec gp-postgres psql -U pcu -d pcu -v ON_ERROR_STOP=1 \
  -c 'SELECT bucket, visibility FROM storage_buckets ORDER BY visibility;'
podman exec gp-postgres psql -U pcu -d pcu -v ON_ERROR_STOP=1 \
  -c 'SELECT count(*) FROM users; SELECT count(*) FROM auth_sessions;'
```

`PUBLIC=pcu-public`, `PROTECTED=pcu-protected` 각 1행, 사용자·session 0행을 확인한다. 개발 seed를 통한 전시·관리자 생성을 수행하지 않는다.

## 앱·gateway·Web 기동

설정·이미지·export 권한을 완료한 뒤 앱 unit을 설치한다. 외부 443 proxy는 마지막에 시작한다.

```sh
cp server/manual/rootless/*.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start gp-api.service
curl --fail http://127.0.0.1:4000/api/health
curl --fail http://127.0.0.1:4000/api/health/deep
systemctl --user start gp-worker-game-validation.service gp-worker-webgl.service \
  gp-worker-video.service gp-worker-image.service gp-worker-export.service \
  gp-worker-project-publication.service
systemctl --user start pcu-upload.service pcu-assets.service pcu-download.service pcu-web.service
podman exec pcu-upload nginx -t
podman exec pcu-assets nginx -t
podman exec pcu-download nginx -t
curl --fail http://127.0.0.1:8080/runtime-config.json
```

관리자 계정에서 rootful unit만 설치한다. 앞에서 rootful Nginx 이미지를 pull한 상태이어야 한다. rootful system service는 user service에 직접 `After=`를 걸 수 없으므로 준비 여부는 위 health와 이후 HTTPS 요청으로 확인한다. 재부팅 시 rootless 준비 전에는 일시적 502가 발생할 수 있다.

```sh
sudo install -d /etc/containers/systemd
sudo install -m 0644 server/manual/rootful/pcu-edge.container /etc/containers/systemd/
sudo systemctl daemon-reload
sudo systemctl start pcu-edge.service
curl --fail --cacert /srv/pcu/config/ca-bundle.crt https://api.pcu.test/api/health
curl --fail --cacert /srv/pcu/config/ca-bundle.crt https://web.pcu.test/runtime-config.json
```

[client IP 검사](single-pc.md#client-ip-검사)를 완료하고 운영자의 브라우저 CA 신뢰·DNS·Google client ID/origin을 확인한다. worker는 실제 job 완료로 판정하며 health 응답만으로 정상 판정하지 않는다.

## 최초 관리자

실제 인증으로 생성된 사용자 행에서 ID·Google subject·이름·email을 함께 확인한다. email만으로 대상을 선정하거나 로그인한 첫 사용자를 자동 승격하지 않는다. 테스트에서는 Google verifier를 주입한 전용 계정으로 같은 SQL을 검증한다.

```sh
podman exec gp-postgres psql -U pcu -d pcu -v ON_ERROR_STOP=1 \
  -c 'SELECT id, google_sub, email, name, role FROM users ORDER BY id;'
podman exec -i gp-postgres psql -U pcu -d pcu -v ON_ERROR_STOP=1 \
  -v user_id=VERIFIED_USER_ID -v google_subject=VERIFIED_GOOGLE_SUBJECT \
  < server/manual/sql/first-admin.sql
```

SQL은 transaction과 잠금 안에서 ID·subject가 일치하는 `USER` 한 명을 확인하고 한 행만 변경한다. 기존 ADMIN 존재·불일치·중복 적용은 실패한다. 해당 계정으로 `/api/me`와 관리자 기능을 확인하고 다른 사용자의 권한이 유지되는지 검사한다. 이후 관리자 변경은 일반 관리 기능과 [계정 운영 절차](../operations/faculty-accounts.md)를 따른다.
