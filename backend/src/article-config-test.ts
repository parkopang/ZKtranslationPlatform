import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createDb } from './db.js';

process.env.DOTENV_CONFIG_PATH = '/dev/null';
Object.assign(process.env, {
  PORT: '0', DB_PATH: ':memory:', NODE_ENV: 'test', SEED_DEMO: 'false',
  ADMIN_KEY: 'article-config-test-admin-key-1234567890', PII_ENCRYPTION_KEY: 'article-config-test-pii-key',
  LLM_PROVIDER: 'bigmodel',
});
delete process.env.BIGMODEL_API_KEY;
delete process.env.MINIMAX_API_KEY;
delete process.env.REDIS_URL;

// Exercise the forward migration on an isolated legacy database, not a deployed DB.
const legacyDirectory = mkdtempSync(path.join(tmpdir(), 'translation-article-migration-'));
try {
  const legacyPath = path.join(legacyDirectory, 'legacy.sqlite');
  const legacy = new Database(legacyPath);
  legacy.exec(`CREATE TABLE articles (
    id TEXT PRIMARY KEY,title TEXT NOT NULL,source_language TEXT NOT NULL DEFAULT 'auto',
    target_language TEXT NOT NULL DEFAULT '英文',source_file_name TEXT,
    translator_slots INTEGER NOT NULL DEFAULT 2,created_at TEXT NOT NULL DEFAULT (datetime('now'))
  ); INSERT INTO articles (id,title,created_at) VALUES ('legacy','Existing article','2026-01-02 03:04:05')`);
  legacy.close();
  const migrated = createDb(legacyPath);
  assert.deepEqual(migrated.prepare('SELECT title,updated_at FROM articles WHERE id=?').get('legacy'), {
    title: 'Existing article', updated_at: '2026-01-02 03:04:05',
  });
  migrated.exec(`INSERT INTO users (id,name) VALUES ('winner','Winner'),('late','Late volunteer'),('waiting','Waiting volunteer');
    INSERT INTO sentences (id,article_id,position,source_text) VALUES ('legacy-sentence','legacy',1,'Retain historical content.');
    INSERT INTO assignments (id,sentence_id,user_id,status) VALUES
      ('winner-task','legacy-sentence','winner','done'),
      ('late-task','legacy-sentence','late','submitted'),
      ('waiting-task','legacy-sentence','waiting','assigned');
    INSERT INTO translations (id,sentence_id,user_id,content,status,created_at,reviewed_at) VALUES
      ('winner-translation','legacy-sentence','winner','Chosen translation','accepted','2026-01-02 03:04:05','2026-01-02 04:00:00'),
      ('late-translation','legacy-sentence','late','Late historical translation','pending','2026-01-02 05:00:00',NULL);`);
  migrated.close();
  const reopened = createDb(legacyPath);
  assert.equal((reopened.prepare('SELECT COUNT(*) AS count FROM articles').get() as { count: number }).count, 1);
  assert.equal((reopened.prepare("SELECT COUNT(*) AS count FROM assignments WHERE status='done'").get() as { count: number }).count, 3);
  const archived = reopened.prepare("SELECT content,status,created_at,reviewed_at FROM translations WHERE id='late-translation'").get() as Record<string, string>;
  assert.equal(archived.content, 'Late historical translation');
  assert.equal(archived.status, 'rejected');
  assert.equal(archived.created_at, '2026-01-02 05:00:00');
  assert(archived.reviewed_at);
  assert.equal((reopened.prepare('SELECT COUNT(*) AS count FROM translations').get() as { count: number }).count, 2);
  reopened.close();
  const repeated = createDb(legacyPath);
  assert.deepEqual(repeated.prepare("SELECT content,status,created_at,reviewed_at FROM translations WHERE id='late-translation'").get(), archived);
  repeated.close();
} finally {
  rmSync(legacyDirectory, { recursive: true, force: true });
}

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
async function createArticle(text: string, translatorSlots: number) {
  const result = await request('/api/admin/articles', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ title: 'Dynamic volunteer allocation', text, targetLanguage: '中文', translatorSlots }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.articleId as string;
}
async function configure(articleId: string, translatorSlots: unknown, extra: Record<string, unknown> = {}) {
  return request(`/api/admin/articles/${articleId}/config`, {
    method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ translatorSlots, ...extra }),
  });
}
async function detail(articleId: string) {
  const result = await request(`/api/articles/${articleId}`, { headers: adminHeaders });
  assert.equal(result.response.status, 200);
  return result.body;
}
type Volunteer = { id: string; cookie: string };
async function claim(articleId: string, user: Volunteer, count = 1) {
  const result = await request('/api/assignments/request', {
    method: 'POST', headers: { cookie: user.cookie }, body: JSON.stringify({ userId: user.id, articleId, count }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body.assignments.map((assignment: any) => ({ ...assignment, volunteer: user }));
}

try {
  const articleId = await createArticle('A single sentence shared by multiple volunteers.', 2);
  const volunteers = await Promise.all(Array.from({ length: 10 }, async (_, index): Promise<Volunteer> => {
    const result = await request('/api/auth/register', { method: 'POST', body: JSON.stringify({
      realName: `配额译者${index + 1}`, phone: `100000001${String(index).padStart(2, '0')}`,
      idNumber: `TEST-ARTICLE-ID-${index}`, bankCardNo: `TEST-ARTICLE-CARD-${index}`,
    }) });
    assert.equal(result.response.status, 201, JSON.stringify(result.body));
    return { id: result.body.user.id, cookie: result.response.headers.get('set-cookie')!.split(';')[0] };
  }));

  const initialClaims = (await Promise.all(volunteers.map(user => claim(articleId, user)))).flat();
  assert.equal(initialClaims.length, 2, 'ten concurrent volunteers must fill exactly two slots');
  assert.equal(new Set(initialClaims.map(task => task.sentenceId)).size, 1);
  assert.equal(new Set(initialClaims.map(task => task.volunteer.id)).size, 2);
  assert.equal((await claim(articleId, initialClaims[0].volunteer)).length, 0, 'same person cannot claim the same sentence twice');
  const initial = await detail(articleId);
  assert.equal(initial.article.assignmentCount, 2);
  assert.equal(initial.article.activeAssignments, 2);
  assert.equal(initial.article.remainingSlots, 0);
  assert.equal(initial.article.totalCapacity, 2);
  assert.equal(initial.article.translationCount, 0);

  const increased = await configure(articleId, 4);
  assert.equal(increased.response.status, 200);
  assert.equal(increased.body.article.translatorSlots, 4);
  assert.equal(increased.body.article.remainingSlots, 2);
  assert.match(increased.body.article.updatedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  const newClaims = (await Promise.all(volunteers.map(user => claim(articleId, user)))).flat();
  assert.equal(newClaims.length, 2, 'increasing the ratio must release exactly the added slots');
  const allClaims = [...initialClaims, ...newClaims];
  assert.equal(new Set(allClaims.map(task => task.volunteer.id)).size, 4);

  const decreased = await configure(articleId, 1);
  assert.equal(decreased.response.status, 200);
  assert.equal(decreased.body.article.assignmentCount, 4);
  assert.equal(decreased.body.article.totalCapacity, 1);
  assert.equal(decreased.body.article.remainingSlots, 0);
  assert.equal(decreased.body.article.overCapacitySentenceCount, 1);
  const afterDecreaseClaims = (await Promise.all(volunteers.map(user => claim(articleId, user)))).flat();
  assert.equal(afterDecreaseClaims.length, 0, 'lowering capacity must not create further over-allocation');

  const submitted = await Promise.all(allClaims.map(task => request(`/api/assignments/${task.id}/submit`, {
    method: 'POST', headers: { cookie: task.volunteer.cookie },
    body: JSON.stringify({ userId: task.volunteer.id, content: `保留已有任务 ${task.volunteer.id}` }),
  })));
  assert(submitted.every(result => result.response.status === 201), 'existing tasks must remain submittable after a decrease');
  const afterSubmit = await detail(articleId);
  assert.equal(afterSubmit.article.translationCount, 4);
  assert.equal(afterSubmit.article.pendingTranslationCount, 4);
  assert.equal(afterSubmit.article.activeAssignments, 0);
  assert.equal(afterSubmit.sentences[0].translationCount, 4);
  assert.equal(afterSubmit.sentences[0].pendingTranslationCount, 4);
  assert.equal(afterSubmit.sentences[0].remainingSlots, 0);

  const accepted = await request(`/api/admin/translations/${submitted[0].body.translation.id}/review`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ decision: 'accepted' }),
  });
  assert.equal(accepted.response.status, 200);
  assert.equal((await configure(articleId, 6)).response.status, 200);
  assert.equal((await Promise.all(volunteers.map(user => claim(articleId, user)))).flat().length, 0,
    'an accepted sentence is closed even when capacity increases');
  const closed = await detail(articleId);
  assert.equal(closed.article.acceptedSentenceCount, 1);
  assert.equal(closed.article.pendingTranslationCount, 0);
  assert.equal(closed.article.remainingSlots, 0);
  assert.equal(closed.article.translationCount, 4, 'configuration never deletes historical translations');
  assert.equal(closed.sentences[0].acceptedCount, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM assignments WHERE sentence_id=? AND status='done'").get(initialClaims[0].sentenceId) as { count: number }).count, 4);

  const changedLanguage = await configure(articleId, 3, { targetLanguage: '日文' });
  assert.equal(changedLanguage.response.status, 409);
  assert.match(changedLanguage.body.error, /不能更换目标语种/);
  assert.equal((await detail(articleId)).article.translatorSlots, 6, 'rejected language change must be atomic');

  for (const invalid of [0, -1, 21, 1.5, true, false, null, '', '2', ' ', [], {}]) {
    assert.equal((await configure(articleId, invalid)).response.status, 400, `reject invalid capacity ${JSON.stringify(invalid)}`);
  }
  assert.equal((await configure(articleId, 20)).response.status, 200);
  assert.equal((await configure(articleId, 1)).response.status, 200);
  assert.equal((await configure(articleId, 2, { unrelated: true })).response.status, 400);
  assert.equal((await configure('00000000-0000-4000-8000-000000000000', 2)).response.status, 404);
  const unauthenticated = await request(`/api/admin/articles/${articleId}/config`, { method: 'PATCH', body: JSON.stringify({ translatorSlots: 2 }) });
  assert.equal(unauthenticated.response.status, 401);

  const invalidCreate = await request('/api/admin/articles', { method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ title: 'Invalid capacity', text: 'A sentence.', translatorSlots: true }) });
  assert.equal(invalidCreate.response.status, 400);
  for (const input of ['0', '21', '2.5', ' ', 'true']) {
    const form = new FormData();
    form.set('text', 'Import input validation.');
    form.set('translatorSlots', input);
    const response = await fetch(base + '/api/admin/articles/import', { method: 'POST', headers: adminHeaders, body: form });
    assert.equal(response.status, 400, `reject invalid import capacity ${input}`);
  }
  const validForm = new FormData();
  validForm.set('text', 'First imported sentence. Second imported sentence.');
  validForm.set('translatorSlots', '3');
  const imported = await fetch(base + '/api/admin/articles/import', { method: 'POST', headers: adminHeaders, body: validForm });
  assert.equal(imported.status, 201);
  const importedBody = await imported.json() as any;
  assert.equal(importedBody.article.totalCapacity, 6);
  const twoTasks = await claim(importedBody.articleId, volunteers[0], 2);
  assert.equal(twoTasks.length, 2);
  const mixed = await detail(importedBody.articleId);
  assert.equal(mixed.article.assignmentCount, 2);
  assert.equal(mixed.article.remainingSlots, 4);
  assert.equal(mixed.article.activeAssignments, 2);
  assert(mixed.sentences.every((sentence: any) => sentence.assignmentCount === 1 && sentence.remainingSlots === 2));

  const closingArticle = await createArticle('Only one final translation will be chosen.', 2);
  const [winnerTask] = await claim(closingArticle, volunteers[8]);
  const [lateTask] = await claim(closingArticle, volunteers[9]);
  const winnerSubmit = await request(`/api/assignments/${winnerTask.id}/submit`, {
    method: 'POST', headers: { cookie: volunteers[8].cookie },
    body: JSON.stringify({ userId: volunteers[8].id, content: '保留最终采纳译文。' }),
  });
  assert.equal(winnerSubmit.response.status, 201);
  const winnerReview = await request(`/api/admin/translations/${winnerSubmit.body.translation.id}/review`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ decision: 'accepted' }),
  });
  assert.equal(winnerReview.response.status, 200);
  const lateSubmit = await request(`/api/assignments/${lateTask.id}/submit`, {
    method: 'POST', headers: { cookie: volunteers[9].cookie },
    body: JSON.stringify({ userId: volunteers[9].id, content: '不应成为待审核译文。' }),
  });
  assert.equal(lateSubmit.response.status, 409);
  assert.match(lateSubmit.body.error, /已有采纳译文，本任务已结束/);
  const winnerResubmit = await request(`/api/assignments/${winnerTask.id}/submit`, {
    method: 'POST', headers: { cookie: volunteers[8].cookie },
    body: JSON.stringify({ userId: volunteers[8].id, content: '不能覆盖已采纳译文。' }),
  });
  assert.equal(winnerResubmit.response.status, 409);
  assert.match(winnerResubmit.body.error, /你的译文已采纳/);
  const lateTaskList = await request(`/api/users/${volunteers[9].id}/tasks`, { headers: { cookie: volunteers[9].cookie } });
  assert.equal(lateTaskList.body.tasks.find((task: any) => task.id === lateTask.id).status, 'done');
  const lateTaskDetail = await request(`/api/assignments/${lateTask.id}`, { headers: { cookie: volunteers[9].cookie } });
  assert.equal(lateTaskDetail.body.assignment.status, 'done');
  assert.equal(lateTaskDetail.body.assignment.translationId, null);
  assert.equal(lateTaskDetail.body.assignment.suggestionStatus, 'idle', 'closed task reads must not start a model job');
  const closedDetail = await detail(closingArticle);
  assert.equal(closedDetail.article.activeAssignments, 0);
  assert.equal(closedDetail.article.pendingTranslationCount, 0);
  assert.equal(closedDetail.article.translationCount, 1);
  assert.equal(closedDetail.article.assignmentCount, 2);
  assert.equal((db.prepare('SELECT content FROM translations WHERE id=?').get(winnerSubmit.body.translation.id) as { content: string }).content, '保留最终采纳译文。');
  assert.equal((await claim(importedBody.articleId, volunteers[9])).length, 1, 'closing an old task must not prevent claiming another sentence');

  const list = await request('/api/articles', { headers: adminHeaders });
  assert.deepEqual(list.body.articles.find((article: any) => article.id === articleId), (await detail(articleId)).article,
    'list and detail must use exactly the same aggregate definitions');
  const auditRows = db.prepare("SELECT metadata_json AS metadata FROM audit_logs WHERE action='admin.article.config' AND resource_id=?").all(articleId) as Array<{ metadata: string }>;
  const loweredAudit = auditRows.map(row => JSON.parse(row.metadata)).find(row => row.before.translatorSlots === 4 && row.after.translatorSlots === 1);
  assert.equal(loweredAudit.preservedAssignments, 4);
  assert.equal(loweredAudit.overCapacitySentenceCount, 1);
  assert.equal(db.prepare('SELECT sentence_id,user_id FROM assignments GROUP BY sentence_id,user_id HAVING COUNT(*)>1').get(), undefined);
  console.log('article configuration tests passed: legacy migration, 10-person allocation, increase/decrease, preserved submissions, accepted closure, late submission rejection, aggregates, validation and audit');
} finally {
  server.close();
  await suggestions.close();
  db.close();
}
