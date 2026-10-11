import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import { transformWithOxc } from 'vite'

const source = readFileSync(new URL('../src/volunteer-allocation.ts', import.meta.url), 'utf8').replace(/^import .*from '\.\/api'\n/m, '')
const transformed = await transformWithOxc(source, 'volunteer-allocation.ts', { lang: 'ts' })
const javascript = transformed.code.replace(/^export /gm, '') + '\nglobalThis.exports = { readVolunteers, filterVolunteers, validateAllocationSelection, readAllocationResult, loadRegisteredVolunteers, allocateArticleVolunteers };'
const volunteer = (id = 'volunteer-one', overrides = {}) => ({ id, name: '王志愿', assignedCount: 0, activeCount: 0, submittedCount: 0, acceptedCount: 0, ...overrides })
const copy = value => JSON.parse(JSON.stringify(value))
function harness(respond = async () => ({})) {
  const calls = []
  const sandbox = { exports: {}, getAdminKey: () => 'test-admin', request: async (path, options) => { calls.push({ path, options }); return respond(path, options) } }
  vm.runInNewContext(javascript, sandbox)
  return { ...sandbox.exports, calls }
}

test('registered volunteers with zero submissions remain selectable and identity fields are discarded', () => {
  const h = harness()
  const result = h.readVolunteers({ volunteers: [volunteer('new', { phone: 'private-phone', idNumber: 'private-id', bankCardNo: 'private-bank' })] })
  assert.equal(result.length, 1)
  assert.equal(result[0].submittedCount, 0)
  assert.equal(result[0].assignedCount, 0)
  assert(!JSON.stringify(result).includes('private'))
  assert(!('phone' in result[0]))
  assert.throws(() => h.readVolunteers({ volunteers: [volunteer('same'), volunteer('same')] }))
  assert.throws(() => h.readVolunteers({ volunteers: [volunteer('bad', { activeCount: -1 })] }))
})

test('name and account search includes new volunteers and is case insensitive', () => {
  const h = harness()
  const rows = h.readVolunteers({ volunteers: [volunteer('ABC-new'), volunteer('xyz', { name: '李志愿' })] })
  assert.deepEqual(copy(h.filterVolunteers(rows, '  王  ')).map(row => row.id), ['ABC-new'])
  assert.deepEqual(copy(h.filterVolunteers(rows, ' abc ')).map(row => row.id), ['ABC-new'])
  assert.equal(h.filterVolunteers(rows, '').length, 2)
  assert.equal(h.filterVolunteers(rows, 'nobody').length, 0)
})

test('bulk selection enforces unique volunteers, up to fifty people and one or two sentences each', () => {
  const h = harness()
  h.validateAllocationSelection(['one', 'two'], 2)
  h.validateAllocationSelection(Array.from({ length: 50 }, (_, i) => String(i)), 1)
  for (const [ids, count] of [[[], 1], [['one', 'one'], 2], [['one'], 0], [['one'], 3], [Array.from({ length: 51 }, (_, i) => String(i)), 1]]) {
    assert.throws(() => h.validateAllocationSelection(ids, count))
  }
})

test('partial allocation confirms each volunteer and preserves capacity feedback', () => {
  const h = harness()
  const payload = { results: [
    { userId: 'one', userName: '志愿者一', assignedCount: 2, skippedReason: null, assignments: [{ id: 'a' }, { id: 'b' }] },
    { userId: 'two', userName: '志愿者二', assignedCount: 1, skippedReason: '剩余名额不足', assignments: [{ id: 'c' }] },
    { userId: 'three', userName: '志愿者三', assignedCount: 0, skippedReason: '已领取所有可用句子', assignments: [] },
  ], assignedCount: 3, totalRequested: 6 }
  const result = h.readAllocationResult(payload, ['one', 'two', 'three'], 2)
  assert.equal(result.assignedCount, 3)
  assert.equal(result.totalRequested, 6)
  assert.equal(result.results[1].skippedReason, '剩余名额不足')
  assert.equal(result.results[2].assignedCount, 0)
  assert(!('assignments' in result.results[0]))
})

test('malformed or incomplete results must not be shown as successful allocations', () => {
  const h = harness()
  const row = { userId: 'one', userName: 'One', assignedCount: 1, skippedReason: null, assignments: [{ id: 'a' }] }
  const valid = { results: [row], assignedCount: 1, totalRequested: 1 }
  for (const invalid of [
    { ...valid, results: [] },
    { ...valid, assignedCount: 2 },
    { ...valid, totalRequested: 2 },
    { ...valid, results: [{ ...row, userId: 'other' }] },
    { ...valid, results: [{ ...row, assignments: [] }] },
    { ...valid, results: [{ ...row, assignedCount: 2, assignments: [{ id: 'a' }, { id: 'b' }] }] },
  ]) assert.throws(() => h.readAllocationResult(invalid, ['one'], 1))
})

test('allocation client uses the article-specific authenticated endpoint and no profile secrets', async () => {
  const h = harness(async (path) => path === '/api/admin/volunteers' ? { volunteers: [volunteer('one')] } : {
    results: [{ userId: 'one', userName: '王志愿', assignedCount: 1, assignments: [{ id: 'a' }], skippedReason: null }], assignedCount: 1, totalRequested: 1,
  })
  await h.loadRegisteredVolunteers()
  await h.allocateArticleVolunteers('article/id', ['one'], 1)
  assert.equal(h.calls[0].path, '/api/admin/volunteers')
  assert.equal(h.calls[1].path, '/api/admin/articles/article%2Fid/assign')
  assert.equal(h.calls[1].options.method, 'POST')
  assert.equal(h.calls[1].options.headers['X-Admin-Key'], 'test-admin')
  assert.deepEqual(JSON.parse(h.calls[1].options.body), { userIds: ['one'], count: 1 })
})
