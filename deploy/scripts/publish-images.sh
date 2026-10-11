#!/usr/bin/env bash
set -euo pipefail

# Pushes only the translation images. Keep credentials outside this script;
# authenticate with `docker login` before running it. By default, reuse the
# existing Tencent TCR translation-platform component repositories.
registry="${REGISTRY_HOST:-jszt-tcr.tencentcloudcr.com}"
namespace="${REGISTRY_NAMESPACE:-psp}"
prefix="${REGISTRY_REPOSITORY_PREFIX:-translation-platform}"
tag="${IMAGE_TAG:-0.2.0}"

local_backend="${SOURCE_BACKEND_IMAGE:-translation-platform/backend:${tag}}"
local_frontend="${SOURCE_FRONTEND_IMAGE:-translation-platform/frontend:${tag}}"
remote_backend="${registry}/${namespace}/${prefix}-backend:${tag}"
remote_frontend="${registry}/${namespace}/${prefix}-frontend:${tag}"
# Set REGISTRY_REPOSITORY explicitly to retain the former single-repo layout.
if [[ -n "${REGISTRY_REPOSITORY:-}" ]]; then
  remote_backend="${registry}/${namespace}/${REGISTRY_REPOSITORY}:backend-${tag}"
  remote_frontend="${registry}/${namespace}/${REGISTRY_REPOSITORY}:frontend-${tag}"
fi

docker image inspect "$local_backend" >/dev/null
docker image inspect "$local_frontend" >/dev/null

docker tag "$local_backend" "$remote_backend"
docker tag "$local_frontend" "$remote_frontend"
docker push "$remote_backend"
docker push "$remote_frontend"

cat <<EOF
Pushed translation-platform images:
  $remote_backend
  $remote_frontend
Set these values in deploy/.env on the operations host:
  BACKEND_IMAGE=$remote_backend
  FRONTEND_IMAGE=$remote_frontend
EOF
