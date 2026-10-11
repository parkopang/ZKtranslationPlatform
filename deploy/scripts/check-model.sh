#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
default_env=.env
[[ ! -f .env.offline ]] || default_env=.env.offline
env_file="${ENV_FILE:-$default_env}"
[[ -f "$env_file" ]] || { echo "请先准备 $env_file。" >&2; exit 1; }

# One short synthetic request using the running container's provider settings.
# This verifies real API access; readiness deliberately checks configuration only.
docker compose --env-file "$env_file" -f docker-compose.yml exec -T backend node --input-type=module <<'JS'
process.env.LLM_RETRY_ATTEMPTS = '1';
process.env.LLM_TOTAL_TIMEOUT_MS = '45000';
const { pretranslate, getModelConfiguration } = await import('./dist/translation.js');
const config = getModelConfiguration();
const result = await pretranslate('Welcome to our translation community.', '简体中文');
const ok = result.provider !== 'fallback' && !result.error && Boolean(result.text.trim());
console.log(JSON.stringify({ ok, provider: config.provider, model: config.model, keyType: config.keyType, usageWarning: config.usageWarning,
  error: result.error, traceId: result.traceId, retryAfterMs: result.retryAfterMs,
  translation: ok ? result.text : undefined }, null, 2));
process.exitCode = ok ? 0 : 1;
JS
