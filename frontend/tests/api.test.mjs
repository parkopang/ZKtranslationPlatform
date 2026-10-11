import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import { transformWithOxc } from 'vite'

const source = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const transformed = await transformWithOxc(source.replaceAll('import.meta.env', '__env'), 'api.ts', { lang: 'ts' })
const javascript = transformed.code.replace(/^export /gm, '') + '\nglobalThis.exports = { api, isDemo, taskDraftKey, taskEditable, taskNeedsSync, groupReviewByVolunteer };'


function harness(env = {}, respond = () => ({})) {
  const calls = []
  const values = new Map([['zk_user', JSON.stringify({ id: 'user-real' })]])
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) }
  const sandbox = {
    exports: {}, __env: { DEV: false, ...env }, localStorage: storage, sessionStorage: storage,
    window: { setTimeout, clearTimeout }, AbortController, FormData,
    fetch: async (url, options) => {
      calls.push({ url, options })
      const result = await respond(url, options)
      return new Response(JSON.stringify(result.body ?? result), { status: result.status ?? 200, headers: { 'Content-Type': 'application/json' } })
    },
  }
  vm.runInNewContext(javascript, sandbox)
  return { ...sandbox.exports, calls }
}

const payload = { realName: '测试译者', phone: '13800000000', idNumber: 'test-only', bankCardNo: 'test-only' }

test('production defaults to /api and ignores the demo flag', async () => {
  const h = harness({ VITE_DEMO_MODE: 'true' }, () => ({ tasks: [] }))
  assert.equal(h.isDemo, false)
  assert.equal((await h.api.getTasks()).length, 0)
  assert.equal(h.calls[0].url, '/api/users/user-real/tasks')
  assert.equal(h.calls[0].options.credentials, 'include')
})

test('only explicit development demo uses sample data', async () => {
  const demo = harness({ DEV: true, VITE_DEMO_MODE: 'true' })
  assert.equal(demo.isDemo, true)
  assert.equal((await demo.api.getTasks()).length, 3)
  assert.equal(demo.calls.length, 0)
  const dev = harness({ DEV: true }, () => ({ tasks: [] }))
  await dev.api.getTasks()
  assert.equal(dev.calls.length, 1)
})

test('configured API URLs normalize /api without duplication', async () => {
  const h = harness({ VITE_API_BASE_URL: 'https://translation.example/api/' }, () => ({ tasks: [] }))
  await h.api.getTasks()
  assert.equal(h.calls[0].url, 'https://translation.example/api/users/user-real/tasks')
})

test('failed, pending and empty suggestions cannot become usable translations', async () => {
  const states = ['idle', 'queued', 'running', 'retrying', 'failed', 'succeeded']
  const h = harness({}, () => ({ tasks: states.map((status, i) => ({ id: String(i), suggestionStatus: status, translationSuggestion: i === 5 ? '  ' : 'unsafe placeholder', suggestionError: 'Authorization: secret-key', suggestionRetryAt: 1791432100000 })) }))
  const tasks = await h.api.getTasks()
  for (const task of tasks) assert.equal(task.ai, '')
  assert.equal(tasks[5].aiStatus, 'failed')
  assert.equal(tasks[3].aiRetryAt, 1791432100000)
  assert.equal(tasks[0].aiRetryAt, undefined)
  assert.ok(!JSON.stringify(tasks).includes('secret-key'))
  assert.ok(tasks[4].aiError.includes('人工翻译'))
})

test('a valid successful suggestion keeps the target language and submitted draft', async () => {
  const h = harness({}, () => ({ tasks: [{ id: 'a', suggestionStatus: 'succeeded', translationSuggestion: '  预译  ', submittedContent: '人工译文', targetLanguage: '中文', translationId: 't', translationStatus: 'pending' }] }))
  const [task] = await h.api.getTasks()
  assert.equal(task.ai, '预译')
  assert.equal(task.aiStatus, 'succeeded')
  assert.equal(task.targetLanguage, '中文')
  assert.equal(task.submittedContent, '人工译文')
  assert.equal(task.completed, 1)
})

