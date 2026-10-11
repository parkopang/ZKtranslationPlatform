import assert from 'node:assert/strict';

process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.PORT = '0';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_KEY = 'smoke-admin-key';
process.env.PII_ENCRYPTION_KEY = 'smoke-pii-encryption-secret';
process.env.SEED_DEMO = 'false';
process.env.NODE_ENV = 'test';
process.env.LLM_PROVIDER = 'bigmodel';
delete process.env.REDIS_URL;
delete process.env.BIGMODEL_API_KEY;
delete process.env.MINIMAX_API_KEY;

const { server, db, suggestions } = await import('./server.js');
const address = server.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;

async function request(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  const body = await response.json();
  assert(response.ok, `${init?.method || 'GET'} ${path} failed: ${JSON.stringify(body)}`);
  return body;
}

async function status(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  return { status: response.status, body: await response.json() };
}

try {
  const health = await request('/api/health');
  assert.equal(health.ok, true);
  assert.equal(health.piiEncryptionConfigured, true);
  assert.equal(health.modelConfigured, false);
  assert.equal(health.queueConfigured, false);
  assert.equal(health.objectStorageConfigured, false);
  const notReady = await status('/api/readyz');
  assert.equal(notReady.status, 503);
  process.env.BIGMODEL_API_KEY = 'smoke-platform-key';
  const ready = await request('/api/readyz');
  assert.equal(ready.ok, true);

  const { getModelConfiguration } = await import('./translation.js');
  process.env.BIGMODEL_API_KEY = 'smoke-coding-plan-key';
  process.env.BIGMODEL_KEY_TYPE = 'coding_plan';
  const codingPlan = getModelConfiguration();
  assert.equal(codingPlan.configured, true);
  assert.equal(codingPlan.usageWarning, 'coding_plan_custom_application_not_officially_supported');
  delete process.env.BIGMODEL_API_KEY;
  process.env.BIGMODEL_KEY_TYPE = 'platform_api';

  const registrationResponse = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ realName: '测试译者', name: '测试译者', phone: '13800000000', idNumber: '110101199001010011', bankCardNo: '6222000000000000000' })
  });
  assert.equal(registrationResponse.status, 201);
  const registered = await registrationResponse.json() as { user: { id: string } };
  const translatorCookie = (registrationResponse.headers.get('set-cookie') || '').split(';')[0];
  assert(translatorCookie.startsWith('translation_translator_session='));
  assert.match(registered.user.id, /^[0-9a-f-]{36}$/);
  const storedPii = db.prepare('SELECT phone,phone_hash as phoneHash,id_number as idNumber, bank_card_no as bankCardNo FROM users WHERE id=?').get(registered.user.id) as { phone: string; phoneHash: string; idNumber: string; bankCardNo: string };
  assert.match(storedPii.phone, /^enc:v1:/);
  assert.match(storedPii.phoneHash, /^[0-9a-f]{64}$/);
  assert.match(storedPii.idNumber, /^enc:v1:/);
  assert.match(storedPii.bankCardNo, /^enc:v1:/);
  const adminLoginResponse = await fetch(`${base}/api/admin/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'smoke-admin-key' })
  });
  assert.equal(adminLoginResponse.status, 200);
  const adminCookie = (adminLoginResponse.headers.get('set-cookie') || '').split(';')[0];
  assert(adminCookie.startsWith('translation_admin_session='));
  const adminSession = await request('/api/admin/auth/session', { headers: { cookie: adminCookie } });
  assert.equal(adminSession.authenticated, true);
  const duplicate = await status('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ realName: '重复用户', phone: '13800000000', idNumber: '110101199001010011', bankCardNo: '6222000000000000000' })
  });
  assert.equal(duplicate.status, 409);
  const publicArticles = await status('/api/articles');
  assert.equal(publicArticles.status, 401);
  const adminArticles = await request('/api/articles', { headers: { cookie: adminCookie } });
  assert.equal(adminArticles.articles.length, 0);
  const users = await request('/api/admin/users', { headers: { cookie: adminCookie } });
  assert.equal(users.users.length, 1);
  const verified = await request(`/api/admin/users/${registered.user.id}/verification`, {
    method: 'PATCH', headers: { cookie: adminCookie }, body: JSON.stringify({ status: 'verified' })
  });
  assert.equal(verified.user.verificationStatus, 'verified');

  const importForm = new FormData();
  importForm.append('title', 'Smoke TXT import');
  importForm.append('sourceLanguage', 'English');
  importForm.append('targetLanguage', '中文');
  importForm.append('translatorSlots', '2');
  importForm.append('file', new Blob(['Imported first sentence.\nImported second sentence.'], { type: 'text/plain' }), 'smoke.txt');
  const importedResponse = await fetch(`${base}/api/admin/articles/import`, { method: 'POST', headers: { cookie: adminCookie }, body: importForm });
  assert.equal(importedResponse.status, 201);
  const imported = await importedResponse.json() as { sentenceCount: number };
  assert.equal(imported.sentenceCount, 2);

  const article = await request('/api/admin/articles', {
    method: 'POST',
    headers: { cookie: adminCookie },
    body: JSON.stringify({ title: 'Smoke article', text: 'First sentence. Second sentence.', sourceLanguage: 'English', targetLanguage: '中文', translatorSlots: 2 })
  });
  assert.equal(article.sentenceCount, 2);

  const unauthenticatedAssignment = await status('/api/assignments/request', {
    method: 'POST',
    body: JSON.stringify({ userId: registered.user.id, articleId: article.articleId, count: 1 })
  });
  assert.equal(unauthenticatedAssignment.status, 401);

  const assigned = await request('/api/assignments/request', {
    method: 'POST',
    headers: { cookie: translatorCookie },
    body: JSON.stringify({ userId: registered.user.id, articleId: article.articleId, count: 2 })
  });
  assert.equal(assigned.assignments.length, 2);

  const tasks = await request(`/api/users/${registered.user.id}/tasks`, { headers: { cookie: translatorCookie } });
  assert.equal(tasks.tasks.length, 2);

  const submission = await request(`/api/assignments/${assigned.assignments[0].id}/submit`, {
    method: 'POST',
    headers: { cookie: translatorCookie },
    body: JSON.stringify({ userId: registered.user.id, content: '第一句测试译文' })
  });
  assert.equal(submission.translation.status, 'pending');

  const pending = await request('/api/admin/translations?status=pending', { headers: { cookie: adminCookie } });
  assert.equal(pending.translations.length, 1);
  const reviewed = await request(`/api/admin/translations/${pending.translations[0].id}/review`, {
    method: 'POST', headers: { cookie: adminCookie }, body: JSON.stringify({ decision: 'accepted' })
  });
  assert.equal(reviewed.translation.status, 'accepted');

  const resubmit = await status(`/api/assignments/${assigned.assignments[0].id}/submit`, {
    method: 'POST', headers: { cookie: translatorCookie }, body: JSON.stringify({ userId: registered.user.id, content: '不应再次提交' })
  });
  assert.equal(resubmit.status, 409);

  const report = await request('/api/admin/reports', { headers: { cookie: adminCookie } });
  assert.equal(report.totals.translationCount, 1);
  assert.equal(report.totals.acceptedSentenceCount, 1);
  assert.equal(report.acceptedBySentence.length, 1);
  const metrics = await request('/api/admin/metrics', { headers: { cookie: adminCookie } });
  assert(metrics.auditEvents >= 1);
  assert.equal(metrics.queueConfigured, false);
  const auditLogs = await request('/api/admin/audit-logs?limit=200', { headers: { cookie: adminCookie } });
  assert(auditLogs.logs.some((entry: { action: string }) => entry.action === 'admin.translation.accepted'));
  const csvResponse = await fetch(`${base}/api/admin/reports/export.csv`, { headers: { cookie: adminCookie } });
  assert.equal(csvResponse.status, 200);
  assert.match(csvResponse.headers.get('content-type') || '', /text\/csv/);
  assert.match(await csvResponse.text(), /文章,句序/);
  console.log('smoke test passed: register -> import -> assign -> submit -> review -> report -> csv');
} finally {
  server.close();
  await suggestions.close();
  db.close();
}
