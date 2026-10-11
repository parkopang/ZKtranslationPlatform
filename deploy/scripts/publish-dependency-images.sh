#!/usr/bin/env bash
set -euo pipefail

# Mirror all runtime dependencies into translation-platform component repositories.
# Authenticate first with `docker login`; this script never
# receives or prints registry credentials.
registry="${REGISTRY_HOST:-jszt-tcr.tencentcloudcr.com}"
namespace="${REGISTRY_NAMESPACE:-psp}"
prefix="${REGISTRY_REPOSITORY_PREFIX:-translation-platform}"
release="${IMAGE_TAG:-0.2.0}"
deploy_dir="$(cd "$(dirname "$0")/.." && pwd)"
remote_base="${registry}/${namespace}"

# MinIO's Docker Hub publication is not stable anymore. Override these source
# refs when the connected mirror uses another approved source.
declare -a images=(
  "${SOURCE_POSTGRES_IMAGE:-postgres:16-alpine}|postgres-16-alpine"
  "${SOURCE_REDIS_IMAGE:-redis:7-alpine}|redis-7-alpine"
  "${SOURCE_MINIO_IMAGE:-minio/minio:RELEASE.2025-02-18T16-25-55Z}|minio-RELEASE.2025-02-18T16-25-55Z"
  "${SOURCE_MINIO_MC_IMAGE:-minio/mc:RELEASE.2025-02-21T16-00-46Z}|mc-RELEASE.2025-02-21T16-00-46Z"
  "${SOURCE_NGINX_IMAGE:-translation-platform/nginx:${release}}|nginx-configured"
)

for item in "${images[@]}"; do
  source_image="${item%%|*}"
  tag="${item##*|}"
  case "$tag" in
    postgres-*) component=postgres ;;
    redis-*) component=redis ;;
    minio-*) component=minio ;;
    mc-*) component=minio-mc ;;
    nginx-configured) component=nginx ;;
  esac
  target="${remote_base}/${prefix}-${component}:${release}"
  if [[ -n "${REGISTRY_REPOSITORY:-}" ]]; then
    target="${remote_base}/${REGISTRY_REPOSITORY}:${tag}-${release}"
  fi
  if ! docker image inspect "$source_image" >/dev/null 2>&1; then
    if [[ "$tag" == nginx-configured && -z "${SOURCE_NGINX_IMAGE:-}" ]]; then
      docker buildx build --platform linux/amd64 --provenance=false --sbom=false --load -t "$source_image" "$deploy_dir/nginx"
    else
      docker pull "$source_image"
    fi
  fi
  docker tag "$source_image" "$target"
  docker push "$target"
  digest=$(docker buildx imagetools inspect "$target" 2>/dev/null | awk '$1 == "Digest:" {print $2; exit}')
  printf 'Pushed %-100s %s\n' "$target" "${digest:-digest-unavailable}"
done
