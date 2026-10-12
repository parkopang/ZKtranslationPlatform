#!/usr/bin/env bash
set -euo pipefail

# Run this on a machine with registry access. It exports the production app
# images referenced by the default Compose profile. MySQL, Redis and COS are
# external production services; simulation-only middleware is profile-gated.
cd "$(dirname "$0")/.."
env_file="${ENV_FILE:-.env}"
[[ -f "$env_file" ]] || env_file=.env.example
bundle_tag="${IMAGE_BUNDLE_TAG:-0.2.5}"
bundle_dir="${OFFLINE_BUNDLE_DIR:-offline}"
archive="$bundle_dir/translation-platform-images-${bundle_tag}.tar.gz"
manifest="$bundle_dir/translation-platform-images-${bundle_tag}.manifest.txt"

mkdir -p "$bundle_dir"
docker compose --env-file "$env_file" -f docker-compose.yml config --quiet
images=()
while IFS= read -r image; do
  [[ -n "$image" ]] && images+=("$image")
done < <(docker compose --env-file "$env_file" -f docker-compose.yml config --images | sort -u)
[[ "${#images[@]}" -gt 0 ]] || { echo '未找到 Compose 镜像。' >&2; exit 1; }

missing=()
for image in "${images[@]}"; do
  docker image inspect "$image" >/dev/null 2>&1 || missing+=("$image")
done
if [[ "${#missing[@]}" -gt 0 ]]; then
  echo '以下镜像尚未拉取，先在联网环境执行 docker compose pull：' >&2
  printf '  %s\n' "${missing[@]}" >&2
  exit 2
fi

# A digest-pinned Compose reference is ideal for online pulls, but Docker
# load stores the tag and does not recreate the registry's RepoDigest. Create
# canonical tag aliases before saving so an air-gapped host can start with
# --pull never; the manifest and archive checksum still provide integrity.
save_images=()
printf '%s\n' "# generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$manifest"
printf '%s\n' "# source_env=$env_file" >> "$manifest"
for image in "${images[@]}"; do
  image_id=$(docker image inspect "$image" --format '{{.Id}}')
  digest=$(docker image inspect "$image" --format '{{join .RepoDigests " "}}')
  size=$(docker image inspect "$image" --format '{{.Size}}')
  canonical="${image%@*}"
  docker tag "$image_id" "$canonical"
  save_images+=("$canonical")
  printf '%s\tsize_bytes=%s\trepo_digests=%s\n' "$image" "$size" "$digest" >> "$manifest"
done

tmp_archive="${archive}.tmp"
rm -f "$tmp_archive"
docker save "${save_images[@]}" | gzip -1 > "$tmp_archive"
mv "$tmp_archive" "$archive"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$archive" > "$archive.sha256"
else
  shasum -a 256 "$archive" > "$archive.sha256"
fi
echo "已生成离线镜像包：$archive"
echo "校验文件：$archive.sha256"
echo "镜像清单：$manifest"
