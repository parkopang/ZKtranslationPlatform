#!/usr/bin/env bash
set -euo pipefail

# Run this on the isolated/air-gapped deployment host. No pull or build is
# attempted; every Compose image must already exist in the loaded archive.
cd "$(dirname "$0")/.."
default_env=.env
[[ ! -f .env.offline ]] || default_env=.env.offline
env_file="${ENV_FILE:-$default_env}"
[[ -f "$env_file" ]] || { echo "请先准备 $env_file。" >&2; exit 1; }
bundle_tag="${IMAGE_BUNDLE_TAG:-0.2.4}"
archive="${OFFLINE_IMAGE_ARCHIVE:-offline/translation-platform-images-${bundle_tag}.tar.gz}"
[[ -f "$archive" ]] || { echo "找不到离线镜像包：$archive" >&2; exit 1; }

# Verify the actual file before Docker sees it. Ignore the filename recorded
# in the sidecar so copying the archive to an absolute path remains supported.
checksum_file="${archive}.sha256"
[[ -f "$checksum_file" ]] || { echo "缺少校验文件：$checksum_file" >&2; exit 1; }
expected_sha=$(awk 'NR == 1 {print $1}' "$checksum_file")
[[ "$expected_sha" =~ ^[0-9a-fA-F]{64}$ ]] || { echo '无效的 SHA-256 校验文件。' >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  actual_sha=$(sha256sum "$archive" | awk '{print $1}')
else
  actual_sha=$(shasum -a 256 "$archive" | awk '{print $1}')
fi
[[ "$expected_sha" == "$actual_sha" ]] || { echo '离线镜像包校验失败，拒绝加载和启动。' >&2; exit 1; }

if [[ "$archive" == *.gz ]]; then
  gzip -dc "$archive" | docker load
else
  docker load --input "$archive"
fi

# `docker load` restores tags but not the source registry's RepoDigest. The
# archive checksum and generated manifest provide integrity; strip only the
# digest suffix for local name resolution after the verified load.
runtime_env=.env.offline
temporary_env="$(mktemp .env.offline.XXXXXX)"
trap 'rm -f "$temporary_env"' EXIT
chmod 600 "$temporary_env"
sed -E '/^(BACKEND|FRONTEND|POSTGRES|REDIS|MINIO|MINIO_MC|NGINX)_IMAGE=/ s/@sha256:[0-9a-fA-F]{64}//' "$env_file" > "$temporary_env"
docker compose --env-file "$temporary_env" -f docker-compose.yml config --quiet
mv "$temporary_env" "$runtime_env"
chmod 600 "$runtime_env"

compose=(docker compose --env-file "$runtime_env" -f docker-compose.yml)
"${compose[@]}" config --quiet
"${compose[@]}" up -d --pull never --no-build --wait --wait-timeout 180
ENV_FILE="$runtime_env" bash scripts/healthcheck.sh
echo '离线配置已保存到 deploy/.env.offline；日常运维脚本会优先使用它。'