test('network/server failures never return demo success or report numbers', async () => {
  const h = harness({}, () => ({ status: 503, body: { error: '服务暂不可用' } }))
  for (const call of [() => h.api.register(payload), () => h.api.submit('a', '译文'), () => h.api.getSummary(), () => h.api.requestTasks(), () => h.api.getArticles()]) {
    await assert.rejects(call, /服务暂不可用/)
  }
})

test('malformed 200 responses do not confirm writes or valid empty reports', async () => {
  const h = harness({}, () => ({}))
  for (const call of [() => h.api.register(payload), () => h.api.submit('a', '译文'), () => h.api.getSummary(), () => h.api.getTasks(), () => h.api.requestTasks(), () => h.api.getArticles(), () => h.api.getSegments()]) {
    await assert.rejects(call)
  }
  assert.equal(await h.api.adminSession(), false)
  await assert.rejects(() => h.api.importArticle({ title: 'x', targetLanguage: '中文' }), /请选择/)
})

test('manual translation submission uses its explicit assignment ID', async () => {
  const h = harness({}, () => ({ translation: { id: 'translation-real' } }))
  assert.equal((await h.api.submit('selected-assignment', '人工译文')).ok, true)
  assert.equal(h.calls[0].url, '/api/assignments/selected-assignment/submit')
  assert.equal(JSON.parse(h.calls[0].options.body).content, '人工译文')
})

test('article mapping separates configured capacity, actual assignments, submissions and accepted sentences', async () => {
  const h = harness({}, () => ({ articles: [{ id: 'article-real', title: '协作文章', sentenceCount: 6, acceptedSentenceCount: 1, translatorSlots: 8,
    totalCapacity: 48, assignmentCount: 14, translationCount: 11, pendingTranslationCount: 7, remainingSlots: 30,
    activeAssignments: 2, overCapacitySentenceCount: 0, createdAt: '2026-10-01', updatedAt: '2026-10-08' }] }))
  const [article] = await h.api.getArticles()
  assert.equal(article.translatorSlots, 8)
  assert.equal(article.totalCapacity, 48)
  assert.equal(article.assignmentCount, 14)
  assert.equal(article.translationCount, 11)
  assert.equal(article.pendingTranslationCount, 7)
  assert.equal(article.remainingSlots, 30)
  assert.equal(article.done, 1)
  assert.equal(article.status, '进行中')
  assert.equal(article.updatedAt, '2026-10-08')
  assert.equal(article.createdAt, '2026-10-01')
})

test('article details retain assignments above a lowered cap and accepted sentences remain closed', async () => {
  const h = harness({}, () => ({ article: { id: 'article', sentenceCount: 2, translatorSlots: 1, overCapacitySentenceCount: 1 },
    sentences: [{ id: 's1', position: 1, sourceText: 'Source', translatorSlots: 1, assignmentCount: 3, translationCount: 2, pendingTranslationCount: 2, remainingSlots: 0, acceptedCount: 0 },
      { id: 's2', position: 2, sourceText: 'Accepted', translatorSlots: 1, assignmentCount: 1, translationCount: 1, remainingSlots: 0, acceptedCount: 1 }] }))
  const detail = await h.api.getArticle('article/id')
  assert.equal(h.calls[0].url, '/api/articles/article%2Fid')
  assert.equal(detail.sentences[0].assignmentCount, 3)
  assert.equal(detail.sentences[0].translatorSlots, 1)
  assert.equal(detail.sentences[0].remainingSlots, 0)
  assert.equal(detail.sentences[1].acceptedCount, 1)
  assert.equal(detail.sentences[1].remainingSlots, 0)
  assert.equal(detail.article.overCapacitySentenceCount, 1)
})

