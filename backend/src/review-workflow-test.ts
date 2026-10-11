import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb } from './db.js';
import { legacyReviewNote, taskViews, translationHistory, translationView } from './reviews.js';

process.env.DOTENV_CONFIG_PATH = '/dev/null';
Object.assign(process.env, {
  PORT: '0', DB_PATH: ':memory:', NODE_ENV: 'test', SEED_DEMO: 'false',
  ADMIN_KEY: 'review-workflow-test-admin-key-1234567890', PII_ENCRYPTION_KEY: 'review-workflow-test-pii-key',
  LLM_PROVIDER: 'bigmodel', BIGMODEL_KEY_TYPE: 'platform_api',
});
delete process.env.BIGMODEL_API_KEY;
delete process.env.MINIMAX_API_KEY;
delete process.env.REDIS_URL;

// Start from the prior release's translation schema and prove migration retains
// content, dates, old decisions and task ownership across repeated restarts.
const directory = mkdtempSync(path.join(tmpdir(), 'translation-review-migration-'));
try {
  const dbPath = path.join(directory, 'legacy.sqlite');
  const legacy = createDb(dbPath);
  legacy.exec(`DROP TABLE translation_versions;
    ALTER TABLE translations DROP COLUMN review_note;
    ALTER TABLE translations DROP COLUMN revision;
    INSERT INTO users(id,name) VALUES ('one','One'),('two','Two');
    INSERT INTO articles(id,title) VALUES ('article','Historical article');
    INSERT INTO sentences(id,article_id,position,source_text) VALUES
      ('open','article',1,'Open sentence.'),('closed','article',2,'Closed sentence.');
    INSERT INTO assignments(id,sentence_id,user_id,status) VALUES
      ('returned-task','open','one','submitted'),('winner-task','closed','one','done'),('closed-task','closed','two','submitted');
    INSERT INTO translations(id,sentence_id,user_id,content,status,created_at,reviewed_at) VALUES
      ('returned','open','one','Original returned text','rejected','2026-01-01 01:00:00','2026-01-01 02:00:00'),
      ('winner','closed','one','Original chosen text','accepted','2026-01-01 01:00:00','2026-01-01 02:00:00'),
      ('not-selected','closed','two','Original unchosen text','rejected','2026-01-01 01:00:00','2026-01-01 02:00:00');`);
  legacy.close();
  const migrated = createDb(dbPath);
  const returned = taskViews(migrated, { assignmentId: 'returned-task' })[0];
  assert.equal(returned.status, 'assigned');
  assert.equal(returned.reviewStatus, 'returned');
  assert.equal(returned.reviewNote, legacyReviewNote);
  assert.equal(returned.canRevise, true);
  assert.equal(returned.revision, 1);
  assert.equal(returned.submittedContent, 'Original returned text');
  assert.equal(returned.submittedAt, '2026-01-01 01:00:00');
  assert.equal(returned.reviewedAt, '2026-01-01 02:00:00');
  assert.equal(taskViews(migrated, { assignmentId: 'closed-task' })[0].reviewStatus, 'not_selected');
  assert.equal(taskViews(migrated, { assignmentId: 'closed-task' })[0].canSubmit, false);
  const historyBefore = translationHistory(migrated, 'returned');
  const winnerBefore = translationView(migrated, 'winner');
  assert.equal(historyBefore.length, 1);
  migrated.close();
  const restarted = createDb(dbPath);
  assert.deepEqual(translationHistory(restarted, 'returned'), historyBefore);
  assert.deepEqual(translationView(restarted, 'winner'), winnerBefore);
  assert.equal((restarted.prepare('SELECT COUNT(*) AS n FROM translation_versions').get() as { n: number }).n, 3);
  restarted.close();
} finally {
  rmSync(directory, { recursive: true, force: true });
}

