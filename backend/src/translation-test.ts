import assert from 'node:assert/strict';
import { createModelAdapter } from './translation.js';

const successful = (text = '你好。', extra: Record<string, unknown> = {}) => ({
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }], ...extra
});
const json = (body: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const environment = (extra: Record<string, string> = {}) => ({
  NODE_ENV: 'test', LLM_PROVIDER: 'minimax', MINIMAX_API_KEY: 'minimax-test-secret',
  MINIMAX_KEY_TYPE: 'platform_api', LLM_RETRY_ATTEMPTS: '3', LLM_RETRY_BASE_MS: '1',
  LLM_RETRY_MAX_MS: '2', LLM_RATE_LIMIT_DELAY_MS: '1', LLM_REQUEST_TIMEOUT_MS: '500', LLM_TOTAL_TIMEOUT_MS: '1000', ...extra
});
let cases = 0;
const test = async (name: string, run: () => Promise<void> | void) => { await run(); cases += 1; console.log(`PASS ${name}`); };

await test('OpenAI-compatible Sinohealth endpoint uses the configured model and retries busy responses', async () => {
  let calls = 0;
  const env = environment({
    LLM_PROVIDER: 'openai_compatible',
    OPENAI_COMPATIBLE_API_KEY: 'sinohealth-test-secret',
    OPENAI_COMPATIBLE_MODEL: 'plmf/glm-5.3-flash',
    OPENAI_COMPATIBLE_BASE_URL: 'https://provider.example.invalid/v2/openai/completions',
    LLM_RETRY_ATTEMPTS: '2', LLM_RETRY_BASE_MS: '1', LLM_RETRY_MAX_MS: '1'
  });
  const adapter = createModelAdapter({ env, fetch: async (input, init) => {
    calls += 1;
    assert.equal(input, 'https://provider.example.invalid/v2/openai/completions');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer sinohealth-test-secret');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'plmf/glm-5.3-flash');
    assert.equal(body.messages[1].content, 'Hello.');
    return calls === 1 ? json({ error: { code: 'capacity_busy', message: 'temporarily busy' } }, 503) : json(successful('你好。'));
  } });
  assert.equal(adapter.getModelConfiguration().provider, 'openai_compatible');
  assert.equal(adapter.getModelConfiguration().model, 'plmf/glm-5.3-flash');
  assert.equal((await adapter.pretranslate('Hello.', '中文')).text, '你好。');
  assert.equal(calls, 2);
});

await test('explicit provider and key isolation; backwards-compatible BigModel defaults', async () => {
  let called = 0;
  const env = environment({ BIGMODEL_API_KEY: 'bigmodel-only-secret' });
  const adapter = createModelAdapter({ env, fetch: async (input, init) => {
    called += 1;
    assert.equal(input, 'https://minimax.example.test/v1/chat/completions');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer minimax-test-secret');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'MiniMax-M2.7');
    assert.equal(body.reasoning_split, true);
    assert.equal(body.max_tokens, 4096);
    assert.equal(init?.redirect, 'error');
    return json(successful());
  } });
  assert.equal((await adapter.pretranslate('Hello.', '中文')).provider, 'minimax');
  assert.equal(called, 1);
  const legacy = createModelAdapter({ env: { BIGMODEL_API_KEY: 'legacy-secret' }, fetch: async (input, init) => {
    assert.equal(input, 'https://bigmodel.example.test/api/paas/v4/chat/completions');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer legacy-secret');
    assert.equal(JSON.parse(String(init?.body)).reasoning_split, undefined);
    return json(successful());
  } });
  assert.equal(legacy.getModelConfiguration().provider, 'bigmodel');
  assert.equal((await legacy.pretranslate('Hello.', '中文')).provider, 'bigmodel');
  const missing = createModelAdapter({ env: { LLM_PROVIDER: 'minimax', BIGMODEL_API_KEY: 'never-forward-this' }, fetch: async () => { throw new Error('must not fetch'); } });
  assert.equal((await missing.pretranslate('source', '中文')).attempts, 0);
  assert.equal(missing.getModelConfiguration().error, 'model_api_key_missing');
});

await test('production plan and malformed configuration fail closed without exposing credentials', async () => {
  for (const [overrides, expected] of [
    [{ NODE_ENV: 'production', MINIMAX_KEY_TYPE: 'platform_api', MINIMAX_API_KEY: 'sk-cp-known-subscription' }, 'token_plan_key_disabled_by_production_policy'],
    [{ NODE_ENV: 'production', MINIMAX_KEY_TYPE: 'token_plan' }, 'token_plan_key_disabled_by_production_policy'],
    [{ NODE_ENV: 'production', LLM_PROVIDER: 'typo' }, 'unsupported_llm_provider'],
    [{ NODE_ENV: 'production', MINIMAX_BASE_URL: 'http://minimax.example.test/v1/chat/completions' }, 'invalid_model_endpoint'],
    [{ NODE_ENV: 'production', MINIMAX_BASE_URL: 'https://bigmodel.example.test/api/paas/v4/chat/completions' }, 'model_endpoint_provider_mismatch'],
    [{ NODE_ENV: 'production', MINIMAX_BASE_URL: 'https://user:password@minimax.example.test/v1/chat/completions' }, 'invalid_model_endpoint'],
    [{ NODE_ENV: 'production', MINIMAX_KEY_TYPE: 'accidental-secret-key' }, 'invalid_model_key_type']
  ] as Array<[Record<string, string>, string]>) {
    const adapter = createModelAdapter({ env: environment(overrides), fetch: async () => { throw new Error('must not fetch'); } });
    assert.throws(adapter.assertModelConfiguration, { message: expected });
    const result = await adapter.pretranslate('private source', '中文');
    assert.equal(result.text, '');
    assert.equal(result.attempts, 0);
    assert.equal(result.retryable, false);
    assert.equal(result.error, expected);
    assert(!JSON.stringify(adapter.getModelConfiguration()).includes('accidental-secret-key'));
  }
  const devPlan = createModelAdapter({ env: environment({ MINIMAX_KEY_TYPE: 'token_plan' }), fetch: async () => json(successful()) });
  assert.equal(devPlan.getModelConfiguration().configured, true);
  assert.equal((await devPlan.pretranslate('hello', '中文')).provider, 'minimax');
});

await test('HTTP 200 MiniMax transient business errors retry', async () => {
  for (const code of [1002, 2045, 1041, 1000, 1001, 1024, 1033]) {
    let called = 0;
    const adapter = createModelAdapter({ env: environment(), fetch: async () => {
      called += 1;
      return called === 1 ? json({ base_resp: { status_code: code, status_msg: 'do not expose' } }) : json(successful());
    } });
    const result = await adapter.pretranslate('hello', '中文');
    assert.equal(result.provider, 'minimax');
    assert.equal(result.attempts, 2);
    assert.equal(adapter.getModelMetrics().retries, 1);
  }
});

await test('HTTP 200 and HTTP 503 permanent business errors never hot-retry', async () => {
  for (const code of [1004, 2049, 1008, 2056, 2013, 1039, 1026, 1027]) {
    for (const status of [200, 503]) {
      let called = 0;
      const adapter = createModelAdapter({ env: environment(), fetch: async () => {
        called += 1;
        return json({ error: { code: String(code), message: 'minimax-test-secret private source' } }, status, { trace_id: 'trace-safe-001' });
      } });
      const result = await adapter.pretranslate('private source', '中文');
      assert.equal(called, 1);
      assert.equal(result.text, '');
      assert.equal(result.retryable, false);
      assert.equal(result.traceId, 'trace-safe-001');
      assert(!JSON.stringify(result).includes('private source'));
      assert(!JSON.stringify(result).includes('minimax-test-secret'));
    }
  }
});

await test('429 and 503 Retry-After is respected before retry', async () => {
  const calledAt: number[] = [];
  const adapter = createModelAdapter({ env: environment(), random: () => 0.5, fetch: async () => {
    calledAt.push(Date.now());
    if (calledAt.length <= 2) return json({ error: { code: 'rate_limit_exceeded' } }, calledAt.length === 1 ? 429 : 503, { 'retry-after': '0.025' });
    return json(successful());
  } });
  const result = await adapter.pretranslate('hello', '中文');
  assert.equal(result.attempts, 3);
  assert.equal(result.provider, 'minimax');
  assert(calledAt[1] - calledAt[0] >= 25);
  assert(calledAt[2] - calledAt[1] >= 25);
});

await test('long Retry-After returns a deferred retry; shared cooldown prevents early calls', async () => {
  let called = 0;
  const adapter = createModelAdapter({ env: environment({ LLM_TOTAL_TIMEOUT_MS: '100' }), fetch: async () => {
    called += 1;
    return json({ error: { code: 'rate_limit_exceeded' } }, 429, { 'retry-after': '3600' });
  } });
  const start = Date.now();
  const first = await adapter.pretranslate('hello', '中文');
  assert.equal(first.retryAfterMs, 3_600_000);
  assert.equal(first.retryable, true);
  assert.equal(first.attempts, 1);
  assert(Date.now() - start < 500);
  const second = await adapter.pretranslate('next', '中文');
  assert.equal(second.attempts, 0);
  assert(second.retryAfterMs! > 3_599_000);
  assert.equal(called, 1);
});

await test('HTTP-date Retry-After is never capped to exponential backoff', async () => {
  const when = new Date(Date.now() + 20_000).toUTCString();
  const adapter = createModelAdapter({ env: environment({ LLM_TOTAL_TIMEOUT_MS: '100' }), fetch: async () => json({}, 503, { 'retry-after': when }) });
  const result = await adapter.pretranslate('hello', '中文');
  assert(result.retryAfterMs! >= 18_000);
  assert.equal(result.attempts, 1);
});

await test('complete thinking is stripped; truncated, empty, reasoning-only and malformed responses are rejected', async () => {
  const cases: Array<[unknown, string | undefined]> = [
    [successful('<think>private reasoning</think>你好。'), undefined],
    [{ choices: [{ finish_reason: 'length', message: { content: 'partial translation' } }] }, 'provider_truncated_response'],
    [successful('<think>only reasoning</think>'), 'provider_empty_translation'],
    [successful('<think>incomplete reasoning'), 'provider_incomplete_reasoning'],
    [successful('\u200B\u200D '), 'provider_empty_translation'],
    [{ choices: [{ finish_reason: 'stop', message: { content: null, reasoning_content: 'only reasoning' } }] }, 'provider_invalid_response'],
    [{ choices: [{ message: { content: 'missing completion marker' } }] }, 'provider_invalid_response'],
    [{ choices: [{ finish_reason: 'tool_calls', message: { content: 'function output' } }] }, 'provider_invalid_response'],
    [{ arbitrary: 'malformed' }, 'provider_invalid_response']
  ];
  for (const [payload, expected] of cases) {
    const adapter = createModelAdapter({ env: environment({ LLM_RETRY_ATTEMPTS: '1' }), fetch: async () => json(payload) });
    const result = await adapter.pretranslate('private source', '中文');
    if (!expected) assert.equal(result.text, '你好。');
    else { assert.equal(result.text, ''); assert.equal(result.error, expected); }
  }
});

await test('network failures and malformed payloads are finite and safely classified', async () => {
  let calls = 0;
  const adapter = createModelAdapter({ env: environment(), fetch: async () => {
    calls += 1;
    if (calls === 1) throw new Error('Authorization: Bearer minimax-test-secret');
    if (calls === 2) return new Response('{invalid JSON');
    return json(successful());
  } });
  assert.equal((await adapter.pretranslate('hello', '中文')).attempts, 3);
  const broken = createModelAdapter({ env: environment(), fetch: async () => { throw new Error('minimax-test-secret'); } });
  const result = await broken.pretranslate('hello', '中文');
  assert.equal(result.attempts, 3);
  assert.equal(result.error, 'provider_unavailable');
  assert(!JSON.stringify(result).includes('minimax-test-secret'));
});

await test('request timeout remains active through body streaming and total budget bounds retries', async () => {
  let cancelled = false;
  const adapter = createModelAdapter({ env: environment({ LLM_REQUEST_TIMEOUT_MS: '25', LLM_TOTAL_TIMEOUT_MS: '40' }), fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"choices":')); },
    cancel() { cancelled = true; }
  })) });
  const start = Date.now();
  const result = await adapter.pretranslate('hello', '中文');
  assert.equal(result.text, '');
  assert.equal(result.error, 'provider_timeout');
  assert.equal(result.retryable, true);
  assert(Date.now() - start >= 35);
  assert(Date.now() - start < 500);
  assert(cancelled);
  assert.equal(adapter.getModelMetrics().inFlight, 0);
});