test('configuration validates 1-20 integers, sends only the allocation field and requires confirmed values', async () => {
  const h = harness({}, (_, options) => ({ article: { id: 'article-real', translatorSlots: JSON.parse(options.body).translatorSlots } }))
  for (const value of [0, 21, 1.5, NaN, Infinity]) await assert.rejects(() => h.api.updateArticleConfig('article-real', value), /1–20/)
  assert.equal(h.calls.length, 0)
  const article = await h.api.updateArticleConfig('article-real', 3)
  assert.equal(article.translatorSlots, 3)
  assert.equal(h.calls[0].url, '/api/admin/articles/article-real/config')
  assert.equal(h.calls[0].options.method, 'PATCH')
  assert.deepEqual(JSON.parse(h.calls[0].options.body), { translatorSlots: 3 })
  const malformed = harness({}, () => ({ article: { id: 'article-real', translatorSlots: 2 } }))
  await assert.rejects(() => malformed.api.updateArticleConfig('article-real', 3), /未确认配置结果/)
  await assert.rejects(() => harness({}, () => ({})).api.getArticle('article-real'), /文章详情数据格式异常/)
})

test('closed assignments do not become submitted translations and preserve the volunteer draft', async () => {
  const h = harness({}, () => ({ tasks: [{ id: 'closed-unsubmitted', status: 'done', sourceText: 'Original', suggestionStatus: 'idle' },
    { id: 'accepted', status: 'done', translationId: 'winner', translationStatus: 'accepted', submittedContent: '已采纳译文' },
    { id: 'other', status: 'done', translationId: 'other-submission', translationStatus: 'rejected', submittedContent: '另一版译文' }] }))
  const [unsubmitted, accepted, other] = await h.api.getTasks()
  assert.equal(unsubmitted.closed, true)
  assert.equal(unsubmitted.completed, 0)
  assert.equal(unsubmitted.status, '已结束')
  assert.equal(accepted.closed, true)
  assert.equal(accepted.completed, 1)
  assert.equal(accepted.status, '已采纳')
  assert.equal(other.closed, true)
  assert.equal(other.completed, 1)
  assert.equal(other.status, '未采纳')
  assert.equal(other.submittedContent, '另一版译文')
})

test('review results distinguish returned work, not-selected work and unsubmitted closed tasks', async () => {
  const h = harness({}, () => ({ tasks: [
    { id: 'returned-task', translationId: 't1', status: 'submitted', translationStatus: 'rejected', reviewStatus: 'returned', reviewNote: '请补充遗漏的条件。', revision: 2, reviewedAt: '2026-10-08 10:00:00', submittedContent: '第二版原译文' },
    { id: 'pending-task', translationId: 't2', status: 'submitted', reviewStatus: 'pending', revision: 1 },
    { id: 'accepted-task', translationId: 't3', status: 'done', reviewStatus: 'accepted', revision: 3 },
    { id: 'not-selected-task', translationId: 't4', status: 'done', reviewStatus: 'not_selected', revision: 1 },
    { id: 'closed-task', status: 'assigned', closed: true, revision: 0 },
  ] }))
  const [returned, pending, accepted, notSelected, closed] = await h.api.getTasks()
  assert.equal(returned.status, '退回重译')
  assert.equal(returned.reviewNote, '请补充遗漏的条件。')
  assert.equal(returned.revision, 2)
  assert.equal(returned.completed, 1, 'resubmissions retain one contribution per task')
  assert.equal(returned.submittedContent, '第二版原译文')
  assert.equal(h.taskEditable(returned), true)
  assert.equal(h.taskNeedsSync(returned), true)
  assert.equal(h.taskNeedsSync(pending), true, 'submitted work must keep polling for a decision')
  assert.equal(h.taskEditable(pending), false)
  assert.equal(accepted.status, '已采纳')
  assert.equal(notSelected.status, '未采纳')
  assert.equal(closed.status, '已结束')
  assert.equal(closed.completed, 0)
  for (const task of [accepted, notSelected, closed]) { assert.equal(h.taskEditable(task), false); assert.equal(h.taskNeedsSync(task), false) }
  assert.notEqual(h.taskDraftKey(returned), h.taskDraftKey({ ...returned, revision: 3 }), 'a V2 draft must never overwrite V3 automatically')
})

