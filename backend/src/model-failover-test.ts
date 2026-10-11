import assert from 'node:assert/strict';
import { createModelAdapter } from './translation.js';

let calls: string[] = [];
const adapter = createModelAdapter({
  env: {
    NODE_ENV: 'test',
    LLM_PROVIDER_CHAIN: 'bigmodel,openai_compatible',
    BIGMODEL_KEY_TYPE: 'platform_api', BIGMODEL_API_KEY: 'bigmodel-test-key',
    BIGMODEL_BASE_URL: 'http://127.0.0.1/api/paas/v4/chat/completions', BIGMODEL_MODEL: 'glm-5.3-flash',
    OPENAI_COMPATIBLE_KEY_TYPE: 'platform_api', OPENAI_COMPATIBLE_API_KEY: 'sinohealth-test-key',
    OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1/v2/openai/completions', OPENAI_COMPATIBLE_MODEL: 'plmf/glm-5.3-flash',
    LLM_RETRY_ATTEMPTS: '1', LLM_REQUEST_TIMEOUT_MS: '1000', LLM_TOTAL_TIMEOUT_MS: '5000', LLM_FAILURE_COOLDOWN_MS: '1',
  },
  fetch: async (url) => {
    calls.push(url.toString());
    if (url.toString().includes('/api/paas/')) return new Response(JSON.stringify({ error: { code: 'busy', message: 'temporarily unavailable' } }), { status: 503, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '备用通道译文' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
  random: () => 0,
});

const configuration = adapter.getModelConfiguration();
assert.equal(configuration.configured, true);
assert.equal(configuration.provider, 'bigmodel');
assert.equal(configuration.fallback?.provider, 'openai_compatible');
assert.equal(configuration.fallback?.configured, true);
const result = await adapter.pretranslate('A resilient translation request.', '中文');
assert.equal(result.provider, 'openai_compatible');
assert.equal(result.text, '备用通道译文');
assert.deepEqual(calls, ['http://127.0.0.1/api/paas/v4/chat/completions', 'http://127.0.0.1/v2/openai/completions']);
assert.equal(adapter.getModelMetrics().succeeded, 1);
console.log('model failover test passed: primary BigModel failure automatically switched to Sinohealth OpenAI-compatible endpoint');
