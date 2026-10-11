export type AiStatus = 'idle' | 'queued' | 'running' | 'retrying' | 'succeeded' | 'failed'

export type ReviewStatus = 'pending' | 'accepted' | 'returned' | 'not_selected'
export type SegmentStatus = '待翻译' | '翻译中' | '待审核' | '已采纳' | '已结束' | '未采纳' | '退回重译'
export type TaskUnit = 'sentence' | 'paragraph' | 'chapter'

export const taskUnitLabels: Record<TaskUnit, { noun: string; action: string; description: string }> = {
  sentence: { noun: '句子', action: '按句子分派', description: '适合短句、术语和需要多人逐句比对的内容。' },
  paragraph: { noun: '段落', action: '按段落分派', description: '保留上下文，适合连续叙述和完整段落翻译。' },
  chapter: { noun: '章节', action: '按章节分派', description: '识别章节标题并整章协作；没有标题时按自然段分派。' },
}

export function taskUnitLabel(unit: TaskUnit | string | undefined, plural = false): string {
  const label = taskUnitLabels[(unit || 'sentence') as TaskUnit]?.noun || '句子'
  return plural ? `${label}任务` : label
}

export type Segment = {
  id: string
  no: number
  articleTitle?: string
  taskUnit?: TaskUnit
  source: string
  ai: string
  aiStatus: AiStatus
  aiError?: string
  aiRetryAt?: number
  submittedContent?: string
  targetLanguage?: string
  status: SegmentStatus
  language: string
  assignees: number
  completed: number
  closed?: boolean
  reviewStatus?: ReviewStatus
  reviewNote?: string
  revision?: number
  reviewedAt?: string
  submittedAt?: string
  submissions?: Submission[]
}

export type Submission = {
  id: string
  user: string
  avatar: string
  translation: string
  score: number
  submittedAt: string
  accepted?: boolean
}

export type ReviewSubmission = {
  id: string; userId: string; userName: string; articleId: string; articleTitle: string
  sentenceId: string; position: number; sourceText: string; content: string; taskUnit: TaskUnit
  sourceLanguage: string; targetLanguage: string; reviewStatus: ReviewStatus
  reviewNote: string; revision: number; createdAt: string; reviewedAt: string
}
export type RevisionRecord = { revision: number; content: string; reviewStatus: ReviewStatus; reviewNote: string; submittedAt: string; reviewedAt: string }

export function reviewStatusOf(row: any): ReviewStatus | undefined {
  const state = row.reviewStatus || row.translationStatus || row.status
  if (['pending', 'accepted', 'returned', 'not_selected'].includes(state)) return state
  if (state === 'rejected') return row.status === 'done' ? 'not_selected' : 'returned'
  return undefined
}

export const taskDraftKey = (task: Pick<Segment, 'id' | 'revision'>) => `${task.id}:${task.revision || 0}`
export const taskEditable = (task: Segment) => !task.closed && (task.completed === 0 || task.reviewStatus === 'returned')
export const taskNeedsSync = (task: Segment) => !task.closed && (!task.reviewStatus || task.reviewStatus === 'pending' || task.reviewStatus === 'returned')

function mapReviewSubmission(row: any): ReviewSubmission {
  const status = reviewStatusOf(row)
  if (!row.id || !row.userId || !row.sentenceId || !status || !Number.isInteger(Number(row.revision)) || Number(row.revision) < 1) throw new Error('审核数据格式异常，请刷新后重试')
  return { id: row.id, userId: row.userId, userName: row.userName || '志愿者', articleId: row.articleId || '', articleTitle: row.articleTitle || row.title || '',
    sentenceId: row.sentenceId, position: Number(row.position) || 1, sourceText: row.sourceText || '', content: row.content || '',
    taskUnit: (row.taskUnit === 'paragraph' || row.taskUnit === 'chapter' ? row.taskUnit : 'sentence') as TaskUnit,
    sourceLanguage: row.sourceLanguage || '原文', targetLanguage: row.targetLanguage || '目标语种', reviewStatus: status,
    reviewNote: row.reviewNote || '', revision: Number(row.revision), createdAt: row.createdAt || '', reviewedAt: row.reviewedAt || '' }
}

