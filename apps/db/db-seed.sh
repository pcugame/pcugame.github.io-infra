#!/usr/bin/env bash
# db-seed.sh — 서버에서 테스트 DB 적재 / 작품 수동 추가 / DB 점검
# 위치: apps/db/db-seed.sh (프로덕션 서버에서 Podman 컨테이너 대상 실행)
# Usage:
#   ./db-seed.sh seed
#   ./db-seed.sh import-json /path/to/data.json
#   ./db-seed.sh add-project
#   ./db-seed.sh tables
#   ./db-seed.sh psql
#   ./db-seed.sh reset
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/srv/graduationproject_v2}"
ENV_FILE="${DEPLOY_DIR}/.env"
PG_CONTAINER="${PG_CONTAINER:-gp-postgres}"
API_CONTAINER="${API_CONTAINER:-gp-api}"

load_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: .env not found at $ENV_FILE"
    exit 1
  fi

  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
}

require_container_running() {
  local container="$1"
  if ! podman container exists "$container" 2>/dev/null; then
    echo "ERROR: container '$container' does not exist."
    echo "먼저 서버에서 백엔드가 실행 중인지 확인하세요."
    exit 1
  fi

  local state
  state="$(podman inspect -f '{{.State.Status}}' "$container" 2>/dev/null || true)"
  if [[ "$state" != "running" ]]; then
    echo "ERROR: container '$container' is not running. current state: ${state:-unknown}"
    exit 1
  fi
}

run_sql() {
  require_container_running "$PG_CONTAINER"
  podman exec -i "$PG_CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" "$@"
}

exec_api() {
  require_container_running "$API_CONTAINER"
  podman exec -i "$API_CONTAINER" "$@"
}

json_escape() {
  local value="${1-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

append_json_field() {
  local target_var="$1"
  local key="$2"
  local raw_value="${3-}"
  local escaped
  escaped="$(json_escape "$raw_value")"

  if [[ -n "${!target_var}" ]]; then
    printf -v "$target_var" '%s,\n      "%s": "%s"' "${!target_var}" "$key" "$escaped"
  else
    printf -v "$target_var" '      "%s": "%s"' "$key" "$escaped"
  fi
}

copy_json_to_container_and_run() {
  local json_file="$1"
  local remote_path="/tmp/pcu-seed-$(date +%s)-$$.json"

  require_container_running "$API_CONTAINER"

  echo "Importing JSON via Prisma seed: $json_file"
  podman cp "$json_file" "${API_CONTAINER}:${remote_path}"
  podman exec -e NODE_ENV=development "$API_CONTAINER" sh -lc \
    "set -e; npx tsx prisma/seed.ts --import '$remote_path' && rm -f '$remote_path'"
}

do_seed() {
  require_container_running "$API_CONTAINER"
  echo "=== Prisma seed 실행 ==="
  echo "테스트 ADMIN + 세션 + 테스트 프로젝트를 생성합니다."
  podman exec -e NODE_ENV=development "$API_CONTAINER" npx tsx prisma/seed.ts
}

do_import_json() {
  local json_file="${1:-}"
  if [[ -z "$json_file" ]]; then
    echo "Usage: $0 import-json /absolute/or/relative/path/to/data.json"
    exit 1
  fi

  if [[ ! -f "$json_file" ]]; then
    echo "ERROR: JSON file not found: $json_file"
    exit 1
  fi

  copy_json_to_container_and_run "$json_file"
}

do_add_project() {
  local year=""
  local year_title=""
  local is_open=""
  local title=""
  local slug=""
  local summary=""
  local description=""
  local video_url=""
  local status=""
  local members_json=""
  local members_block=""
  local project_fields=""
  local year_title_escaped=""
  local temp_json=""

  echo "=== 작품 수동 추가 ==="
  echo "입력한 값으로 JSON 임포트 데이터를 만들어 Prisma seed로 적재합니다."
  echo "creator는 seed 스크립트가 생성하는 Test Admin 계정을 사용합니다."
  echo ""

  read -rp "연도 (예: 2026): " year
  [[ "$year" =~ ^[0-9]{4}$ ]] || { echo "ERROR: 연도는 4자리 숫자여야 합니다."; exit 1; }

  read -rp "연도 제목 [${year} 졸업작품전]: " year_title
  year_title="${year_title:-${year} 졸업작품전}"

  read -rp "연도 공개 여부 (true/false) [true]: " is_open
  is_open="${is_open:-true}"
  [[ "$is_open" == "true" || "$is_open" == "false" ]] || {
    echo "ERROR: 연도 공개 여부는 true 또는 false 여야 합니다."
    exit 1
  }

  read -rp "작품 제목: " title
  [[ -n "$title" ]] || { echo "ERROR: 작품 제목은 필수입니다."; exit 1; }

  read -rp "슬러그 (비우면 자동 생성): " slug
  read -rp "한 줄 소개 [선택]: " summary

  echo "상세 설명 입력 후 Enter, 종료는 빈 줄에서 Enter"
  while IFS= read -r line; do
    [[ -z "$line" ]] && break
    if [[ -n "$description" ]]; then
      description+=$'\n'
    fi
    description+="$line"
  done

  read -rp "영상 URL (NAS) [선택]: " video_url
  read -rp "상태 (DRAFT/PUBLISHED/ARCHIVED) [PUBLISHED]: " status
  status="${status:-PUBLISHED}"
  case "$status" in
    DRAFT|PUBLISHED|ARCHIVED) ;;
    *) echo "ERROR: 상태는 DRAFT, PUBLISHED, ARCHIVED 중 하나여야 합니다."; exit 1 ;;
  esac

  echo ""
  echo "멤버 추가"
  local member_index=0
  while true; do
    local member_name=""
    local student_id=""
    local member_name_escaped=""
    local student_id_escaped=""

    read -rp "멤버 이름 (종료하려면 빈 값): " member_name
    [[ -z "$member_name" ]] && break

    read -rp "학번 [선택]: " student_id

    member_name_escaped="$(json_escape "$member_name")"
    student_id_escaped="$(json_escape "$student_id")"

    if [[ -n "$members_json" ]]; then
      members_json+=","
      members_json+=$'\n'
    fi

    members_json+="        {\"name\": \"${member_name_escaped}\", \"studentId\": \"${student_id_escaped}\", \"sortOrder\": ${member_index}}"
    member_index=$((member_index + 1))
  done

  append_json_field project_fields "title" "$title"
  append_json_field project_fields "summary" "$summary"
  append_json_field project_fields "description" "$description"
  append_json_field project_fields "videoUrl" "$video_url"
  append_json_field project_fields "status" "$status"

  if [[ -n "$slug" ]]; then
    append_json_field project_fields "slug" "$slug"
  fi

  year_title_escaped="$(json_escape "$year_title")"
  temp_json="$(mktemp)"

  if [[ -n "$members_json" ]]; then
    members_block=$(printf ',\n      "members": [\n%s\n      ]' "$members_json")
  fi

  cat >"$temp_json" <<EOF
{
  "years": [
    {
      "year": ${year},
      "title": "${year_title_escaped}",
      "isUploadEnabled": ${is_open}
    }
  ],
  "projects": [
    {
      "year": ${year},
${project_fields}${members_block}
    }
  ]
}
EOF

  echo ""
  echo "생성된 임포트 데이터 미리보기:"
  cat "$temp_json"
  echo ""

  read -rp "위 내용으로 작품을 추가할까요? (y/n) [y]: " confirm
  confirm="${confirm:-y}"
  if [[ "$confirm" != "y" ]]; then
    rm -f "$temp_json"
    echo "취소했습니다."
    exit 0
  fi

  copy_json_to_container_and_run "$temp_json"
  rm -f "$temp_json"
}

