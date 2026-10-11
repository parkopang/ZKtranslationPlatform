#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
default_env="$DEPLOY_DIR/.env"
[[ ! -f "$DEPLOY_DIR/.env.offline" ]] || default_env="$DEPLOY_DIR/.env.offline"
ENV_FILE="${ENV_FILE:-$default_env}"
[[ -f "$ENV_FILE" ]] || { echo "请先准备 $ENV_FILE。" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
COMPOSE=(docker compose -f "$DEPLOY_DIR/docker-compose.yml" --env-file "$ENV_FILE")
HTTP_PORT="${HTTP_PORT:-80}"
if [[ "$HTTP_PORT" == *:* ]]; then
  health_host="${HTTP_PORT%:*}"
  health_port="${HTTP_PORT##*:}"
else
  health_host=127.0.0.1
  health_port="$HTTP_PORT"
fi
case "$health_host" in 0.0.0.0) health_host=127.0.0.1;; '[::]'|'::') health_host='[::1]';; esac
health_base="http://${health_host}:${health_port}"

echo "== container state =="
"${COMPOSE[@]}" ps

echo "== public health endpoint =="
curl --fail --silent --show-error "${health_base}/api/health" >/dev/null
echo "HTTP /api/health: OK"
curl --fail --silent --show-error "${health_base}/api/readyz" >/dev/null
echo "HTTP /api/readyz: OK"

echo "== dependency checks =="
# Production uses externally managed MySQL, Redis and COS. /readyz already
# performs a live database query and checks the Redis worker/storage config;
# avoid assuming local service names or leaking connection credentials here.
if [[ "${DB_ENGINE:-mysql}" == "sqlite" ]]; then
  echo "Database: SQLite volume"
elif [[ "${DB_ENGINE:-mysql}" == "mysql" ]]; then
  echo "Database: external MySQL (readyz query: OK)"
else
  echo "Database: ${DB_ENGINE:-unknown} (readyz query: OK)"
fi
if [[ "${REDIS_URL:-}" == *"@redis:"* ]]; then
  "${COMPOSE[@]}" --profile simulation exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping' | grep -q PONG
  echo "Redis local simulation: OK"
else
  echo "Redis: external instance (readyz worker: OK)"
fi
if [[ "${S3_ENDPOINT:-}" == http://minio:* ]]; then
  "${COMPOSE[@]}" --profile simulation exec -T minio sh -c 'curl --fail --silent http://127.0.0.1:9000/minio/health/live >/dev/null'
  echo "MinIO local simulation: OK"
else
  echo "COS: external object storage (configuration: OK)"
fi
