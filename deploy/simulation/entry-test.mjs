import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('./public/entry.js', import.meta.url), 'utf8');
function page(respond, storedUser) {
  const values = new Map(storedUser ? [['zk_user', JSON.stringify(storedUser)], ['zk_registered', '1']] : []);
  const calls = [];
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, { dataset: {}, textContent: '', disabled: false, querySelector: () => element(`${id}-label`) });
    return elements.get(id);
  }
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const context = vm.createContext({
    localStorage: storage, sessionStorage: storage, location: { href: '' }, AbortSignal,
    document: { getElementById: element, querySelectorAll: () => [element('translator'), element('new-translator'), element('admin')] },
    fetch: async (path, options) => {
      calls.push({ path, method: options.method });
      const result = respond(path, options);
      return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => result.body };
    },
  });
  vm.runInContext(source, context);
  return { context, calls, values, click: id => element(id).onclick(), status: () => element('status') };
}

test('anonymous entry opens registration without creating users or assigning tasks', async () => {
  const p = page(() => ({ status: 401, body: { authenticated: false } }), { id: 'stale-local-user' });
  await p.click('translator');
  assert.equal(p.context.location.href, '/?workspace=translator&register=1');
  assert.equal(p.values.has('zk_user'), false);
  assert.deepEqual(p.calls, [{ path: '/api/auth/session', method: 'GET' }]);
});

test('a database-backed session restores the same volunteer without automatic assignment', async () => {
  const p = page(() => ({ status: 200, body: { authenticated: true, user: { id: 'existing', name: '已注册志愿者' } } }));
  await p.click('translator');
  assert.equal(JSON.parse(p.values.get('zk_user')).id, 'existing');
  assert.equal(p.context.location.href, '/?workspace=translator');
  assert.deepEqual(p.calls, [{ path: '/api/auth/session', method: 'GET' }]);
});

test('administrator entry preserves the volunteer identity', async () => {
  const p = page(() => ({ status: 200, body: { ok: true } }), { id: 'existing', name: '已注册志愿者' });
  await p.click('admin');
  assert.equal(JSON.parse(p.values.get('zk_user')).id, 'existing');
  assert.equal(p.values.get('zk_registered'), '1');
  assert.equal(p.context.location.href, '/?workspace=admin');
  assert.deepEqual(p.calls, [{ path: '/api/admin/auth/login', method: 'POST' }]);
});

test('new volunteer entry only exits translator session and opens registration', async () => {
  const p = page(path => path.endsWith('/logout') ? { status: 200, body: { ok: true } } : { status: 401, body: { authenticated: false } }, { id: 'existing' });
  await p.click('new-translator');
  assert.equal(p.context.location.href, '/?workspace=translator&register=1');
  assert.deepEqual(p.calls, [{ path: '/api/auth/logout', method: 'POST' }, { path: '/api/auth/session', method: 'GET' }]);
});

test('session outage preserves identity and reports failure instead of creating a replacement account', async () => {
  const p = page(() => ({ status: 503, body: { error: '服务暂时不可用' } }), { id: 'existing' });
  await p.click('translator');
  assert.equal(p.context.location.href, '');
  assert.equal(JSON.parse(p.values.get('zk_user')).id, 'existing');
  assert.match(p.status().textContent, /服务暂时不可用/);
  assert.equal(p.calls.length, 1);
});
