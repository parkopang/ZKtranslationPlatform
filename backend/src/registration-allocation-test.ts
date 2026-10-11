import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb } from './db.js';

process.env.DOTENV_CONFIG_PATH = '/dev/null';
Object.assign(process.env, { PORT: '0', DB_PATH: ':memory:', NODE_ENV: 'test', SEED_DEMO: 'false', SIMULATION_ENV: 'false',
  ADMIN_KEY: 'registration-allocation-admin-key-1234567890', PII_ENCRYPTION_KEY: 'registration-allocation-pii-key', LLM_PROVIDER: 'bigmodel' });
delete process.env.BIGMODEL_API_KEY;
delete process.env.MINIMAX_API_KEY;
delete process.env.REDIS_URL;
delete process.env.REGISTRATION_MODE;
// A later encryption rollout must not turn arbitrary duplicate demonstration
// phone values into a unique real-phone identity key.
const directory = mkdtempSync(path.join(tmpdir(), 'open-registration-migration-'));
try {
  const dbPath = path.join(directory, 'legacy.sqlite');
  const prior = createDb(dbPath);
  prior.exec("INSERT INTO users(id,name,phone,verification_status,verification_source) VALUES ('a','A','anything','verified','registration_bypass'),('b','B','anything','verified','registration_bypass')");
  prior.close();
  const reopened = createDb(dbPath);
  const rows = reopened.prepare('SELECT phone,phone_hash AS phoneHash FROM users').all() as Array<{ phone: string; phoneHash: string | null }>;
  assert.equal(rows.length, 2);
  assert(rows.every(row => row.phone.startsWith('enc:v1:') && row.phoneHash === null));
  reopened.close();
} finally { rmSync(directory, { recursive: true, force: true }); }