const { server, db, suggestions } = await import('./server.js');
const address = server.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const admin = { 'x-admin-key': process.env.ADMIN_KEY! };
type Volunteer = { id: string; cookie: string };
async function request(route: string, options: RequestInit = {}) {
  const response = await fetch(base + route, { ...options, headers: { 'content-type': 'application/json', ...options.headers } });
  return { status: response.status, body: await response.json() as any, response };
}
async function post(route: string, body: Record<string, unknown>, headers: Record<string, string>) {
  return request(route, { method: 'POST', headers, body: JSON.stringify(body) });
}
async function task(user: Volunteer, assignmentId: string) {
  const result = await request(`/api/assignments/${assignmentId}`, { headers: { cookie: user.cookie } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.assignment;
}
async function createArticle(slots: number) {
  const result = await post('/api/admin/articles', { title: 'Revision workflow', text: 'Volunteers help one another.', targetLanguage: '中文', translatorSlots: slots }, admin);
  assert.equal(result.status, 201);
  return result.body.articleId as string;
}
async function claim(user: Volunteer, articleId: string) {
  const result = await post('/api/assignments/request', { userId: user.id, articleId, count: 1 }, { cookie: user.cookie });
  assert.equal(result.status, 200);
  assert.equal(result.body.assignments.length, 1);
  return result.body.assignments[0];
}
async function submit(user: Volunteer, assignmentId: string, content: string, expectedRevision?: number) {
  return post(`/api/assignments/${assignmentId}/submit`, { userId: user.id, content, ...(expectedRevision === undefined ? {} : { expectedRevision }) }, { cookie: user.cookie });
}
async function review(translationId: string, decision: string, expectedRevision?: number, reviewNote?: string) {
  return post(`/api/admin/translations/${translationId}/review`, { decision, expectedRevision, reviewNote }, admin);
}

try {
  const users = await Promise.all(Array.from({ length: 10 }, async (_, i): Promise<Volunteer> => {
    const result = await post('/api/auth/register', { realName: `审核志愿者${i + 1}`, phone: `100000004${String(i).padStart(2, '0')}`, idNumber: `TEST-REVIEW-ID-${i}`, bankCardNo: `TEST-REVIEW-CARD-${i}` }, {});
    assert.equal(result.status, 201);
    return { id: result.body.user.id, cookie: result.response.headers.get('set-cookie')!.split(';')[0] };
  }));
  const articleId = await createArticle(4);
  const tasks = await Promise.all(users.slice(0, 4).map(user => claim(user, articleId)));
  assert(tasks.every(item => item.revision === 0 && item.reviewStatus === null && item.canSubmit));
  const initial = await Promise.all(users.slice(0, 3).map((user, i) => submit(user, tasks[i].id, `初稿 ${i}`, 0)));
  assert(initial.every(result => result.status === 201));
  const translationId = initial[0].body.translation.id as string;
  assert.equal(initial[0].body.translation.revision, 1);
  assert.equal(initial[0].body.translation.reviewStatus, 'pending');
  assert.equal((await submit(users[0], tasks[0].id, '不能覆盖待审核稿', 1)).status, 409);
  for (const reason of ['', '   ', '长'.repeat(1001)]) {
    assert.equal((await review(translationId, 'returned', 1, reason)).status, 400);
  }
  const returnRequests = await Promise.all(Array.from({ length: 10 }, () => review(translationId, 'returned', 1, '请补全主语，统一志愿者的用词。')));
  assert.equal(returnRequests.filter(result => result.status === 200).length, 1);
  assert.equal(returnRequests.filter(result => result.status === 409).length, 9);
  assert.equal((await review(initial[2].body.translation.id, 'returned', 1, '保留这条旧版修改建议。')).status, 200);
  const returned = await task(users[0], tasks[0].id);
  assert.equal(returned.reviewStatus, 'returned');
  assert.equal(returned.reviewNote, '请补全主语，统一志愿者的用词。');
  assert.equal(returned.canRevise, true);
  assert.equal(returned.canSubmit, true);
  assert.equal(returned.status, 'assigned');
  assert(returned.reviewedAt);
  const taskList = await request(`/api/users/${users[0].id}/tasks`, { headers: { cookie: users[0].cookie } });
  for (const field of ['id', 'reviewStatus', 'reviewNote', 'revision', 'reviewedAt', 'canRevise', 'canSubmit', 'closed', 'submittedContent']) {
    assert.deepEqual(taskList.body.tasks[0][field], returned[field]);
  }
  const returnedFilter = await request(`/api/admin/translations?reviewStatus=returned&userId=${users[0].id}&articleId=${articleId}`, { headers: admin });
  assert.equal(returnedFilter.body.translations.length, 1);
  assert.equal(returnedFilter.body.translations[0].userId, users[0].id);
  const article = await request(`/api/articles/${articleId}`, { headers: admin });
  assert.equal(article.body.article.activeAssignments, 3, 'two returned plus one unsubmitted task remain active');
  assert.equal(article.body.article.pendingTranslationCount, 1);
  assert.equal(article.body.article.returnedTranslationCount, 2);
  assert.equal(article.body.article.remainingSlots, 0, 'return retains the same volunteer slot');
  const returnedReport = await request(`/api/admin/reports?articleId=${articleId}`, { headers: admin });
  assert.equal(returnedReport.body.totals.returnedTranslationCount, 2);
  assert.equal(returnedReport.body.totals.pendingTranslationCount, 1);
  assert.equal(returnedReport.body.translators.find((row: any) => row.userId === users[0].id).returnedCount, 1);

  assert.equal((await submit(users[0], tasks[0].id, '重提必须带版本')).status, 409);
  assert.equal((await submit(users[0], tasks[0].id, '错误版本', 0)).status, 409);
  const resubmits = await Promise.all(Array.from({ length: 10 }, (_, i) => submit(users[0], tasks[0].id, `志愿者们互相帮助。修订 ${i}`, 1)));
  assert.equal(resubmits.filter(result => result.status === 201).length, 1);
  assert.equal(resubmits.filter(result => result.status === 409).length, 9);
  const newVersion = resubmits.find(result => result.status === 201)!.body.translation;
  assert.equal(newVersion.id, translationId);
  assert.equal(newVersion.revision, 2);
  assert.equal(newVersion.reviewStatus, 'pending');
  assert.equal(newVersion.reviewNote, null);
  assert.equal(newVersion.reviewedAt, null);
  assert.equal((await review(translationId, 'accepted', 1)).status, 409, 'a stale reviewer cannot approve different content');
  assert.equal((await review(translationId, 'accepted')).status, 409, 'legacy clients must refresh a revised translation');
  assert.equal((await review(translationId, 'returned', 1, '旧页面原因')).status, 409);
  const duplicateAccepts = await Promise.all(Array.from({ length: 10 }, () => review(translationId, 'accepted', 2)));
  assert.equal(duplicateAccepts.filter(result => result.status === 200).length, 1);
  assert.equal(duplicateAccepts.filter(result => result.status === 409).length, 9);
  const accepted = await task(users[0], tasks[0].id);
  assert.equal(accepted.reviewStatus, 'accepted');
  assert.equal(accepted.canSubmit, false);
  assert.equal(accepted.canRevise, false);
  assert.equal(accepted.closed, true);
  assert.equal(accepted.submittedContent, newVersion.content);
  for (const i of [1, 2]) {
    const other = await task(users[i], tasks[i].id);
    assert.equal(other.reviewStatus, 'not_selected');
    assert.equal(other.canRevise, false);
    assert.equal(other.closed, true);
    assert.equal(other.reviewNote, null);
    assert.equal((await submit(users[i], tasks[i].id, '不能重新进入已结束句子', 1)).status, 409);
  }
  const unsubmitted = await task(users[3], tasks[3].id);
  assert.equal(unsubmitted.translationId, null);
  assert.equal(unsubmitted.closed, true);
  assert.equal(unsubmitted.canSubmit, false);
  assert.equal((await submit(users[3], tasks[3].id, '不允许迟交', 0)).status, 409);
  assert.equal((await review(translationId, 'returned', 2, '不可退回')).status, 409);
  assert.equal((await submit(users[0], tasks[0].id, '不可覆盖采纳译文', 2)).status, 409);
  const history = await request(`/api/assignments/${tasks[0].id}/history`, { headers: { cookie: users[0].cookie } });
  assert.equal(history.body.history.length, 2);
  assert.equal(history.body.history[0].reviewStatus, 'accepted');
  assert.equal(history.body.history[0].content, newVersion.content);
  assert.equal(history.body.history[1].reviewStatus, 'returned');
  assert.equal(history.body.history[1].content, '初稿 0');
  assert.equal(history.body.history[1].reviewNote, '请补全主语，统一志愿者的用词。');
  const previouslyReturned = await request(`/api/admin/translations/${initial[2].body.translation.id}/history`, { headers: admin });
  assert.equal(previouslyReturned.body.history[0].reviewStatus, 'returned');
  assert.equal(previouslyReturned.body.history[0].reviewNote, '保留这条旧版修改建议。');
  const unchosenHistory = await request(`/api/admin/translations/${initial[1].body.translation.id}/history`, { headers: admin });
  assert.equal(unchosenHistory.body.history[0].reviewStatus, 'not_selected');
  assert.equal((await request(`/api/assignments/${tasks[0].id}/history`)).status, 401);
  assert.equal((await request(`/api/assignments/${tasks[0].id}/history`, { headers: { cookie: users[1].cookie } })).status, 403);
  assert.equal((await request(`/api/users/${users[0].id}/tasks`, { headers: { cookie: users[1].cookie } })).status, 403);
  assert.equal((await request(`/api/admin/translations/${translationId}/history`, { headers: { cookie: users[0].cookie } })).status, 401);
  assert.equal((await post(`/api/assignments/${tasks[0].id}/submit`, { userId: users[0].id, content: '越权', expectedRevision: 2 }, { cookie: users[1].cookie })).status, 403);

  const closedReport = await request(`/api/admin/reports?articleId=${articleId}`, { headers: admin });
  assert.equal(closedReport.body.totals.pendingTranslationCount, 0);
  assert.equal(closedReport.body.totals.returnedTranslationCount, 0);
  assert.equal(closedReport.body.totals.notSelectedTranslationCount, 2);
  assert.equal(closedReport.body.totals.translationCount, 3, 'versions are not double counted as additional volunteers');
  const exported = await fetch(base + `/api/admin/reports/export.csv?articleId=${articleId}`, { headers: admin });
  const csv = await exported.text();
  assert.match(csv, /审核意见/);
  assert.match(csv, /已采纳/);
  assert.match(csv, /未采纳/);

  const contestedArticle = await createArticle(10);
  const contestedTasks = await Promise.all(users.map(user => claim(user, contestedArticle)));
  const contestedSubmissions = await Promise.all(users.map((user, i) => submit(user, contestedTasks[i].id, `并发候选译文 ${i}`, 0)));
  assert(contestedSubmissions.every(result => result.status === 201));
  const competingReviews = await Promise.all(contestedSubmissions.map(result => review(result.body.translation.id, 'accepted', 1)));
  assert.equal(competingReviews.filter(result => result.status === 200).length, 1);
  assert.equal(competingReviews.filter(result => result.status === 409).length, 9);
  const contestedRows = await request(`/api/admin/translations?articleId=${contestedArticle}`, { headers: admin });
  assert.equal(contestedRows.body.translations.filter((row: any) => row.reviewStatus === 'accepted').length, 1);
  assert.equal(contestedRows.body.translations.filter((row: any) => row.reviewStatus === 'not_selected').length, 9);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM translation_versions WHERE review_status='pending'").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='admin.translation.accepted'").get() as { n: number }).n, 2, 'duplicate requests do not create duplicate accepted audit events');
  console.log('review workflow tests passed: legacy migration, return reason, versioned resubmission, stale-review conflict, volunteer visibility, immutable history, slot/report accounting, identity isolation, 10 duplicate submissions/reviews and 10 competing volunteers');
} finally {
  server.close();
  await suggestions.close();
  db.close();
}