export function groupReviewByVolunteer(rows: ReviewSubmission[]) {
  const groups = new Map<string, { id: string; name: string; submissions: ReviewSubmission[]; counts: Record<ReviewStatus, number> }>()
  for (const row of rows) {
    const group = groups.get(row.userId) || { id: row.userId, name: row.userName, submissions: [], counts: { pending: 0, accepted: 0, returned: 0, not_selected: 0 } }
    group.submissions.push(row); group.counts[row.reviewStatus] += 1; groups.set(row.userId, group)
  }
  return [...groups.values()].sort((a, b) => b.counts.pending - a.counts.pending || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

export type Article = {
  id: string
  title: string
  sourceLanguage: string
  targetLanguage: string
  taskUnit: TaskUnit
  segments: number
  done: number
  status: '进行中' | '已完成' | '草稿'
  translatorSlots: number
  totalCapacity: number
  assignmentCount: number
  translationCount: number
  pendingTranslationCount: number
  activeAssignments: number
  remainingSlots: number
  overCapacitySentenceCount: number
  createdAt: string
  updatedAt: string
}

export type ArticleSentence = {
  id: string
  position: number
  sourceText: string
  translatorSlots: number
  assignmentCount: number
  translationCount: number
  pendingTranslationCount: number
  activeAssignments: number
  remainingSlots: number
  acceptedCount: number
}

export type ArticleDetail = { article: Article; sentences: ArticleSentence[] }

export type RegisterPayload = {
  realName: string
  phone: string
  idNumber: string
  bankCardNo: string
}

export type RegisteredUser = {
  id: string
  name: string
  realName: string
  phone: string
  idNumber?: string | null
  bankCardNo?: string | null
  verificationStatus?: 'pending' | 'verified' | 'rejected'
}

export const mockSegments: Segment[] = [
  {
    id: 'seg-001', no: 1,
    source: 'The future of healthcare is not just about treating disease, but about creating a healthier society.',
    ai: '医疗的未来不只是治疗疾病，更是构建一个更健康的社会。',
    aiStatus: 'succeeded',
    status: '待审核', language: '英语 → 中文', assignees: 3, completed: 3,
    submissions: [
      { id: 'sub-001', user: '林晓雯', avatar: '林', translation: '医疗的未来不只是治愈疾病，更在于打造一个更加健康的社会。', score: 96, submittedAt: '今天 10:24' },
      { id: 'sub-002', user: '周子涵', avatar: '周', translation: '医疗的未来不仅是治疗疾病，更是创造一个更健康的社会。', score: 91, submittedAt: '今天 10:29' },
      { id: 'sub-003', user: '陈一鸣', avatar: '陈', translation: '未来医疗不单是治病，而是建设一个更健康的社会。', score: 88, submittedAt: '今天 10:41' },
    ],
  },
  {
    id: 'seg-002', no: 2,
    source: 'Digital tools can help clinicians make more informed decisions and improve patient outcomes.',
    ai: '数字化工具可以帮助临床医生做出更明智的决策，改善患者的治疗效果。',
    aiStatus: 'succeeded',
    status: '翻译中', language: '英语 → 中文', assignees: 3, completed: 2,
    submissions: [{ id: 'sub-004', user: '王思远', avatar: '王', translation: '数字工具能够辅助临床医生做出更充分的决策，从而改善患者结局。', score: 94, submittedAt: '今天 11:05' }],
  },
  {
    id: 'seg-003', no: 3,
    source: 'This approach puts patients at the centre of every conversation.',
    ai: '这种方法将患者置于每一次交流的核心。',
    aiStatus: 'succeeded',
    status: '待翻译', language: '英语 → 中文', assignees: 3, completed: 0,
  },
  {
    id: 'seg-004', no: 4,
    source: 'Evidence-based practice is the foundation of high-quality care.',
    ai: '循证实践是高质量医疗服务的基础。',
    aiStatus: 'succeeded',
    status: '已采纳', language: '英语 → 中文', assignees: 3, completed: 3,
  },
]

export const mockArticles: Article[] = [
  { id: 'art-001', title: 'Digital Health: A New Era of Care', sourceLanguage: '英语', targetLanguage: '中文', taskUnit: 'sentence', segments: 28, done: 18, status: '进行中', updatedAt: '2026-09-30 11:20' },
  { id: 'art-002', title: 'Global Oncology Trends 2026', sourceLanguage: '英语', targetLanguage: '中文', taskUnit: 'paragraph', segments: 46, done: 46, status: '已完成', updatedAt: '2026-09-29 16:42' },
  { id: 'art-003', title: '患者旅程与数字疗法', sourceLanguage: '中文', targetLanguage: '英语', taskUnit: 'chapter', segments: 16, done: 0, status: '草稿', updatedAt: '2026-09-28 09:10' },
].map((article) => mapArticle(article))

// Production always uses the real API, including builds without an explicit URL.
export const isDemo = import.meta.env.DEV && import.meta.env.VITE_DEMO_MODE === 'true'
const base = (import.meta.env.VITE_API_BASE_URL?.trim() || '/api').replace(/\/$/, '')
const apiUrl = (path: string) => `${base.endsWith('/api') && path.startsWith('/api/') ? base.slice(0, -4) : base}${path}`

export function getAdminKey(): string {
  try { return sessionStorage.getItem('zk_admin_key') || '' } catch { return '' }
}

export function setAdminKey(value: string): void {
  if (value.trim()) sessionStorage.setItem('zk_admin_key', value.trim())
  else sessionStorage.removeItem('zk_admin_key')
}

function currentUserId(): string | null {
  try { return JSON.parse(localStorage.getItem('zk_user') || 'null')?.id || null } catch { return null }
}

function mapSuggestion(task: any): Pick<Segment, 'ai' | 'aiStatus' | 'aiError' | 'aiRetryAt'> {
  const text = typeof task.translationSuggestion === 'string' ? task.translationSuggestion.trim() : ''
  const statuses: AiStatus[] = ['idle', 'queued', 'running', 'retrying', 'succeeded', 'failed']
  const status: AiStatus = statuses.includes(task.suggestionStatus) ? task.suggestionStatus : text ? 'succeeded' : 'idle'
  const aiStatus = status === 'succeeded' && !text ? 'failed' : status
  const retryAt = Number(task.suggestionRetryAt)
  return {
    ai: aiStatus === 'succeeded' ? text : '',
    aiStatus,
    // Provider error payloads may contain internals; show a stable, safe message.
    aiError: aiStatus === 'failed' ? 'AI 预译暂不可用，请继续人工翻译。' : undefined,
    aiRetryAt: aiStatus === 'retrying' && Number.isFinite(retryAt) && retryAt > 0 ? retryAt : undefined,
  }
}

function mapTask(task: any): Segment {
  const reviewStatus = reviewStatusOf(task)
  const closed = task.closed === true || task.status === 'done' || reviewStatus === 'accepted' || reviewStatus === 'not_selected'
  return {
    id: task.id,
    taskUnit: (task.taskUnit === 'paragraph' || task.taskUnit === 'chapter' ? task.taskUnit : 'sentence') as TaskUnit,
    no: task.position || 1,
    articleTitle: task.title,
    source: task.sourceText || '',
    ...mapSuggestion(task),
    submittedContent: task.submittedContent || '',
    targetLanguage: task.targetLanguage || '',
    status: reviewStatus === 'accepted' ? '已采纳' : reviewStatus === 'not_selected' ? '未采纳' : closed ? '已结束' : reviewStatus === 'returned' ? '退回重译' : task.translationId ? '待审核' : '待翻译',
    language: `原文 → ${task.targetLanguage || '目标语种'}`,
    assignees: 1,
    completed: task.translationId ? 1 : 0,
    closed, reviewStatus, reviewNote: task.reviewNote || '', revision: Number(task.revision) || (task.translationId ? 1 : 0),
    reviewedAt: task.reviewedAt || '', submittedAt: task.submittedAt || task.translationCreatedAt || '',
  }
}

function mapArticle(article: any): Article {
  const total = Number(article.sentenceCount || article.segments || 0)
  const done = Number(article.acceptedSentenceCount || article.done || 0)
  const translatorSlots = Number(article.translatorSlots || 2)
  return {
    id: article.id, title: article.title, sourceLanguage: article.sourceLanguage || '自动', targetLanguage: article.targetLanguage || '中文',
    taskUnit: (article.taskUnit === 'paragraph' || article.taskUnit === 'chapter' ? article.taskUnit : 'sentence') as TaskUnit,
    segments: total, done, status: done >= total && total > 0 ? '已完成' : total ? '进行中' : '草稿',
    translatorSlots, totalCapacity: Number(article.totalCapacity ?? total * translatorSlots),
    assignmentCount: Number(article.assignmentCount || 0), translationCount: Number(article.translationCount || 0),
    pendingTranslationCount: Number(article.pendingTranslationCount || 0), activeAssignments: Number(article.activeAssignments || 0),
    remainingSlots: Number(article.remainingSlots || 0), overCapacitySentenceCount: Number(article.overCapacitySentenceCount || 0),
    createdAt: article.createdAt || '', updatedAt: article.updatedAt || article.createdAt || '',
  }
}

function mapArticleDetail(result: any): ArticleDetail {
  if (!result.article?.id || !Array.isArray(result.sentences)) throw new Error('文章详情数据格式异常，请重新加载')
  return { article: mapArticle(result.article), sentences: result.sentences.map((sentence: any) => ({
    id: sentence.id, position: Number(sentence.position), sourceText: String(sentence.sourceText || ''),
    translatorSlots: Number(sentence.translatorSlots), assignmentCount: Number(sentence.assignmentCount || 0),
    translationCount: Number(sentence.translationCount || 0), pendingTranslationCount: Number(sentence.pendingTranslationCount || 0),
    activeAssignments: Number(sentence.activeAssignments || 0), remainingSlots: Number(sentence.remainingSlots || 0),
    acceptedCount: Number(sentence.acceptedCount || 0),
  })) }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  if (init?.signal?.aborted) controller.abort()
  else init?.signal?.addEventListener('abort', cancel, { once: true })
  const timeout = window.setTimeout(cancel, 30_000)
  try {
    const response = await fetch(apiUrl(path), {
      credentials: 'include', ...init, signal: controller.signal,
      headers: init?.body instanceof FormData ? { ...(init?.headers || {}) } : { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    })
    if (!response.ok) {
      const detail = await response.json().catch(() => null)
      throw Object.assign(new Error(typeof detail?.error === 'string' ? detail.error : `请求失败（${response.status}）`), { status: response.status })
    }
    return await response.json() as T
  } finally {
    window.clearTimeout(timeout)
    init?.signal?.removeEventListener('abort', cancel)
  }
}

export const api = {
  registrationConfig: async () => {
    const result = await request<{ mode?: string; fieldsRequired?: boolean }>('/api/auth/registration-config')
    if (!['open', 'standard'].includes(result.mode || '')) throw new Error('注册设置暂时无法确认，请重试')
    return { mode: result.mode as 'open' | 'standard', fieldsRequired: result.mode !== 'open' }
  },
  loginAdmin: async (key: string) => {
    if (isDemo) return { ok: true }
    return request<{ ok: boolean }>('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ key }) })
  },
  adminSession: async () => {
    if (isDemo) return true
    try { const result = await request<{ authenticated: boolean }>('/api/admin/auth/session'); return result.authenticated === true } catch { return false }
  },
  translatorSession: async (signal?: AbortSignal): Promise<{ authenticated: boolean; user?: RegisteredUser }> => {
    let result: { authenticated?: boolean; user?: RegisteredUser }
    try { result = await request<typeof result>('/api/auth/session', { signal }) }
    catch (error) { if ((error as { status?: number }).status === 401) return { authenticated: false }; throw error }
    if (typeof result.authenticated !== 'boolean' || (result.authenticated && !result.user?.id)) throw new Error('登录状态无法确认，请重新登录')
    return { authenticated: result.authenticated, user: result.user }
  },
  logout: async (role: 'translator' | 'admin' = 'translator') => {
    if (!isDemo) await request<{ ok: boolean }>(role === 'admin' ? '/api/admin/auth/logout' : '/api/auth/logout', { method: 'POST' })
    if (role === 'translator') { localStorage.removeItem('zk_registered'); localStorage.removeItem('zk_user') }
  },
  register: async (payload: RegisterPayload) => {
    const fallback = { user: { id: `local-${Date.now()}`, name: payload.realName, realName: payload.realName, phone: payload.phone, idNumber: payload.idNumber, bankCardNo: payload.bankCardNo, verificationStatus: 'pending' as const } }
    if (isDemo) return fallback
    const result = await request<{ user: RegisteredUser }>('/api/auth/register', { method: 'POST', body: JSON.stringify({ ...payload, name: payload.realName }) })
    if (!result.user?.id) throw new Error('未确认注册结果，请稍后重试')
    return result
  },
  getTasks: async (signal?: AbortSignal, explicitUserId?: string) => {
    const userId = explicitUserId || currentUserId()
    if (isDemo) return mockSegments.slice(0, 3)
    if (!userId) return []
    const result = await request<{ tasks?: any[] }>(`/api/users/${encodeURIComponent(userId)}/tasks`, { signal })
    if (!Array.isArray(result.tasks)) throw new Error('任务数据格式异常，请稍后重试')
    return result.tasks.map(mapTask)
  },
  submit: async (id: string, translation: string, expectedRevision?: number) => {
    const userId = currentUserId()
    if (isDemo) return { ok: true, revision: (expectedRevision || 0) + 1 }
    if (!userId || id.startsWith('seg-')) throw new Error('请先登录并领取任务')
    if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) throw new Error('请刷新后获取当前任务版本')
    const result = await request<{ translation?: { id: string; revision?: number; reviewStatus?: ReviewStatus; status?: string } }>(`/api/assignments/${encodeURIComponent(id)}/submit`, { method: 'POST', body: JSON.stringify({ userId, content: translation, ...(expectedRevision === undefined ? {} : { expectedRevision }) }) })
    if (!result.translation?.id) throw new Error('未确认提交结果，请刷新后重试')
    if (expectedRevision !== undefined && (Number(result.translation.revision) !== expectedRevision + 1 || reviewStatusOf(result.translation) !== 'pending')) throw new Error('未确认提交版本，请刷新后重试')
    return { ok: true, revision: Number(result.translation.revision) || (expectedRevision || 0) + 1 }
  },
  getArticles: async (signal?: AbortSignal) => {
    if (isDemo) return mockArticles
    const result = await request<{ articles?: any[] }>('/api/articles', { signal, headers: { 'X-Admin-Key': getAdminKey() } })
    if (!Array.isArray(result.articles)) throw new Error('文章数据格式异常，请稍后重试')
    return result.articles.map(mapArticle)
  },
  getArticle: async (id: string, signal?: AbortSignal): Promise<ArticleDetail> => {
    const result = await request<any>(`/api/articles/${encodeURIComponent(id)}`, { signal, headers: { 'X-Admin-Key': getAdminKey() } })
    return mapArticleDetail(result)
  },
  updateArticleConfig: async (id: string, translatorSlots: number): Promise<Article> => {
    if (!Number.isInteger(translatorSlots) || translatorSlots < 1 || translatorSlots > 20) throw new Error('每个任务单元的志愿者人数必须是 1–20 的整数')
    const result = await request<any>(`/api/admin/articles/${encodeURIComponent(id)}/config`, { method: 'PATCH', headers: { 'X-Admin-Key': getAdminKey() }, body: JSON.stringify({ translatorSlots }) })
    if (!result.article?.id || Number(result.article.translatorSlots) !== translatorSlots) throw new Error('未确认配置结果，请刷新详情后重试')
    return mapArticle(result.article)
  },
  requestTasks: async (count = 2) => {
    const userId = currentUserId()
    if (isDemo) return mockSegments.slice(0, count)
    if (!userId) throw new Error('请先完成实名注册')
    const result = await request<{ assignments?: any[] }>(`/api/assignments/request`, { method: 'POST', body: JSON.stringify({ userId, count }) })
    if (!Array.isArray(result.assignments)) throw new Error('任务数据格式异常，请稍后重试')
    return result.assignments.map(mapTask)
  },
  importArticle: async (payload: { title: string; targetLanguage: string; sourceLanguage?: string; taskUnit?: TaskUnit; translatorSlots?: number; file?: File | null }) => {
    const fallback = { id: `art-${Date.now()}`, title: payload.title, sourceLanguage: payload.sourceLanguage || '英语', targetLanguage: payload.targetLanguage, taskUnit: payload.taskUnit || 'sentence', segments: 0, done: 0, status: '草稿' as const, updatedAt: '刚刚' }
    const adminKey = getAdminKey()
    if (isDemo) return mapArticle({ ...fallback, translatorSlots: payload.translatorSlots })
    const form = new FormData()
    form.append('title', payload.title)
    form.append('sourceLanguage', payload.sourceLanguage || '英语')
    form.append('targetLanguage', payload.targetLanguage)
    form.append('taskUnit', payload.taskUnit || 'sentence')
    form.append('translatorSlots', String(payload.translatorSlots || 2))
    if (!payload.file) throw new Error('请选择要导入的文章文件')
    form.append('file', payload.file)
    const result = await request<any>('/api/admin/articles/import', { method: 'POST', headers: { 'X-Admin-Key': adminKey }, body: form })
    if (!result.article?.id) throw new Error('未确认导入结果，请刷新文章列表后重试')
    return mapArticle({ ...result.article, sentenceCount: result.sentenceCount })
  },
  getSegments: async (signal?: AbortSignal) => {
    const adminKey = getAdminKey()
    if (isDemo) return mockSegments
    const result = await request<{ translations?: any[] }>('/api/admin/translations?status=pending', { signal, headers: { 'X-Admin-Key': adminKey } })
    if (!Array.isArray(result.translations)) throw new Error('审核数据格式异常，请稍后重试')
    const grouped = new Map<string, Segment>()
    for (const item of result.translations || []) {
      const current: Segment = grouped.get(item.sentenceId) || {
        id: item.sentenceId,
        no: item.position || 1,
        source: item.sourceText || '',
        ...mapSuggestion(item),
        status: '待审核' as SegmentStatus,
        language: `${item.sourceLanguage || '原文'} → ${item.targetLanguage || '目标语种'}`,
        assignees: Number(item.translatorSlots || 1),
        completed: 0,
        submissions: [],
      }
      current.submissions!.push({ id: item.id, user: item.userName || '译者', avatar: (item.userName || '译').slice(0, 1), translation: item.content, score: 0, submittedAt: item.createdAt || '' })
      current.completed = current.submissions!.length
      grouped.set(item.sentenceId, current)
    }
    return [...grouped.values()]
  },
  getReviewSubmissions: async (signal?: AbortSignal): Promise<ReviewSubmission[]> => {
    const result = await request<{ translations?: any[] }>('/api/admin/translations', { signal, headers: { 'X-Admin-Key': getAdminKey() } })
    if (!Array.isArray(result.translations)) throw new Error('审核数据格式异常，请刷新后重试')
    return result.translations.map(mapReviewSubmission)
  },
  getRevisionHistory: async (kind: 'assignment' | 'translation', id: string, signal?: AbortSignal): Promise<RevisionRecord[]> => {
    const path = kind === 'assignment' ? `/api/assignments/${encodeURIComponent(id)}/history` : `/api/admin/translations/${encodeURIComponent(id)}/history`
    const result = await request<{ history?: any[] }>(path, { signal, headers: kind === 'translation' ? { 'X-Admin-Key': getAdminKey() } : {} })
    if (!Array.isArray(result.history)) throw new Error('修订记录格式异常，请重试')
    return result.history.map((row) => {
      const status = reviewStatusOf(row)
      if (!status || !Number.isInteger(Number(row.revision)) || Number(row.revision) < 1) throw new Error('修订记录格式异常，请重试')
      return { revision: Number(row.revision), content: row.content || '', reviewStatus: status, reviewNote: row.reviewNote || '', submittedAt: row.submittedAt || '', reviewedAt: row.reviewedAt || '' }
    }).sort((a, b) => b.revision - a.revision)
  },
  review: async (id: string, decision: 'accepted' | 'returned', expectedRevision: number, reviewNote = '') => {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('请刷新后获取最新译文版本')
    if (decision === 'returned' && !reviewNote.trim()) throw new Error('请填写退回原因')
    if (reviewNote.trim().length > 1000) throw new Error('审核意见不能超过 1000 字')
    const result = await request<{ translation?: any }>(`/api/admin/translations/${encodeURIComponent(id)}/review`, { method: 'POST', headers: { 'X-Admin-Key': getAdminKey() }, body: JSON.stringify({ decision, expectedRevision, reviewNote: reviewNote.trim() }) })
    if (result.translation?.id !== id || Number(result.translation.revision) !== expectedRevision || reviewStatusOf(result.translation) !== decision) throw new Error('未确认审核结果，请刷新后重试')
    return result.translation
  },
  getSummary: async (signal?: AbortSignal) => {
    const adminKey = getAdminKey()
    if (isDemo) return { sentenceCount: 90, pending: 12, translated: 128, accepted: 103, contributors: 36, accuracy: 92 }
    const result = await request<{ totals?: any; translators?: any[] }>('/api/admin/reports', { signal, headers: { 'X-Admin-Key': adminKey } })
    if (!result.totals || !Array.isArray(result.translators)) throw new Error('报表数据格式异常，请稍后重试')
    return { sentenceCount: Number(result.totals?.sentenceCount || 0), pending: Number(result.totals?.pendingTranslationCount || 0), translated: Number(result.totals?.translationCount || 0), accepted: Number(result.totals?.acceptedSentenceCount || 0), contributors: (result.translators || []).filter((item: any) => Number(item.submittedCount || 0) > 0).length, accuracy: result.totals?.translationCount ? Math.round((Number(result.totals.acceptedSentenceCount || 0) / Number(result.totals.translationCount)) * 100) : 0, topContributors: (result.translators || []).filter((item: any) => Number(item.submittedCount || 0) > 0).slice(0, 5).map((item: any) => ({ name: item.name || '译者', acceptedCount: Number(item.acceptedCount || 0), submittedCount: Number(item.submittedCount || 0) })) }
  },
  exportReport: async () => {
    const adminKey = getAdminKey()
    if (isDemo) throw new Error('请先进入管理员模式')
    const response = await fetch(apiUrl('/api/admin/reports/export.csv'), { credentials: 'include', headers: { 'X-Admin-Key': adminKey } })
    if (!response.ok) { const detail = await response.json().catch(() => null); throw new Error(detail?.error || `HTTP ${response.status}`) }
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `translation-report-${new Date().toISOString().slice(0, 10)}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  },
}