await test('response bodies are bounded and unsafe trace identifiers are omitted', async () => {
  for (const declared of [true, false]) {
    const adapter = createModelAdapter({ env: environment(), fetch: async () => new Response('x'.repeat(1024 * 1024 + 1), {
      headers: declared ? { 'content-length': '1048577' } : {}
    }) });
    const result = await adapter.pretranslate('hello', '中文');
    assert.equal(result.error, 'provider_response_too_large');
    assert.equal(result.attempts, 1);
    assert.equal(result.retryable, false);
  }
  for (const trace of ['minimax-test-secret', '<script>alert(1)</script>', 'x'.repeat(129)]) {
    const adapter = createModelAdapter({ env: environment(), fetch: async () => json(successful(), 200, { trace_id: trace }) });
    assert.equal((await adapter.pretranslate('hello', '中文')).traceId, undefined);
  }
});

await test('10 parallel calls hold at most 2 slots across retries and release all slots', async () => {
  let active = 0;
  let peak = 0;
  const attemptsBySource = new Map<string, number>();
  const adapter = createModelAdapter({ env: environment({ LLM_MAX_CONCURRENCY: '2' }), fetch: async (_input, init) => {
    active += 1;
    peak = Math.max(peak, active);
    const body = JSON.parse(String(init?.body));
    const source = body.messages[1].content;
    const attempt = (attemptsBySource.get(source) || 0) + 1;
    attemptsBySource.set(source, attempt);
    await new Promise((resolve) => setTimeout(resolve, 8));
    active -= 1;
    return attempt === 1 ? json({}, 503) : json(successful());
  } });
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => adapter.pretranslate(`source-${index}`, '中文')));
  assert(results.every((result) => result.provider === 'minimax' && result.attempts === 2));
  assert.equal(peak, 2);
  assert.equal(adapter.getModelMetrics().maxObservedConcurrency, 2);
  assert.equal(adapter.getModelMetrics().inFlight, 0);
  assert.equal(adapter.getModelMetrics().waiting, 0);
  assert.equal(adapter.getModelMetrics().succeeded, 10);
  assert.equal(adapter.getModelMetrics().retries, 10);
  assert.equal(adapter.getModelMetrics().totalAttempts, 20);
});