test('volunteer grouping uses stable user IDs even when names are identical', async () => {
  const rows = [
    { id: 'a', userId: 'volunteer-one', userName: '同名译者', articleId: 'article', sentenceId: 'sentence', reviewStatus: 'pending', revision: 1 },
    { id: 'b', userId: 'volunteer-two', userName: '同名译者', articleId: 'article', sentenceId: 'sentence', reviewStatus: 'returned', revision: 2, reviewNote: '修正术语' },
    { id: 'c', userId: 'volunteer-one', userName: '同名译者', articleId: 'article', sentenceId: 'other-sentence', reviewStatus: 'accepted', revision: 1 },
  ]
  const h = harness({}, () => ({ translations: rows }))
  const items = await h.api.getReviewSubmissions()
  const groups = h.groupReviewByVolunteer(items)
  assert.equal(h.calls[0].url, '/api/admin/translations')
  assert.equal(groups.length, 2)
  assert.equal(groups[0].id, 'volunteer-one')
  assert.equal(groups[0].counts.pending, 1)
  assert.equal(groups[0].counts.accepted, 1)
  assert.equal(groups[1].counts.returned, 1)
  assert.equal(items[1].reviewNote, '修正术语')
})

test('return decisions require a reason and send the exact reviewed revision', async () => {
  const h = harness({}, (_, options) => ({ translation: { id: 'submission/id', ...JSON.parse(options.body), reviewStatus: JSON.parse(options.body).decision, revision: JSON.parse(options.body).expectedRevision } }))
  await assert.rejects(() => h.api.review('submission/id', 'returned', 2, '   '), /原因/)
  await assert.rejects(() => h.api.review('submission/id', 'returned', 2, 'x'.repeat(1001)), /1000/)
  await assert.rejects(() => h.api.review('submission/id', 'accepted', 0), /版本/)
  assert.equal(h.calls.length, 0)
  const result = await h.api.review('submission/id', 'returned', 2, '  请统一术语。  ')
  assert.equal(result.reviewStatus, 'returned')
  assert.equal(h.calls[0].url, '/api/admin/translations/submission%2Fid/review')
  assert.deepEqual(JSON.parse(h.calls[0].options.body), { decision: 'returned', expectedRevision: 2, reviewNote: '请统一术语。' })
})

test('resubmission keeps the assignment and confirms the next version', async () => {
  const h = harness({}, (_, options) => ({ translation: { id: 'same-translation', revision: JSON.parse(options.body).expectedRevision + 1, reviewStatus: 'pending' } }))
  const result = await h.api.submit('same-assignment', '修改后的译文', 2)
  assert.equal(result.revision, 3)
  assert.equal(h.calls[0].url, '/api/assignments/same-assignment/submit')
  assert.equal(JSON.parse(h.calls[0].options.body).expectedRevision, 2)
  const malformed = harness({}, () => ({ translation: { id: 'same-translation', revision: 2, reviewStatus: 'pending' } }))
  await assert.rejects(() => malformed.api.submit('same-assignment', '修改后的译文', 2), /未确认提交版本/)
})

