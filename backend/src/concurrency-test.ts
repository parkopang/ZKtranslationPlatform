import assert from 'node:assert/strict';

process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.PORT = '0';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_KEY = 'concurrency-admin-key-12345678901234567890';
process.env.PII_ENCRYPTION_KEY = 'concurrency-pii-key';
process.env.SEED_DEMO = 'false';
delete process.env.REDIS_URL;
process.env.NODE_ENV = 'test';
delete process.env.BIGMODEL_API_KEY;
delete process.env.MINIMAX_API_KEY;
process.env.LLM_PROVIDER = 'bigmodel';

const { server, db, suggestions } = await import('./server.js');
const address = server.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;

async function json(path: string, init?: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  return { response, body: await response.json() };
}

function cookie(response: Response): string {
  const value = (response.headers.get('set-cookie') || '').split(';')[0];
  assert(/^translation_(translator|admin)_session=/.test(value));
  return value;
}

try {
  const adminLogin = await json('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ key: process.env.ADMIN_KEY }) });
  assert.equal(adminLogin.response.status, 200);
  const adminCookie = cookie(adminLogin.response);
  const articleResponse = await json('/api/admin/articles', {
    method: 'POST',
    headers: { cookie: adminCookie },
    body: JSON.stringify({
      title: '10 人并发验收文章',
      text: 'Concurrent sentence 1. Concurrent sentence 2. Concurrent sentence 3.',
      sourceLanguage: 'English',
      targetLanguage: '中文',
      translatorSlots: 2,
    }),
  });
  assert.equal(articleResponse.response.status, 201);
  const articleId = articleResponse.body.articleId as string;

  const registrationResults = await Promise.all(Array.from({ length: 10 }, (_, index) => json('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ realName: `并发译者${index + 1}`, phone: `1390000${String(index).padStart(4, '0')}`, idNumber: `11010119900101${String(index).padStart(4, '0')}`, bankCardNo: `622200000000000000${index}` }),
  })));
  assert(registrationResults.every(({ response }) => response.status === 201));
  const translators = registrationResults.map(({ response, body }) => ({ id: body.user.id as string, cookie: cookie(response) }));

  const start = performance.now();
  const assignmentResults = await Promise.all(translators.map((translator) => json('/api/assignments/request', {
    method: 'POST',
    headers: { cookie: translator.cookie },
    body: JSON.stringify({ userId: translator.id, articleId, count: 1 }),
  })));
  const assignmentElapsedMs = performance.now() - start;
  assert(assignmentResults.every(({ response }) => response.status === 200));
  assert(assignmentElapsedMs < 3000, `10 concurrent assignment requests took ${assignmentElapsedMs.toFixed(0)}ms`);

  const assignments = assignmentResults.flatMap(({ body }, index) => (body.assignments || []).map((assignment: any) => ({ ...assignment, translator: translators[index] })));
  const counts = db.prepare('SELECT sentence_id as sentenceId, COUNT(*) as count FROM assignments GROUP BY sentence_id').all() as Array<{ sentenceId: string; count: number }>;
  assert(counts.every((row) => row.count <= 2), `assignment capacity exceeded: ${JSON.stringify(counts)}`);
  assert((db.prepare('SELECT COUNT(*) as count FROM assignments').get() as { count: number }).count <= 6);
  assert.equal(db.prepare('SELECT sentence_id,user_id,COUNT(*) as count FROM assignments GROUP BY sentence_id,user_id HAVING COUNT(*) > 1').get(), undefined);

  const taskStart = performance.now();
  const taskResults = await Promise.all(translators.map((translator) => json(`/api/users/${translator.id}/tasks`, { headers: { cookie: translator.cookie } })));
  const taskElapsedMs = performance.now() - taskStart;
  assert(taskResults.every(({ response }) => response.status === 200));
  assert(taskElapsedMs < 3000, `10 concurrent task reads took ${taskElapsedMs.toFixed(0)}ms`);

  const submitResults = await Promise.all(assignments.map((assignment: any) => json(`/api/assignments/${assignment.id}/submit`, {
    method: 'POST',
    headers: { cookie: assignment.translator.cookie },
    body: JSON.stringify({ userId: assignment.translator.id, content: `Concurrent translation ${assignment.position}` }),
  })));
  assert(submitResults.every(({ response }) => response.status === 201));
  assert.equal((db.prepare('SELECT COUNT(*) as count FROM translations').get() as { count: number }).count, assignments.length);

  console.log(`concurrency test passed: 10 translators, ${assignments.length} assignments, ${assignmentElapsedMs.toFixed(0)}ms allocation, ${taskElapsedMs.toFixed(0)}ms task reads`);
} finally {
  server.close();
  await suggestions.close();
  db.close();
}