await test('waiting for concurrency uses the same total deadline', async () => {
  let calls = 0;
  const adapter = createModelAdapter({ env: environment({ LLM_MAX_CONCURRENCY: '1', LLM_TOTAL_TIMEOUT_MS: '35', LLM_REQUEST_TIMEOUT_MS: '500', LLM_RETRY_ATTEMPTS: '1' }), fetch: async () => {
    calls += 1;
    return new Promise<Response>(() => {});
  } });
  const start = Date.now();
  const results = await Promise.all(Array.from({ length: 10 }, () => adapter.pretranslate('hello', '中文')));
  assert(results.every((result) => result.text === '' && result.retryable));
  assert(calls <= 2);
  assert(Date.now() - start < 200);
  assert.equal(adapter.getModelMetrics().inFlight, 0);
  assert.equal(adapter.getModelMetrics().waiting, 0);
});

await test('legacy retry environment and metrics are backwards compatible and immutable snapshots', async () => {
  const adapter = createModelAdapter({ env: { BIGMODEL_API_KEY: 'legacy-secret', BIGMODEL_RETRY_ATTEMPTS: '2', BIGMODEL_RETRY_BASE_MS: '1', BIGMODEL_RETRY_MAX_MS: '1' }, fetch: async () => json({}, 503) });
  const result = await adapter.pretranslate('hello', '中文');
  assert.equal(result.attempts, 2);
  const metrics = adapter.getModelMetrics();
  metrics.errorsByCode.provider_http_503 = 1000;
  assert.equal(adapter.getModelMetrics().errorsByCode.provider_http_503, 1);
  assert(!JSON.stringify(adapter.getModelMetrics()).includes('legacy-secret'));
});

