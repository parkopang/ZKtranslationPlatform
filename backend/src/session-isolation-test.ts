import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DOTENV_CONFIG_PATH = '/dev/null';
Object.assign(process.env, { PORT: '0', DB_PATH: ':memory:', NODE_ENV: 'test', SEED_DEMO: 'false', SIMULATION_ENV: 'false',
  ADMIN_KEY: 'session-isolation-admin-key-123456789012345', PII_ENCRYPTION_KEY: 'session-isolation-pii-key', LLM_PROVIDER: 'bigmodel' });
delete process.env.BIGMODEL_API_KEY;
delete process.env.MINIMAX_API_KEY;
delete process.env.REDIS_URL;
const { server, db, suggestions } = await import('./server.js');
const address = server.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const adminCookie = 'translation_admin_session';
const translatorCookie = 'translation_translator_session';
type Jar = Map<string, string>;
async function request(route: string, jar: Jar, data?: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  const response = await fetch(base + route, { method: data === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...extraHeaders },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const setCookies = response.headers.getSetCookie();
  for (const cookie of setCookies) {
    const [pair] = cookie.split(';'); const at = pair.indexOf('='); const name = pair.slice(0, at); const value = pair.slice(at + 1);
    if (/Max-Age=0(?:;|$)/i.test(cookie)) jar.delete(name); else jar.set(name, value);
  }
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('etag'), null);
  return { status: response.status, body: await response.json() as any, setCookies };
}
let registrationIndex = 0;
async function register(jar: Jar) {
  registrationIndex += 1;
  const result = await request('/api/auth/register', jar, { realName: `双会话志愿者${registrationIndex}`, phone: `10000007${String(registrationIndex).padStart(3, '0')}`, idNumber: 'TEST-ID-SESSION', bankCardNo: 'TEST-CARD-SESSION' });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert(result.setCookies[0].startsWith(`${translatorCookie}=`));
  assert(result.setCookies[0].includes('HttpOnly'));
  return result.body.user.id as string;
}
async function login(jar: Jar) {
  const result = await request('/api/admin/auth/login', jar, { key: process.env.ADMIN_KEY });
  assert.equal(result.status, 200);
  assert(result.setCookies[0].startsWith(`${adminCookie}=`));
}
function mint(role: 'translator' | 'admin', userId: string | null = null, expiresAt = new Date(Date.now() + 60_000).toISOString()) {
  const token = crypto.randomUUID();
  db.prepare('INSERT INTO sessions(id,token_hash,user_id,role,expires_at) VALUES(?,?,?,?,?)')
    .run(crypto.randomUUID(), crypto.createHash('sha256').update(token).digest('hex'), userId, role, expiresAt);
  return token;
}
function revoked(token: string) {
  const row = db.prepare('SELECT revoked_at FROM sessions WHERE token_hash=?').get(crypto.createHash('sha256').update(token).digest('hex')) as { revoked_at: string | null } | undefined;
  return !row || Boolean(row.revoked_at);
}
try {
  const jar: Jar = new Map();
  const userId = await register(jar);
  const firstTranslatorToken = jar.get(translatorCookie)!;
  await login(jar);
  assert.equal(jar.get(translatorCookie), firstTranslatorToken, 'admin login must preserve translator identity');
  assert.equal(jar.size, 2);
  assert.equal((await request('/api/auth/session', jar)).body.user.id, userId);
  assert.equal((await request('/api/admin/auth/session', jar)).status, 200);
  const article = await request('/api/admin/articles', jar, { title: 'Both workspaces share progress', text: 'Volunteers can review their progress.', targetLanguage: '中文', translatorSlots: 2 });
  assert.equal(article.status, 201);
  const assignment = await request('/api/assignments/request', jar, { userId, articleId: article.body.articleId, count: 1 });
  assert.equal(assignment.status, 200);
  const task = assignment.body.assignments[0];
  const submit = await request(`/api/assignments/${task.id}/submit`, jar, { userId, content: '志愿者可以查看自己的进度。', expectedRevision: 0 });
  assert.equal(submit.status, 201);
  const reviewed = await request(`/api/admin/translations/${submit.body.translation.id}/review`, jar, { decision: 'accepted', expectedRevision: 1 });
  assert.equal(reviewed.status, 200);
  assert.equal((await request(`/api/users/${userId}/tasks`, jar)).body.tasks[0].reviewStatus, 'accepted');
  const auditRows = db.prepare("SELECT actor_role AS role,actor_user_id AS userId,action FROM audit_logs WHERE action IN ('translator.register','translator.translation.submit','admin.translation.accepted')").all() as Array<{ role: string; userId: string | null; action: string }>;
  assert(auditRows.some(row => row.action === 'translator.translation.submit' && row.role === 'translator' && row.userId === userId));
  assert(auditRows.some(row => row.action === 'admin.translation.accepted' && row.role === 'admin' && row.userId === null));
  assert(auditRows.some(row => row.action === 'translator.register' && row.role === 'translator' && row.userId === userId));
  assert.equal((await request('/api/auth/logout', jar, {})).status, 200);
  assert.equal(jar.has(translatorCookie), false);
  assert.equal((await request('/api/auth/session', jar)).status, 401);
  assert.equal((await request('/api/admin/auth/session', jar)).status, 200);
  assert(revoked(firstTranslatorToken));
  const secondUserId = await register(jar);
  assert.equal((await request('/api/admin/auth/session', jar)).status, 200);
  await request('/api/admin/auth/logout', jar, {});
  assert.equal((await request('/api/admin/auth/session', jar)).status, 401);
  assert.equal((await request('/api/auth/session', jar)).body.user.id, secondUserId);
  assert.equal((await request(`/api/users/${userId}/tasks`, jar)).status, 403);
  assert.equal((await request('/api/auth/session', jar, undefined, { 'if-none-match': '*' })).status, 200);

  const legacyTranslator = mint('translator', userId);
  const legacyJar = new Map([['translation_session', legacyTranslator]]);
  assert.equal((await request('/api/auth/session', legacyJar)).body.user.id, userId);
  assert.equal((await request('/api/admin/auth/session', legacyJar)).status, 401);
  await login(legacyJar);
  assert.equal(legacyJar.get('translation_session'), legacyTranslator);
  assert.equal((await request('/api/auth/session', legacyJar)).body.user.id, userId);
  await request('/api/admin/auth/logout', legacyJar, {});
  assert.equal(legacyJar.get('translation_session'), legacyTranslator, 'logging out admin must not clear legacy translator');
  assert(!revoked(legacyTranslator));
  await request('/api/auth/logout', legacyJar, {});
  assert.equal(legacyJar.has('translation_session'), false);
  assert(revoked(legacyTranslator));
  assert.equal((await request('/api/auth/session', new Map([['translation_session', legacyTranslator]]))).status, 401);

  const legacyAdmin = mint('admin');
  const legacyAdminJar = new Map([['translation_session', legacyAdmin]]);
  assert.equal((await request('/api/auth/session', legacyAdminJar)).status, 401);
  assert.equal((await request('/api/admin/auth/session', legacyAdminJar)).status, 200);
  const thirdUserId = await register(legacyAdminJar);
  assert.equal(legacyAdminJar.get('translation_session'), legacyAdmin);
  await request('/api/auth/logout', legacyAdminJar, {});
  assert.equal((await request('/api/admin/auth/session', legacyAdminJar)).status, 200);
  await request('/api/admin/auth/logout', legacyAdminJar, {});
  assert.equal(legacyAdminJar.has('translation_session'), false);
  assert(revoked(legacyAdmin));

  const primary = mint('translator', userId);
  const older = mint('translator', secondUserId);
  const doubleTranslator = new Map([[translatorCookie, primary], ['translation_session', older]]);
  assert.equal((await request('/api/auth/session', doubleTranslator)).body.user.id, userId);
  await request('/api/auth/logout', doubleTranslator, {});
  assert(revoked(primary) && revoked(older));
  assert.equal((await request('/api/auth/session', new Map([['translation_session', older]]))).status, 401, 'old cookie cannot revive after role logout');
  const stillValidLegacy = mint('translator', thirdUserId);
  assert.equal((await request('/api/auth/session', new Map([[translatorCookie, 'invalid'], ['translation_session', stillValidLegacy]]))).status, 401, 'invalid explicit cookie must not switch identities');
  const expired = mint('translator', userId, new Date(Date.now() - 1000).toISOString());
  assert.equal((await request('/api/auth/session', new Map([[translatorCookie, expired]]))).status, 401, 'a session expiring earlier today is expired');
  const wrongRole = mint('admin');
  assert.equal((await request('/api/auth/session', new Map([[translatorCookie, wrongRole]]))).status, 401);
  assert.equal((await request('/api/admin/auth/session', new Map([[adminCookie, stillValidLegacy]]))).status, 401);
  const rotationLegacy = mint('translator', userId);
  const rotationJar = new Map([['translation_session', rotationLegacy], [adminCookie, mint('admin')]]);
  await register(rotationJar);
  assert(revoked(rotationLegacy));
  assert.equal(rotationJar.has('translation_session'), false);
  assert.equal((await request('/api/admin/auth/session', rotationJar)).status, 200);
  console.log('session isolation tests passed: same-origin register/admin login/submit/review, role-correct audit, independent logout, legacy migration and revocation, no identity fallback, expiry and no-store responses');
} finally {
  server.close(); await suggestions.close(); db.close();
}