do_psql() {
  require_container_running "$PG_CONTAINER"
  echo "Connecting to PostgreSQL (exit with \\q)..."
  podman exec -it "$PG_CONTAINER" psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}"
}

do_tables() {
  echo "=== Tables ==="
  run_sql -c "\dt"
  echo ""
  echo "=== Row counts ==="
  run_sql <<'SQL'
SELECT 'users' AS "table", COUNT(*) FROM users
UNION ALL SELECT 'exhibitions', COUNT(*) FROM exhibitions
UNION ALL SELECT 'projects', COUNT(*) FROM projects
UNION ALL SELECT 'project_members', COUNT(*) FROM project_members
UNION ALL SELECT 'assets', COUNT(*) FROM assets
UNION ALL SELECT 'auth_sessions', COUNT(*) FROM auth_sessions
UNION ALL SELECT 'game_upload_sessions', COUNT(*) FROM game_upload_sessions
UNION ALL SELECT 'banned_ips', COUNT(*) FROM banned_ips
ORDER BY "table";
SQL
}

do_reset() {
  echo "WARNING: 이 작업은 DB 데이터를 전부 삭제합니다."
  read -rp "정말 진행하려면 'yes'를 입력하세요: " confirm
  [[ "$confirm" == "yes" ]] || { echo "취소했습니다."; exit 0; }

  run_sql <<'SQL'
TRUNCATE
  game_upload_sessions,
  banned_ips,
  site_settings,
  upload_jobs,
  auth_sessions,
  assets,
  project_members,
  projects,
  exhibitions,
  users
RESTART IDENTITY
CASCADE;
SQL

  echo "모든 테이블 데이터를 비웠습니다."
}

load_env

case "${1:-help}" in
  seed)        do_seed ;;
  import-json) do_import_json "${2:-}" ;;
  add-project) do_add_project ;;
  psql)        do_psql ;;
  tables)      do_tables ;;
  reset)       do_reset ;;
  *)
    cat <<EOF
Usage: $0 {seed|import-json <file>|add-project|psql|tables|reset}

  seed               테스트 ADMIN/세션/테스트 프로젝트 생성
  import-json <file> JSON 파일을 Prisma seed로 임포트
  add-project        작품 1건을 대화형으로 입력해서 임포트
  psql               PostgreSQL 콘솔 접속
  tables             주요 테이블 목록/건수 확인
  reset              전체 데이터 삭제 (위험)

예시:
  $0 seed
  $0 import-json /srv/graduationproject_v2/data/projects.json
  $0 add-project
EOF
    ;;
esac