await test('rate limit default is 60 seconds and fatal failures are shared without repeated API calls', async () => {
  let calls = 0;
  const env = environment({ LLM_TOTAL_TIMEOUT_MS: '50' });
  delete (env as Record<string, string | undefined>).LLM_RATE_LIMIT_DELAY_MS;
  const adapter = createModelAdapter({ env, fetch: async () => { calls += 1; return json({ base_resp: { status_code: 1002 } }); } });
  const limited = await adapter.pretranslate('hello', '中文');
  assert.equal(limited.retryAfterMs, 60_000);
  assert.equal((await adapter.pretranslate('another sentence', '中文')).attempts, 0);
  assert.equal(calls, 1);
  for (const code of [1004, 1008, 2056]) {
    let fatalCalls = 0;
    const fatal = createModelAdapter({ env: environment(), fetch: async () => { fatalCalls += 1; return json({ base_resp: { status_code: code } }); } });
    const first = await fatal.pretranslate('hello', '中文');
    const second = await fatal.pretranslate('another sentence', '中文');
    assert.equal(first.retryable, false);
    assert.equal(second.error, first.error);
    assert.equal(second.retryable, false);
    assert.equal(second.attempts, 0);
    assert.equal(fatalCalls, 1);
  }
});

await test('cooldowns are isolated by provider, endpoint, model and key without publishing credentials', async () => {
  let calls = 0;
  const env: Record<string, string> = environment({ LLM_TOTAL_TIMEOUT_MS: '20' });
  const adapter = createModelAdapter({ env, fetch: async () => {
    calls += 1;
    return calls === 1 ? json({}, 429, { 'retry-after': '3600' }) : json(successful());
  } });
  await adapter.pretranslate('hello', '中文');
  env.MINIMAX_API_KEY = 'rotated-key';
  assert.equal((await adapter.pretranslate('hello', '中文')).provider, 'minimax');
  env.MINIMAX_API_KEY = 'minimax-test-secret';
  env.MINIMAX_MODEL = 'MiniMax-M2.5';
  assert.equal((await adapter.pretranslate('hello', '中文')).provider, 'minimax');
  env.MINIMAX_MODEL = 'MiniMax-M2.7';
  env.MINIMAX_BASE_URL = 'https://minimax-alt.example.test/v1/chat/completions';
  assert.equal((await adapter.pretranslate('hello', '中文')).provider, 'minimax');
  env.LLM_PROVIDER = 'bigmodel';
  env.BIGMODEL_API_KEY = 'bigmodel-secret';
  assert.equal((await adapter.pretranslate('hello', '中文')).provider, 'bigmodel');
  assert.equal(calls, 5);
  const metrics = JSON.stringify(adapter.getModelMetrics());
  for (const key of ['rotated-key', 'minimax-test-secret', 'bigmodel-secret']) assert(!metrics.includes(key));
});