const { server, db, suggestions } = await import('./server.js');
const address = server.address(); assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const admin = { 'x-admin-key': process.env.ADMIN_KEY! };
async function request(route: string, data?: Record<string, unknown>, headers: Record<string, string> = {}) {
  const response = await fetch(base + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { status: response.status, body: await response.json() as any, cookie: response.headers.getSetCookie()[0]?.split(';')[0] };
}
async function article(text: string, translatorSlots: number) {
  const result = await request('/api/admin/articles', { title: 'Directed volunteer allocation', text, translatorSlots }, admin);
  assert.equal(result.status, 201);
  return result.body.articleId as string;
}
async function assign(articleId: string, userIds: string[], count = 1, headers: Record<string, string> = admin) {
  return request(`/api/admin/articles/${articleId}/assign`, { userIds, count }, headers);
}
try {
  assert.equal((await request('/api/auth/registration-config')).body.mode, 'standard');
  assert.equal((await request('/api/auth/register', {})).status, 400);
  assert.equal((await request('/api/auth/register', { realName: '生产格式', phone: '任意', idNumber: '随意', bankCardNo: '随意' })).status, 400);
  process.env.SIMULATION_ENV = 'true';
  const config = await request('/api/auth/registration-config');
  assert.equal(config.body.mode, 'open'); assert.equal(config.body.fieldsRequired, false); assert.equal(config.body.externalVerificationEnabled, false);
  process.env.REGISTRATION_MODE = 'standard';
  assert.equal((await request('/api/auth/registration-config')).body.mode, 'standard');
  assert.equal((await request('/api/auth/register', {})).status, 400, 'explicit standard overrides the simulation default');
  process.env.SIMULATION_ENV = 'false';
  process.env.REGISTRATION_MODE = 'open';
  assert.equal((await request('/api/auth/registration-config')).body.mode, 'open');
  const empty = await request('/api/auth/register', {});
  assert.equal(empty.status, 201, 'explicit open registration works without simulation mode');
  assert.match(empty.body.user.name, /^志愿者/);
  assert.equal(empty.body.user.verificationStatus, 'verified');
  assert.equal(empty.body.user.verificationSource, 'registration_bypass');
  delete process.env.REGISTRATION_MODE;
  process.env.SIMULATION_ENV = 'true';
  const arbitrary = await Promise.all(Array.from({ length: 10 }, (_, i) => request('/api/auth/register', { realName: `自由注册${i}`, phone: '任意手机号', idNumber: '随便填', bankCardNo: '银行卡暂未提供' })));
  assert(arbitrary.every(result => result.status === 201));
  const ids = arbitrary.map(result => result.body.user.id as string);
  assert.equal(new Set(ids).size, 10);
  const identities = db.prepare("SELECT phone,phone_hash AS hash,id_number AS idNumber,bank_card_no AS bankCardNo,verification_source AS source FROM users WHERE name LIKE '自由注册%'").all() as Array<Record<string, unknown>>;
  assert.equal(identities.length, 10);
  assert(identities.every(row => row.hash === null && row.source === 'registration_bypass' && String(row.phone).startsWith('enc:v1:') && String(row.idNumber).startsWith('enc:v1:') && String(row.bankCardNo).startsWith('enc:v1:')));
  assert.equal((await request('/api/auth/register', { realName: '长'.repeat(501) })).status, 400);
  assert.equal((await request('/api/admin/volunteers')).status, 401);
  assert.equal((await request('/api/assignments/request', { userId: ids[0], count: 1 })).status, 401);
  assert.equal((await request(`/api/users/${ids[0]}/tasks`)).status, 401);
  const people = await request('/api/admin/volunteers', undefined, admin);
  assert.equal(people.body.volunteers.length, 11, 'include every registered volunteer even without any submission');
  assert(people.body.volunteers.every((row: any) => row.assignedCount === 0 && row.submittedCount === 0));
  assert(people.body.volunteers.every((row: any) => !('phone' in row) && !('idNumber' in row) && !('bankCardNo' in row) && !('openId' in row)));
  const registrationAudit = db.prepare("SELECT metadata_json AS metadata FROM audit_logs WHERE action='translator.register'").all() as Array<{ metadata: string }>;
  assert(registrationAudit.every(row => JSON.parse(row.metadata).externalVerificationPerformed === false));

  const articleId = await article('First shared sentence. Second shared sentence.', 2);
  assert.equal((await assign(articleId, [ids[0]], 1, { cookie: arbitrary[0].cookie! })).status, 401);
  assert.equal((await assign(articleId, [ids[0], crypto.randomUUID()], 1)).status, 400);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM assignments').get() as { n: number }).n, 0, 'invalid batch must not allocate to the valid user first');
  assert.equal((await assign(articleId, [ids[0], ids[0]], 1)).status, 400);
  assert.equal((await assign(articleId, ids, 3)).status, 400);
  assert.equal((await assign(articleId, Array.from({ length: 51 }, () => crypto.randomUUID()), 1)).status, 400);
  const batch = await assign(articleId, ids.slice(0, 3), 2);
  assert.equal(batch.status, 200);
  assert.equal(batch.body.totalRequested, 6);
  assert.equal(batch.body.assignedCount, 4);
  assert.deepEqual(batch.body.results.map((row: any) => row.assignedCount), [2, 2, 0]);
  assert.equal(batch.body.results[0].skippedReason, null);
  assert(batch.body.results[2].skippedReason);
  assert.equal(batch.body.article.remainingSlots, 0);
  const repeat = await assign(articleId, ids.slice(0, 3), 2);
  assert.equal(repeat.body.assignedCount, 0);
  for (const i of [0, 1]) {
    const tasks = await request(`/api/users/${ids[i]}/tasks`, undefined, { cookie: arbitrary[i].cookie! });
    assert.equal(tasks.status, 200);
    assert.equal(tasks.body.tasks.length, 2);
    assert(tasks.body.tasks.every((task: any) => task.articleId === articleId && task.canSubmit));
  }
  const partiallyFilled = await article('Only a single sentence.', 2);
  const partial = await assign(partiallyFilled, [ids[2]], 2);
  assert.equal(partial.body.assignedCount, 1);
  assert(partial.body.results[0].skippedReason);

  const concurrentArticle = await article('Ten administrators must share a capacity of three.', 3);
  const concurrent = await Promise.all(Array.from({ length: 10 }, () => assign(concurrentArticle, ids, 1)));
  assert(concurrent.every(result => result.status === 200));
  assert.equal(concurrent.reduce((sum, result) => sum + result.body.assignedCount, 0), 3);
  const overallocated = db.prepare(`SELECT s.id FROM sentences s JOIN assignments x ON x.sentence_id=s.id GROUP BY s.id HAVING COUNT(*)>s.translator_slots`).all();
  assert.equal(overallocated.length, 0);
  assert.equal(db.prepare('SELECT sentence_id,user_id FROM assignments GROUP BY sentence_id,user_id HAVING COUNT(*)>1').get(), undefined);

  const terminalArticle = await article('This sentence will be closed.', 2);
  const beforeAccept = await assign(terminalArticle, [ids[0]], 1);
  const taskId = beforeAccept.body.results[0].assignments[0].id;
  const submission = await request(`/api/assignments/${taskId}/submit`, { userId: ids[0], content: '该句即将完成。', expectedRevision: 0 }, { cookie: arbitrary[0].cookie! });
  assert.equal(submission.status, 201);
  assert.equal((await request(`/api/admin/translations/${submission.body.translation.id}/review`, { decision: 'accepted', expectedRevision: 1 }, admin)).status, 200);
  const afterAccept = await assign(terminalArticle, [ids[1]], 1);
  assert.equal(afterAccept.body.assignedCount, 0);
  assert(afterAccept.body.results[0].skippedReason);
  const counts = await request('/api/admin/volunteers', undefined, admin);
  const first = counts.body.volunteers.find((row: any) => row.id === ids[0]);
  assert.equal(first.submittedCount, 1); assert.equal(first.acceptedCount, 1);
  assert.equal(first.activeCount, first.assignedCount - 1);
  process.env.SIMULATION_ENV = 'false';
  assert.equal((await request('/api/auth/register', {})).status, 400, 'relaxed registration must remain confined to the configured environment');
  console.log('registration/allocation tests passed: explicit open registration without simulation, standard override and legacy simulation defaults, arbitrary duplicate encrypted identity fields, explicit verification source, no anonymous tasks, slim volunteer list, atomic partial allocation, 10 concurrent batches, capacity/deduplication and accepted closure');
} finally { server.close(); await suggestions.close(); db.close(); }
