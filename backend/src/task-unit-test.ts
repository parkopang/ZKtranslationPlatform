import assert from 'node:assert/strict';

process.env.DOTENV_CONFIG_PATH = '/dev/null';
Object.assign(process.env, {
  PORT: '0', DB_PATH: ':memory:', NODE_ENV: 'test', SEED_DEMO: 'false',
  ADMIN_KEY: 'task-unit-test-admin-key-1234567890', PII_ENCRYPTION_KEY: 'task-unit-test-pii-key',
  LLM_PROVIDER: 'bigmodel',
});
delete process.env.BIGMODEL_API_KEY;
delete process.env.MINIMAX_API_KEY;
delete process.env.REDIS_URL;

const { server, db, suggestions } = await import('./server.js');
const address = server.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const adminHeaders = { 'x-admin-key': process.env.ADMIN_KEY! };

async function request(route: string, options: RequestInit = {}) {
  const response = await fetch(base + route, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
  const body = await response.json() as any;
  return { response, body };
}

try {
  const cases = [
    {
      taskUnit: 'sentence',
      text: 'First sentence. Second sentence! Is this the third sentence?',
      expected: ['First sentence.', 'Second sentence!', 'Is this the third sentence?'],
    },
    {
      taskUnit: 'paragraph',
      text: 'First paragraph with context.\n\nSecond paragraph keeps its context.\nThird paragraph is a separate line.',
      expected: ['First paragraph with context.', 'Second paragraph keeps its context.', 'Third paragraph is a separate line.'],
    },
    {
      taskUnit: 'chapter',
      text: '第1章 开始\nThe first chapter has several sentences.\n\n第2章 继续\nThe second chapter keeps its own context.',
      expected: ['第1章 开始\nThe first chapter has several sentences.', '第2章 继续\nThe second chapter keeps its own context.'],
    },
  ] as const;

  for (const item of cases) {
    const created = await request('/api/admin/articles', {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ title: `Task unit ${item.taskUnit}`, text: item.text, sourceLanguage: 'English', targetLanguage: '中文', taskUnit: item.taskUnit, translatorSlots: 2 }),
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.taskUnit, item.taskUnit);
    assert.equal(created.body.segmentCount, item.expected.length, `${item.taskUnit}: ${JSON.stringify(created.body)}`);

    const detail = await request(`/api/articles/${created.body.articleId}`, { headers: adminHeaders });
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body.article.taskUnit, item.taskUnit);
    assert.deepEqual(detail.body.sentences.map((row: any) => row.sourceText), item.expected);

  }

  const fallback = await request('/api/admin/articles', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ title: 'Chapter fallback', text: 'First paragraph.\n\nSecond paragraph.', targetLanguage: '中文', taskUnit: 'chapter', translatorSlots: 1 }),
  });
  assert.equal(fallback.response.status, 201);
  assert.equal(fallback.body.segmentCount, 2, 'chapter mode falls back to paragraphs without headings');

  const invalid = await request('/api/admin/articles', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ title: 'Invalid task unit', text: 'One sentence.', targetLanguage: '中文', taskUnit: 'line', translatorSlots: 1 }),
  });
  assert.equal(invalid.response.status, 400);

  const migrationValue = db.prepare("SELECT task_unit AS taskUnit FROM articles WHERE id=?").get(fallback.body.articleId) as { taskUnit: string };
  assert.equal(migrationValue.taskUnit, 'chapter');
  console.log('task unit tests passed: sentence, paragraph, chapter, paragraph fallback, API propagation and validation');
} finally {
  server.close();
  await suggestions.close();
  db.close();
}