await test('mixed business codes prefer permanent errors and shorter cooldowns cannot override Retry-After', async () => {
  const mixed = createModelAdapter({ env: environment(), fetch: async () => json({ base_resp: { status_code: 1002 }, error: { code: 1008 } }, 503) });
  const failure = await mixed.pretranslate('hello', '中文');
  assert.equal(failure.error, 'provider_insufficient_balance');
  assert.equal(failure.attempts, 1);
  let calls = 0;
  const adapter = createModelAdapter({ env: environment({ LLM_TOTAL_TIMEOUT_MS: '25', LLM_RETRY_ATTEMPTS: '1' }), fetch: async () => {
    calls += 1;
    const first = calls === 1;
    await new Promise((resolve) => setTimeout(resolve, first ? 1 : 5));
    return json({}, 429, { 'retry-after': first ? '3600' : '1' });
  } });
  await Promise.all([adapter.pretranslate('hello', '中文'), adapter.pretranslate('again', '中文')]);
  const later = await adapter.pretranslate('third', '中文');
  assert(later.retryAfterMs! > 3_599_000);
  assert.equal(calls, 2);
});

await test('GLM Coding Plan uses its dedicated endpoint in all environments without metered fallback or tool impersonation', async () => {
  for (const nodeEnv of ['production', 'test', 'development']) {
    const urls: string[] = [];
    const adapter = createModelAdapter({ env: {
      NODE_ENV: nodeEnv, LLM_PROVIDER: 'bigmodel', BIGMODEL_KEY_TYPE: 'coding_plan',
      BIGMODEL_API_KEY: 'glm-subscription-test-key', MINIMAX_API_KEY: 'unrelated-minimax-key',
      LLM_RETRY_ATTEMPTS: '2', LLM_RETRY_BASE_MS: '1', LLM_RETRY_MAX_MS: '1'
    }, fetch: async (input, init) => {
      urls.push(String(input));
      assert.equal(input, 'https://bigmodel.example.test/api/coding/paas/v4/chat/completions');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), 'Bearer glm-subscription-test-key');
      assert.equal(headers.has('user-agent'), false);
      assert.equal(headers.has('x-client-name'), false);
      assert.equal(init?.redirect, 'error');
      return urls.length === 1 ? json({}, 503) : json(successful());
    } });
    assert.doesNotThrow(adapter.assertModelConfiguration);
    assert.equal(adapter.getModelConfiguration().configured, true);
    assert.equal(adapter.getModelConfiguration().keyType, 'coding_plan');
    assert.equal(adapter.getModelConfiguration().usageWarning, 'coding_plan_custom_application_not_officially_supported');
    const result = await adapter.pretranslate('hello', '中文');
    assert.equal(result.provider, 'bigmodel');
    assert.equal(result.attempts, 2);
    assert.equal(new Set(urls).size, 1);
    assert(!JSON.stringify(adapter.getModelConfiguration()).includes('glm-subscription-test-key'));
  }
});

