#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$DEPLOY_DIR/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_DIR/$STAMP"
mkdir -p "$DEST"
chmod 700 "$DEST"

default_env="$DEPLOY_DIR/.env"
[[ ! -f "$DEPLOY_DIR/.env.offline" ]] || default_env="$DEPLOY_DIR/.env.offline"
ENV_FILE="${ENV_FILE:-$default_env}"
[[ -f "$ENV_FILE" ]] || { echo "请先准备 $ENV_FILE。" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
COMPOSE=(docker compose -f "$DEPLOY_DIR/docker-compose.yml" --env-file "$ENV_FILE")

echo "Writing backup to $DEST"
if [[ "${DB_ENGINE:-mysql}" == "mysql" ]]; then
  command -v mysqldump >/dev/null 2>&1 || { echo '生产 MySQL 备份需要主机安装 mysqldump。' >&2; exit 1; }
  backup_host="${MYSQL_BACKUP_HOST:-${MYSQL_HOST:?MYSQL_HOST 未配置}}"
  backup_port="${MYSQL_BACKUP_PORT:-${MYSQL_PORT:-3306}}"
  backup_user="${MYSQL_BACKUP_USER:-${MYSQL_USER:?MYSQL_USER 未配置}}"
  backup_db="${MYSQL_BACKUP_DATABASE:-${MYSQL_DATABASE:?MYSQL_DATABASE 未配置}}"
  # MYSQL_PWD avoids putting the password in the process command line. Use the
  # allowlisted external host for maintenance, or leave it unset to use the
  # internal app host from .env.
  MYSQL_PWD="${MYSQL_BACKUP_PASSWORD:-${MYSQL_PASSWORD:?MYSQL_PASSWORD 未配置}}" \
    mysqldump --single-transaction --quick --routines --events --hex-blob \
      --host="$backup_host" --port="$backup_port" --user="$backup_user" "$backup_db" > "$DEST/mysql.sql"
  [[ -s "$DEST/mysql.sql" ]] || { echo 'MySQL dump 为空，备份已停止。' >&2; exit 1; }
  chmod 600 "$DEST/mysql.sql"
  printf 'engine=mysql\nhost=%s\nport=%s\ndatabase=%s\n' "$backup_host" "$backup_port" "$backup_db" > "$DEST/mysql.info"
  chmod 600 "$DEST/mysql.info"
elif [[ "${DB_ENGINE:-sqlite}" == "sqlite" ]]; then
  SQLITE_TMP="/tmp/translation.sqlite.${STAMP}"
  SQLITE_LOCAL_TMP="$DEST/.translation.sqlite.tmp"
  cleanup_sqlite() {
    rm -f "$SQLITE_LOCAL_TMP"
    "${COMPOSE[@]}" exec -T backend rm -f "$SQLITE_TMP" >/dev/null 2>&1 || true
  }
  trap cleanup_sqlite EXIT
  "${COMPOSE[@]}" exec -T -e "BACKUP_TMP=$SQLITE_TMP" backend node -e '
const Database = require("better-sqlite3");
const db = new Database("/app/data/translation.sqlite", { readonly: true });
db.backup(process.env.BACKUP_TMP).then(() => db.close()).catch((error) => { console.error(error); process.exit(1); });
'
  "${COMPOSE[@]}" exec -T backend cat "$SQLITE_TMP" > "$SQLITE_LOCAL_TMP"
  [[ -s "$SQLITE_LOCAL_TMP" ]] || { echo 'SQLite 导出为空，备份已停止。' >&2; exit 1; }
  chmod 600 "$SQLITE_LOCAL_TMP"
  mv "$SQLITE_LOCAL_TMP" "$DEST/translation.sqlite"
  "${COMPOSE[@]}" exec -T backend rm -f "$SQLITE_TMP"
  trap - EXIT
else
  echo "不支持的 DB_ENGINE=${DB_ENGINE:-unknown}。" >&2
  exit 1
fi

# COS is externally managed. Keep a non-secret manifest with the bucket and
# endpoint so the object-storage backup can be paired with the SQL dump. If
# AWS CLI is installed and COS_BACKUP_DIR is supplied, sync a private copy.
printf 'bucket=%s\nregion=%s\nendpoint=%s\nbase_url=%s\n' \
  "${COS_BUCKET:-${S3_BUCKET:-}}" "${COS_REGION:-${S3_REGION:-}}" \
  "${COS_ENDPOINT:-${S3_ENDPOINT:-}}" "${COS_BASE_URL:-}" > "$DEST/cos.info"
chmod 600 "$DEST/cos.info"
if [[ -n "${COS_BACKUP_DIR:-}" ]]; then
  command -v aws >/dev/null 2>&1 || { echo '设置 COS_BACKUP_DIR 后需要主机安装 aws CLI。' >&2; exit 1; }
  mkdir -p "$DEST/cos-objects"
  AWS_ACCESS_KEY_ID="${COS_ACCESS_KEY:-${S3_ACCESS_KEY:?COS_ACCESS_KEY 未配置}}" \
  AWS_SECRET_ACCESS_KEY="${COS_SECRET_KEY:-${S3_SECRET_KEY:?COS_SECRET_KEY 未配置}}" \
    aws s3 sync "s3://${COS_BUCKET:-${S3_BUCKET}}" "$DEST/cos-objects" \
      --endpoint-url "${COS_ENDPOINT:-${S3_ENDPOINT}}" --only-show-errors
fi

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$DEST" && sha256sum -- * 2>/dev/null) > "$DEST/SHA256SUMS"
else
  (cd "$DEST" && shasum -a 256 -- * 2>/dev/null) > "$DEST/SHA256SUMS"
fi
chmod 600 "$DEST/SHA256SUMS"
ln -sfn "$STAMP" "$BACKUP_DIR/latest"
echo "Backup complete: $DEST"
