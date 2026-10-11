#!/usr/bin/env bash
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$dir/../.." && pwd)"
# Run npm ci in backend/frontend/simulation first if local dependencies are absent.
# These runtime builds reuse the release's native dependencies. If dependencies
# change, build new release base images with the normal project Dockerfiles first.
npm --prefix "$root/backend" run build
npm --prefix "$root/frontend" run build
docker buildx build --platform linux/amd64 --provenance=false --sbom=false --network none --load -f "$dir/Dockerfile.backend-runtime" -t translation-platform/test-backend:0.2.2 "$root"
docker buildx build --platform linux/amd64 --provenance=false --sbom=false --network none --load -f "$dir/Dockerfile.frontend-runtime" -t translation-platform/test-frontend:0.2.2 "$root"
docker buildx build --platform linux/amd64 --provenance=false --sbom=false --network none --load -f "$dir/Dockerfile.nginx" -t translation-platform/test-nginx:0.2.2 "$dir"