await test('GLM endpoint and key types cannot cross-route, including localhost mocks', async () => {
  const standard = '/api/paas/v4/chat/completions';
  const coding = '/api/coding/paas/v4/chat/completions';
  for (const nodeEnv of ['production', 'development', 'test']) {
    for (const keyType of ['coding_plan', 'platform_api']) {
      let calls = 0;
      const path = keyType === 'coding_plan' ? standard : coding;
      const adapter = createModelAdapter({ env: {
        NODE_ENV: nodeEnv, BIGMODEL_KEY_TYPE: keyType, BIGMODEL_API_KEY: 'routing-test-key',
        BIGMODEL_BASE_URL: `https://bigmodel.example.test${path}`
      }, fetch: async () => { calls += 1; return json(successful()); } });
      const result = await adapter.pretranslate('hello', '中文');
      assert.equal(result.error, 'bigmodel_endpoint_key_type_mismatch');
      assert.equal(result.attempts, 0);
      assert.equal(calls, 0);
      if (nodeEnv === 'production') assert.throws(adapter.assertModelConfiguration);
    }
  }
  for (const keyType of ['coding_plan', 'platform_api']) {
    const expectedPath = keyType === 'coding_plan' ? coding : standard;
    const adapter = createModelAdapter({ env: {
      NODE_ENV: 'test', BIGMODEL_KEY_TYPE: keyType, BIGMODEL_API_KEY: 'local-mock-key',
      BIGMODEL_BASE_URL: `http://127.0.0.1:8089${expectedPath}`
    }, fetch: async (input) => { assert.equal(input, `http://127.0.0.1:8089${expectedPath}`); return json(successful()); } });
    assert.equal((await adapter.pretranslate('hello', '中文')).provider, 'bigmodel');
  }
  for (const [url, nodeEnv, expected] of [
    [`http://localhost:8089${standard}`, 'test', 'bigmodel_endpoint_key_type_mismatch'],
    [`http://localhost:8089${coding}`, 'production', 'invalid_model_endpoint'],
    [`http://localhost:8089${coding}`, 'development', 'invalid_model_endpoint'],
    [`https://untrusted.example${coding}`, 'production', 'bigmodel_endpoint_not_allowed'],
    [`https://bigmodel.example.test${coding}?redirect=${standard}`, 'test', 'invalid_model_endpoint']
  ]) {
    const adapter = createModelAdapter({ env: {
      NODE_ENV: nodeEnv, BIGMODEL_KEY_TYPE: 'coding_plan', BIGMODEL_API_KEY: 'routing-test-key', BIGMODEL_BASE_URL: url
    }, fetch: async () => { throw new Error('must not send a mismatched key'); } });
    assert.equal((await adapter.pretranslate('hello', '中文')).error, expected);
  }
  const missing = createModelAdapter({ env: { LLM_PROVIDER: 'bigmodel', BIGMODEL_KEY_TYPE: 'coding_plan', MINIMAX_API_KEY: 'do-not-forward' } });
  assert.equal(missing.getModelConfiguration().error, 'model_api_key_missing');
  assert.equal((await missing.pretranslate('hello', '中文')).attempts, 0);
});