test('review conflicts and malformed successes are never presented as successful decisions', async () => {
  const conflict = harness({}, () => ({ status: 409, body: { error: '译文版本已更新，请刷新后再审核' } }))
  await assert.rejects(() => conflict.api.review('t1', 'accepted', 1), (error) => error.status === 409 && /版本已更新/.test(error.message))
  await assert.rejects(() => conflict.api.submit('a1', '旧版草稿', 1), (error) => error.status === 409)
  const malformed = harness({}, () => ({ translation: { id: 't1', revision: 1, reviewStatus: 'pending' } }))
  await assert.rejects(() => malformed.api.review('t1', 'accepted', 1), /未确认审核结果/)
  await assert.rejects(() => harness({}, () => ({ translations: [{ id: 't1', userName: '缺少账号' }] })).api.getReviewSubmissions(), /审核数据格式异常/)
})

test('revision history preserves prior return reasons and uses role-specific routes', async () => {
  const h = harness({}, () => ({ history: [
    { revision: 1, content: '原稿', reviewStatus: 'returned', reviewNote: '请补译后半句', submittedAt: '2026-10-08 09:00:00', reviewedAt: '2026-10-08 09:30:00' },
    { revision: 2, content: '完整译稿', reviewStatus: 'accepted', submittedAt: '2026-10-08 10:00:00', reviewedAt: '2026-10-08 10:30:00' },
  ] }))
  const history = await h.api.getRevisionHistory('assignment', 'assignment/id')
  assert.equal(history[0].revision, 2)
  assert.equal(history[1].reviewNote, '请补译后半句')
  assert.equal(h.calls[0].url, '/api/assignments/assignment%2Fid/history')
  await h.api.getRevisionHistory('translation', 'translation/id')
  assert.equal(h.calls[1].url, '/api/admin/translations/translation%2Fid/history')
  await assert.rejects(() => harness({}, () => ({})).api.getRevisionHistory('assignment', 'x'), /修订记录格式异常/)
})

test('independent roles use their own session and logout routes without clearing translator identity on admin logout', async () => {
  const h = harness({}, (url) => url === '/api/auth/session' ? { authenticated: true, user: { id: 'cookie-owner', name: '会话本人' } } : url === '/api/admin/auth/session' ? { authenticated: true } : url.includes('/tasks') ? { tasks: [] } : { ok: true })
  assert.equal((await h.api.translatorSession()).user.id, 'cookie-owner')
  assert.equal(await h.api.adminSession(), true)
  await h.api.logout('admin')
  await h.api.getTasks(undefined, 'cookie-owner')
  await h.api.getTasks()
  assert.equal(h.calls[2].url, '/api/admin/auth/logout')
  assert.equal(h.calls[3].url, '/api/users/cookie-owner/tasks', 'cookie-verified identity wins over stale localStorage')
  assert.equal(h.calls[4].url, '/api/users/user-real/tasks', 'admin logout must not erase the translator local identity')
  await h.api.logout('translator')
  assert.equal(h.calls[5].url, '/api/auth/logout')
  const signedOut = harness({}, () => ({ status: 401, body: { error: '未登录' } }))
  assert.equal((await signedOut.api.translatorSession()).authenticated, false)
  await assert.rejects(() => harness({}, () => ({ status: 503, body: { error: '网络异常' } })).api.translatorSession(), /网络异常/)
})

test('registration mode comes from server and failures never implicitly relax validation', async () => {
  assert.equal((await harness({}, () => ({ mode: 'open', fieldsRequired: false })).api.registrationConfig()).mode, 'open')
  assert.equal((await harness({}, () => ({ mode: 'standard', fieldsRequired: true })).api.registrationConfig()).fieldsRequired, true)
  await assert.rejects(() => harness({}, () => ({})).api.registrationConfig(), /无法确认/)
  await assert.rejects(() => harness({}, () => ({ status: 503, body: { error: '不可用' } })).api.registrationConfig(), /不可用/)
  const open = harness({}, () => ({ user: { id: 'new-registered-volunteer', name: '志愿者' } }))
  await open.api.register({ realName: '', phone: '', idNumber: '', bankCardNo: '' })
  assert.equal(open.calls[0].url, '/api/auth/register')
  assert.equal(JSON.parse(open.calls[0].options.body).phone, '')
})
