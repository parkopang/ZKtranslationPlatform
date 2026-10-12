import assert from 'node:assert/strict';

process.env.DOTENV_CONFIG_PATH = '/dev/null';
Object.assign(process.env, { PORT: '0', DB_PATH: ':memory:', NODE_ENV: 'test', SEED_DEMO: 'false', SIMULATION_ENV: 'false', REGISTRATION_MODE: 'open', ADMIN_KEY: 'entry-management-admin-key', PII_ENCRYPTION_KEY: 'entry-management-pii-key' });
delete process.env.REDIS_URL;
delete process.env.BIGMODEL_API_KEY;
delete process.env.MINIMAX_API_KEY;

const { server, db, suggestions } = await import('./server.js');
const address = server.address(); assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const admin = { 'x-admin-key': process.env.ADMIN_KEY! };

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(base + path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
  return { status: response.status, body: await response.json() as any, cookie: response.headers.getSetCookie()[0]?.split(';')[0] };
}

try {
  const publicEntry = await request('/api/admin/entries', { method: 'POST', headers: admin, body: JSON.stringify({ code: 'east-public', name: '华东公众号', channel: 'public_account' }) });
  assert.equal(publicEntry.status, 201);
  const miniEntry = await request('/api/admin/entries', { method: 'POST', headers: admin, body: JSON.stringify({ code: 'south-mini', name: '华南小程序', channel: 'mini_program' }) });
  assert.equal(miniEntry.status, 201);
  assert.equal((await request('/api/admin/entries', { headers: admin })).body.entries.length, 3);
  const config = await request('/api/auth/registration-config?entry=east-public&channel=public-account');
  assert.equal(config.status, 200); assert.equal(config.body.entry.code, 'east-public'); assert.equal(config.body.entry.channel, 'public_account');
  assert.equal((await request('/api/auth/registration-config?entry=east-public&channel=mini-program')).status, 400);

  const registered = await request('/api/auth/register', { method: 'POST', body: JSON.stringify({ realName: '华东志愿者', phone: '任意', idNumber: '任意', bankCardNo: '任意', entryCode: 'east-public', entryChannel: 'public_account' }) });
  assert.equal(registered.status, 201); assert.equal(registered.body.user.entryCode, 'east-public'); assert.equal(registered.body.user.entryName, '华东公众号');
  const filteredUsers = await request('/api/admin/users?entryCode=east-public', { headers: admin });
  assert.equal(filteredUsers.body.users.length, 1); assert.equal(filteredUsers.body.users[0].entryCode, 'east-public');

  const immutable = await request(`/api/admin/entries/${publicEntry.body.entry.id}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ code: 'east-renamed' }) });
  assert.equal(immutable.status, 400);
  const disabled = await request(`/api/admin/entries/${miniEntry.body.entry.id}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ enabled: false }) });
  assert.equal(disabled.status, 200); assert.equal(disabled.body.entry.enabled, false);
  assert.equal((await request('/api/auth/registration-config?entry=south-mini&channel=mini-program')).status, 400);

  const stored = db.prepare('SELECT entry_id AS entryId FROM users WHERE id=?').get(registered.body.user.id) as { entryId: string };
  assert.equal(stored.entryId, publicEntry.body.entry.id);
  const article = await request('/api/admin/articles', { method: 'POST', headers: admin, body: JSON.stringify({ title: '入口来源文章', text: 'Entry source sentence.', translatorSlots: 1 }) });
  assert.equal(article.status, 201);
  const assigned = await request('/api/assignments/request', { method: 'POST', headers: { cookie: registered.cookie! }, body: JSON.stringify({ userId: registered.body.user.id, articleId: article.body.articleId, count: 1 }) });
  assert.equal(assigned.status, 200);
  const submitted = await request(`/api/assignments/${assigned.body.assignments[0].id}/submit`, { method: 'POST', headers: { cookie: registered.cookie! }, body: JSON.stringify({ userId: registered.body.user.id, content: '入口来源译文' }) });
  assert.equal(submitted.status, 201);
  const pending = await request('/api/admin/translations?entryCode=east-public', { headers: admin });
  assert.equal(pending.body.translations.length, 1); assert.equal(pending.body.translations[0].entryName, '华东公众号');
  const report = await request('/api/admin/reports?entryCode=east-public', { headers: admin });
  assert.equal(Number(report.body.totals.translationCount), 1); assert.equal(report.body.translators[0].userId, registered.body.user.id);
  const csv = await fetch(`${base}/api/admin/reports/export.csv?entryCode=east-public`, { headers: admin });
  assert.equal(csv.status, 200); assert.match(await csv.text(), /入口编码/);
  console.log('entry management tests passed: admin CRUD, channel-specific links, registration attribution, filtering, immutable codes and disabled-entry rejection');
} finally { server.close(); await suggestions.close(); db.close(); }