await test('GLM authentication, billing and plan business codes override HTTP 429 and 5xx without paid fallback', async () => {
  const cases: Array<[number, string]> = [
    [1000, 'provider_authentication_failed'], [1001, 'provider_authentication_failed'],
    [1003, 'provider_authentication_failed'], [1005, 'provider_authentication_failed'],
    [1113, 'provider_insufficient_balance'], [1220, 'provider_permission_denied'],
    [1308, 'provider_plan_quota_exhausted'], [1310, 'provider_plan_quota_exhausted'],
    [1309, 'provider_plan_expired'], [1314, 'provider_plan_expired'],
    [1311, 'provider_model_not_allowed'], [1313, 'provider_usage_restricted'],
    [1315, 'provider_key_scope_mismatch'], [1316, 'provider_plan_quota_exhausted'],
    [1317, 'provider_plan_quota_exhausted'], [1318, 'provider_plan_quota_exhausted'],
    [1319, 'provider_plan_quota_exhausted'], [1320, 'provider_plan_quota_exhausted'],
    [1321, 'provider_plan_quota_exhausted']
  ];
  for (const status of [200, 429, 503]) {
    for (const [code, expected] of cases) {
      let calls = 0;
      const adapter = createModelAdapter({ env: {
        NODE_ENV: 'production', BIGMODEL_API_KEY: 'glm-subscription-key', BIGMODEL_KEY_TYPE: 'coding_plan'
      }, fetch: async (input) => {
        calls += 1;
        assert.equal(input, 'https://bigmodel.example.test/api/coding/paas/v4/chat/completions');
        return json({ error: { code: String(code), message: 'private provider payload with glm-subscription-key' } }, status);
      } });
      const first = await adapter.pretranslate('hello', '中文');
      assert.equal(first.text, '');
      assert.equal(first.retryable, false);
      assert.equal(first.error, expected);
      assert.equal(first.attempts, 1);
      assert(!JSON.stringify(first).includes('glm-subscription-key'));
      const second = await adapter.pretranslate('another sentence', '中文');
      assert.equal(second.error, expected);
      assert.equal(second.attempts, 0);
      assert.equal(calls, 1);
    }
  }
});

