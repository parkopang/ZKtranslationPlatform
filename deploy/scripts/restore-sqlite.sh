#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "Usage: $0 /path/to/translation.sqlite" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
COMPOSE=(docker compose -f "$DEPLOY_DIR/docker-compose.yml")
default_env="$DEPLOY_DIR/.env"
[[ ! -f "$DEPLOY_DIR/.env.offline" ]] || default_env="$DEPLOY_DIR/.env.offline"
ENV_FILE="${ENV_FILE:-$default_env}"
[[ -f "$ENV_FILE" ]] || { echo "请先准备 $ENV_FILE。" >&2; exit 1; }
COMPOSE+=(--env-file "$ENV_FILE")

BACKEND_CONTAINER="$("${COMPOSE[@]}" ps -aq backend)"
if [[ -z "$BACKEND_CONTAINER" ]]; then
  echo "Backend container does not exist. Run docker compose up -d once first." >&2
  exit 1
fi
BACKEND_IMAGE="$(docker inspect --format '{{.Image}}' "$BACKEND_CONTAINER")"
BACKEND_WAS_RUNNING="$(docker inspect --format '{{.State.Running}}' "$BACKEND_CONTAINER")"
RESTORE_WORK_DIR="/app/data/.restore-$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}"
RESTORE_PROGRAM="$(cat "$SCRIPT_DIR/sqlite-restore.cjs")"
backend_stopped=0
restore_succeeded=0
run_restore_phase() {
  docker run --rm -i --pull never --network none --read-only --user 0 \
    --volumes-from "$BACKEND_CONTAINER" -e "RESTORE_WORK_DIR=$RESTORE_WORK_DIR" \
    --entrypoint node "$BACKEND_IMAGE" -e "$RESTORE_PROGRAM" "$1"
}
cleanup_restore() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$restore_succeeded" -ne 1 && "$backend_stopped" -eq 1 ]]; then
    # A failed health check can leave the restored app running. Stop it before
    # restoring the saved database and removing the failed version's WAL.
    if "${COMPOSE[@]}" stop backend >/dev/null 2>&1 && run_restore_phase rollback; then
      if [[ "$BACKEND_WAS_RUNNING" == true ]]; then
        "${COMPOSE[@]}" start --wait --wait-timeout 180 backend >/dev/null 2>&1 || \
          echo '原数据库已恢复，但后端未就绪；请检查日志。' >&2
      fi
    else
      echo "自动回滚失败；后端保持停止，请从 $RESTORE_WORK_DIR/before.sqlite 恢复。" >&2
    fi
  fi
  run_restore_phase cleanup >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup_restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo 'Validating backup before stopping backend...'
run_restore_phase validate < "$1"
echo 'Stopping backend briefly to restore SQLite data...'
backend_stopped=1
"${COMPOSE[@]}" stop backend >/dev/null
run_restore_phase install
"${COMPOSE[@]}" start --wait --wait-timeout 180 backend >/dev/null
restore_succeeded=1
echo "SQLite restored; backend is ready. Rollback snapshot retained at $RESTORE_WORK_DIR/before.sqlite (inside translation_data)."
