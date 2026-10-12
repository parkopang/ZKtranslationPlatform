#!/usr/bin/env bash
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
if ! docker image inspect translation-platform/test-backend:0.2.5 >/dev/null 2>&1 || ! docker image inspect translation-platform/test-frontend:0.2.5 >/dev/null 2>&1 || ! docker image inspect translation-platform/test-nginx:0.2.5 >/dev/null 2>&1; then
  echo '请先构建测试专用镜像，参见本目录 README。' >&2
  exit 1
fi
compose=(docker compose --profile simulation -p translation-platform-simulation --env-file "$dir/.env" -f "$dir/../docker-compose.yml" -f "$dir/compose.override.yml")
"${compose[@]}" config --quiet
"${compose[@]}" up -d --pull never --no-build --wait --wait-timeout 180
"${compose[@]}" exec -T backend node /simulation/seed.mjs
echo '测试环境：http://localhost:18082/simulation/'