await test('GLM transient business codes retry while input and content errors are permanent', async () => {
  for (const code of [1200, 1230, 1234, 1302, 1305]) {
    let calls = 0;
    const adapter = createModelAdapter({ env: {
      BIGMODEL_API_KEY: 'glm-subscription-key', BIGMODEL_KEY_TYPE: 'coding_plan',
      LLM_RETRY_BASE_MS: '1', LLM_RETRY_MAX_MS: '1', LLM_RATE_LIMIT_DELAY_MS: '1'
    }, fetch: async () => { calls += 1; return calls === 1 ? json({ error: { code } }) : json(successful()); } });
    assert.equal((await adapter.pretranslate('hello', '中文')).provider, 'bigmodel');
    assert.equal(calls, 2);
  }
  for (const code of [1210, 1211, 1212, 1213, 1214, 1215, 1221, 1222, 1261, 1301]) {
    let calls = 0;
    const adapter = createModelAdapter({ env: { BIGMODEL_API_KEY: 'glm-subscription-key', BIGMODEL_KEY_TYPE: 'coding_plan' }, fetch: async () => {
      calls += 1; return json({ error: { code } }, 429);
    } });
    assert.equal((await adapter.pretranslate('hello', '中文')).retryable, false);
    assert.equal(calls, 1);
  }
});

await test('provider-specific policy opens a circuit and exposes the complete fallback chain', async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const adapter = createModelAdapter({ env: {
    NODE_ENV: 'test',
    LLM_PROVIDER_CHAIN: 'bigmodel,openai_compatible,minimax',
    LLM_RETRY_ATTEMPTS: '1', LLM_MAX_TOKENS: '1', LLM_TOTAL_TIMEOUT_MS: '500',
    BIGMODEL_KEY_TYPE: 'platform_api', BIGMODEL_API_KEY: 'bigmodel-test-key',
    BIGMODEL_BASE_URL: 'http://127.0.0.1/api/paas/v4/chat/completions',
    BIGMODEL_RETRY_ATTEMPTS: '', BIGMODEL_MAX_TOKENS: '777', BIGMODEL_FAILURE_COOLDOWN_MS: '100',
    OPENAI_COMPATIBLE_KEY_TYPE: 'platform_api', OPENAI_COMPATIBLE_API_KEY: 'sinohealth-test-key',
    OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1/v2/openai/completions',
    OPENAI_COMPATIBLE_RETRY_ATTEMPTS: '', OPENAI_COMPATIBLE_MAX_TOKENS: '888',
    MINIMAX_KEY_TYPE: 'platform_api', MINIMAX_API_KEY: 'minimax-test-key',
    MINIMAX_BASE_URL: 'http://127.0.0.1/v1/chat/completions'
  }, fetch: async (input, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(input).includes('/api/paas/')) {
      primaryCalls += 1;
      assert.equal(body.max_tokens, 777);
      return json({ error: { code: 'capacity_busy' } }, 503);
    }
    fallbackCalls += 1;
    assert.equal(input, 'http://127.0.0.1/v2/openai/completions');
    assert.equal(body.max_tokens, 888);
    return json(successful('备用通道译文'));
  } });
  const configuration = adapter.getModelConfiguration();
  assert.equal(configuration.fallback?.provider, 'openai_compatible');
  assert.equal(configuration.fallback?.fallback?.provider, 'minimax');
  assert.equal((await adapter.pretranslate('one', '中文')).provider, 'openai_compatible');
  assert.equal((await adapter.pretranslate('two', '中文')).provider, 'openai_compatible');
  assert.equal(primaryCalls, 1, 'the open circuit must skip the degraded primary on the next request');
  assert.equal(fallbackCalls, 2);
});

console.log(`Model adapter regression tests passed: ${cases} cases.`);
