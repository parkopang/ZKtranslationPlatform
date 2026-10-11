#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# An explicit online start uses the digest-pinned source .env even if an old
# offline configuration exists. Routine maintenance defaults to .env.offline.
env_file="${ENV_FILE:-.env}"
[[ -f "$env_file" ]] || { echo "请先准备 $env_file 并填写生产密钥。" >&2; exit 1; }
chmod 600 "$env_file"
compose=(docker compose --env-file "$env_file" -f docker-compose.yml)
"${compose[@]}" config --quiet
"${compose[@]}" pull backend frontend nginx
"${compose[@]}" up -d --pull always --no-build --wait --wait-timeout 180
"${compose[@]}" ps
ENV_FILE="$env_file" bash scripts/healthcheck.sh
