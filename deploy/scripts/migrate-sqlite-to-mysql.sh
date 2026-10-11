#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source_sqlite="${1:-}"
[[ -n "$source_sqlite" && -f "$source_sqlite" ]] || { echo "用法：$0 /path/to/translation.sqlite" >&2; exit 1; }
default_env=.env
[[ ! -f .env.offline ]] || default_env=.env.offline
env_file="${ENV_FILE:-$default_env}"
[[ -f "$env_file" ]] || { echo "请先准备 $env_file。" >&2; exit 1; }
image="${BACKEND_IMAGE:-}"
# Read the image reference without expanding the full env file into logs.
if [[ -z "$image" ]]; then image="$(awk -F= '$1=="BACKEND_IMAGE" {print substr($0,index($0,"=")+1); exit}' "$env_file")"; fi
image="${image%@*}"
[[ -n "$image" ]] || { echo 'BACKEND_IMAGE 未配置。' >&2; exit 1; }
absolute_sqlite="$(cd "$(dirname "$source_sqlite")" && pwd)/$(basename "$source_sqlite")"
# The target MySQL schema is created idempotently by createDb before copying.
docker run --rm --network host --read-only --tmpfs /tmp \
  --env-file "$env_file" \
  -e DB_ENGINE=mysql -e MIGRATION_SQLITE_PATH=/migration/source.sqlite \
  -v "$absolute_sqlite:/migration/source.sqlite:ro" \
  "$image" node dist/migrate-sqlite-to-mysql.js
