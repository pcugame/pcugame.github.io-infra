# Synology NAS에 Garage 설치 가이드

Synology Container Manager(구 Docker)에서 Garage를 실행하고, DSM 리버스 프록시로 HTTPS를 제공하는 설정 가이드.

---

## 1. 공유 폴더 준비

DSM > 제어판 > 공유 폴더에서 Garage 전용 폴더를 만듭니다.

| 폴더 이름 | 용도 | 권장 위치 |
|-----------|------|-----------|
| `garage` | Garage 데이터 + 메타데이터 + 설정 | 볼륨 1 (또는 원하는 볼륨) |

폴더 안에 하위 디렉토리 생성 (SSH 또는 File Station):
```bash
mkdir -p /volume1/garage/data
mkdir -p /volume1/garage/meta
mkdir -p /volume1/garage/config
```

## 2. Garage 설정 파일 작성

`/volume1/garage/config/garage.toml` 파일을 생성합니다:

```toml
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"

replication_factor = 1

[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
root_domain = ".s3.garage.localhost"

[s3_web]
bind_addr = "[::]:3902"
root_domain = ".web.garage.localhost"

[admin]
api_bind_addr = "[::]:3903"
# 프로덕션에서는 강력한 토큰으로 변경하세요!
admin_token = "여기에-강력한-랜덤-토큰-입력"

[rpc]
bind_addr = "[::]:3901"
# 단일 노드이므로 임의 64자 hex. 멀티노드 시 동일해야 함.
secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
```

> **주의**: `admin_token`과 `rpc.secret`은 프로덕션에서 반드시 랜덤한 값으로 변경하세요.
> 생성 방법: `openssl rand -hex 32`

## 3. Container Manager에서 컨테이너 생성

### 3-1. 이미지 다운로드
Container Manager > 레지스트리 > `dxflrs/garage` 검색 > `v1.1.0` 태그 다운로드

### 3-2. 컨테이너 설정

| 설정 | 값 |
|------|-----|
| 이미지 | `dxflrs/garage:v1.1.0` |
| 네트워크 | `bridge` |
| 재시작 정책 | 항상 |

**포트 매핑:**

| 로컬 포트 | 컨테이너 포트 | 용도 |
|-----------|-------------|------|
| 3900 | 3900 | S3 API |
| 3901 | 3901 | RPC (내부) |
| 3902 | 3902 | Web gateway |
| 3903 | 3903 | Admin API |

**볼륨 마운트:**

| NAS 경로 | 컨테이너 경로 | 모드 |
|----------|-------------|------|
| `/volume1/garage/config/garage.toml` | `/etc/garage.toml` | 읽기 전용 |
| `/volume1/garage/data` | `/var/lib/garage/data` | 읽기/쓰기 |
| `/volume1/garage/meta` | `/var/lib/garage/meta` | 읽기/쓰기 |

### 3-3. 컨테이너 시작

컨테이너를 시작한 후, SSH로 NAS에 접속하여 초기 설정을 진행합니다.

## 4. Garage 초기 설정 (SSH)

NAS에 SSH 접속 후:

```bash
# 컨테이너 이름 확인
sudo docker ps | grep garage

# 컨테이너 안에서 명령 실행 (컨테이너 이름에 맞게 수정)
CONTAINER_NAME=garage  # 실제 컨테이너 이름으로 변경

# 4-1. 노드 레이아웃 설정
NODE_ID=$(sudo docker exec $CONTAINER_NAME garage -c /etc/garage.toml node id 2>/dev/null | head -1 | cut -d@ -f1)
sudo docker exec $CONTAINER_NAME garage -c /etc/garage.toml layout assign "$NODE_ID" -z dc1 -c 1T
sudo docker exec $CONTAINER_NAME garage -c /etc/garage.toml layout apply --version 1

# 4-2. 버킷 생성
sudo docker exec $CONTAINER_NAME garage -c /etc/garage.toml bucket create pcu-public
sudo docker exec $CONTAINER_NAME garage -c /etc/garage.toml bucket create pcu-protected

# 4-3. 접근 키 생성
sudo docker exec $CONTAINER_NAME garage -c /etc/garage.toml key create pcu-api-key

# 4-4. 버킷 권한 부여
sudo docker exec $CONTAINER_NAME garage -c /etc/garage.toml bucket allow pcu-public --read --write --owner --key pcu-api-key
sudo docker exec $CONTAINER_NAME garage -c /etc/garage.toml bucket allow pcu-protected --read --write --owner --key pcu-api-key

# 4-5. 키 정보 확인 (이 값을 API .env에 넣습니다)
sudo docker exec $CONTAINER_NAME garage -c /etc/garage.toml key info pcu-api-key
```

`key info` 출력에서 **Key ID**와 **Secret key**를 복사하세요.

## 5. DSM 리버스 프록시 설정 (HTTPS)

DSM > 제어판 > 로그인 포털 > 고급 > 리버스 프록시

### 규칙 추가:

| 항목 | 값 |
|------|-----|
| 설명 | Garage S3 API |
| 소스 프로토콜 | HTTPS |
| 소스 호스트명 | `s3.your-domain.com` (또는 NAS 도메인) |
| 소스 포트 | 443 |
| 대상 프로토콜 | HTTP |
| 대상 호스트명 | `localhost` |
| 대상 포트 | 3900 |

### SSL 인증서:
- Synology DSM의 Let's Encrypt 인증서를 사용하거나
- 제어판 > 보안 > 인증서에서 도메인 인증서를 추가

### 커스텀 헤더 (선택):
리버스 프록시 규칙 편집 > 사용자 정의 헤더에 추가:
```
X-Forwarded-Proto: https
```

> **DDNS 사용 시**: DSM > 제어판 > 외부 접근 > DDNS에서 Synology DDNS 또는 커스텀 도메인을 설정하면 자동으로 Let's Encrypt 인증서를 받을 수 있습니다.

## 6. API 서버 .env 설정

프로덕션 API 서버의 `.env`:

```env
S3_ENDPOINT=https://s3.your-domain.com
S3_REGION=garage
S3_ACCESS_KEY_ID=<4단계에서 복사한 Key ID>
S3_SECRET_ACCESS_KEY=<4단계에서 복사한 Secret key>
S3_BUCKET_PUBLIC=pcu-public
S3_BUCKET_PROTECTED=pcu-protected
S3_FORCE_PATH_STYLE=true
S3_PRESIGN_TTL_SEC=60
```

## 7. 연결 테스트

API 서버에서:
```bash
# S3 연결 확인 (AWS CLI 또는 curl)
curl -s https://s3.your-domain.com/ | head

# 또는 API 헬스체크
curl http://localhost:4000/api/health
# → {"ok": true, "checks": {"db": "ok", "s3": "ok"}}
```

## 8. 방화벽 / 포트 참고

| 포트 | 용도 | 외부 노출 필요 |
|------|------|--------------|
| 3900 | S3 API | 리버스 프록시가 처리 → **직접 노출 불필요** |
| 3901 | RPC | **불필요** (단일 노드) |
| 3902 | Web gateway | **불필요** (사용 안 함) |
| 3903 | Admin API | **절대 노출 금지** (로컬만) |
| 443 | 리버스 프록시 HTTPS | API 서버에서 접근 가능해야 함 |

## 용량 참고

- `layout assign`의 `-c 1T`는 Garage에 1TB를 할당한다는 의미입니다
- 실제 NAS 볼륨 용량에 맞게 조절하세요 (예: `-c 500G`, `-c 2T`)
- Garage는 이 값을 초과해도 즉시 중단하지 않지만, 경고를 발생시킵니다
