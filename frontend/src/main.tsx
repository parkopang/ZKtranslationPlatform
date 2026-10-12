import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Activity, ArrowRight, BarChart3, BookOpen, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight,
  ClipboardCheck, Clock3, ExternalLink, FileText, Globe2, LayoutDashboard, Menu, MoreHorizontal, Plus,
  Search, Settings2, ShieldCheck, Sparkles, UploadCloud, Users, X,
} from 'lucide-react'
import { api, isDemo, mockArticles, mockSegments, setAdminKey, taskDraftKey, taskEditable, taskUnitLabel, type Article, type Segment, type TaskUnit } from './api'
import './styles.css'
import { Articles } from './Articles'
import { Review } from './Review'
import { timeLabel } from './review-format'
import { RevisionHistory } from './RevisionHistory'
import { TaskResults } from './TaskResults'
import { useLiveSync } from './useLiveSync'
import { workspaceEntry, workspaceRole, type WorkspaceChannel } from './workspace'

type Mode = 'translator' | 'admin'
type AdminSection = 'overview' | 'articles' | 'segments' | 'reports'
type ReportSummary = { sentenceCount: number; pending: number; translated: number; accepted: number; contributors: number; accuracy: number; topContributors?: Array<{ name: string; acceptedCount: number; submittedCount: number }> }

const todayLabel = new Intl.DateTimeFormat('zh-CN', { weekday: 'short', month: 'numeric', day: 'numeric' }).format(new Date()).replace('星期', '周')
const liveApi = !isDemo

function App() {
  const [mode, setMode] = useState<Mode>(() => workspaceRole(window.location.search, sessionStorage.getItem('zk_workspace'), window.location.pathname))
  const entry = workspaceEntry(window.location.search, window.location.pathname)
  const [adminSection, setAdminSection] = useState<AdminSection>('overview')
  const [tasks, setTasks] = useState<Segment[]>(isDemo ? mockSegments.slice(0, 3) : [])
  const [segments, setSegments] = useState<Segment[]>(isDemo ? mockSegments : [])
  const [articles, setArticles] = useState<Article[]>(isDemo ? mockArticles : [])
  const [toast, setToast] = useState('')
  const [loading, setLoading] = useState(true)
  const [identityVerified, setIdentityVerified] = useState(isDemo)
  const [loadError, setLoadError] = useState('')
  const [summary, setSummary] = useState<ReportSummary | null>(null)
  const [translatorSession, setTranslatorSession] = useState(0)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const identity = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    document.title = entry.isDoctor ? '医生端 · 译链' : '译链 · 众人共译平台'
  }, [entry.isDoctor])

  useEffect(() => {
    sessionStorage.setItem('zk_workspace', mode)
    const url = new URL(window.location.href); url.searchParams.set('workspace', mode); window.history.replaceState(null, '', url)
  }, [mode])

  const enterAdmin = async () => {
    if (isDemo) { setMode('admin'); return }
    if (await api.adminSession()) { setMode('admin'); return }
    const existing = sessionStorage.getItem('zk_admin_key') || ''
    const key = existing || window.prompt('请输入管理员密钥') || ''
    if (!key.trim()) { setToast('需要管理员密钥才能进入后台'); return }
    try {
      await api.loginAdmin(key.trim())
      setAdminKey('')
      setMode('admin')
    } catch (error) { setToast(error instanceof Error ? error.message : '管理员登录失败') }
  }

  const taskSync = useLiveSync(mode === 'translator' && !isDemo, async ({ signal, isCurrent }) => {
    try {
      const session = await api.translatorSession(signal)
      if (!isCurrent()) return
      const user = session.authenticated ? session.user! : null
      const previousUser = identity.current
      setIdentityVerified(Boolean(user))
      if (user) {
        localStorage.setItem('zk_registered', '1')
        localStorage.setItem('zk_user', JSON.stringify({ id: user.id, name: user.name, realName: user.realName }))
      } else { localStorage.removeItem('zk_registered'); localStorage.removeItem('zk_user') }
      if (identity.current !== (user?.id || null)) {
        identity.current = user?.id || null
        setTasks([]); setDrafts({}); setSelectedTaskId(null); setTranslatorSession((value) => value + 1)
      }
      if (!user) { setLoading(false); if (previousUser) setLoadError('志愿者登录已失效，请重新注册或登录后继续使用。'); return }
      const items = await api.getTasks(signal, user.id)
      if (isCurrent() && identity.current === user.id) { setTasks(items); setLoadError('') }
    } catch (error) {
      if (isCurrent()) setLoadError(error instanceof Error ? `任务同步失败：${error.message}。将自动重试，草稿已保留。` : '任务同步暂时失败，将自动重试。')
    } finally { if (isCurrent()) setLoading(false) }
  }, mode)

  const adminSync = useLiveSync(mode === 'admin' && !isDemo, async ({ signal, isCurrent }) => {
    try {
      const results = await Promise.allSettled([api.getArticles(signal), api.getSummary(signal), api.getSegments(signal)])
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      const [items, report, pending] = results.map((result) => result.status === 'fulfilled' ? result.value : null) as [Article[], ReportSummary, Segment[]]
      if (isCurrent()) { setArticles(items); setSummary(report as ReportSummary); setSegments(pending); setLoadError('') }
    } catch (error) { if (isCurrent()) setLoadError(error instanceof Error ? `后台同步失败：${error.message}。将自动重试。` : '后台数据同步失败，将自动重试。') }
  }, mode)

  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key !== 'zk_user' && event.key !== 'zk_registered') return
      let storedId: string | null = null
      try { storedId = JSON.parse(localStorage.getItem('zk_user') || 'null')?.id || null } catch { /* The session API repairs malformed local state. */ }
      if (storedId !== identity.current) { setIdentityVerified(false); setTasks([]); setDrafts({}); setSelectedTaskId(null); setLoading(true) }
      taskSync.refresh()
    }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  })

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2600)
    return () => window.clearTimeout(timer)
  }, [toast])

  const submit = async (id: string, text: string, expectedRevision: number) => {
    let result: { revision: number }
    taskSync.pause()
    try { result = await api.submit(id, text, expectedRevision) }
    catch (error) { taskSync.resume(); throw error }
    setTasks((items) => items.map((task) => task.id === id ? { ...task, status: '待审核', reviewStatus: 'pending', reviewNote: '', reviewedAt: '', revision: result.revision, completed: 1, submittedContent: text } : task))
    taskSync.resume()
    setToast('已提交，感谢你的贡献！')
  }

  const claimTasks = async () => {
    taskSync.pause()
    try {
      const items = await api.requestTasks(2)
      if (items.length) setTasks((current) => [...items, ...current.filter((task) => !items.some((item) => item.id === task.id))])
      else setToast('暂无可领取任务，请稍后再试')
      return items
    } finally { taskSync.resume() }
  }

  const reviewChanged = () => adminSync.refresh()
  const articleUpdated = (article: Article) => { adminSync.invalidate(); setArticles((items) => items.map((item) => item.id === article.id ? article : item)); adminSync.refresh() }

  const importArticle = async (title: string, targetLanguage: string, sourceLanguage = '英语', taskUnit: TaskUnit = 'sentence', slots = 2, file: File | null = null) => {
    const article = await api.importArticle({ title, targetLanguage, sourceLanguage, taskUnit, translatorSlots: slots, file })
    adminSync.invalidate()
    setArticles((items) => [article, ...items])
    adminSync.refresh()
    setToast(`文章已导入并按${taskUnitLabel(taskUnit)}拆分，可开始协作翻译`)
  }

  const exportReport = async () => {
    try { await api.exportReport(); setToast('报表已下载') } catch (error) { setToast(error instanceof Error ? error.message : '报表下载失败') }
  }

  const logout = async () => {
    taskSync.pause()
    try {
      await api.logout()
      setMode('translator')
      setTasks(isDemo ? mockSegments.slice(0, 3) : [])
      setIdentityVerified(isDemo)
      setSelectedTaskId(null)
      setDrafts({})
      setTranslatorSession((value) => value + 1)
      setToast('已退出登录')
    } catch (error) { setToast(error instanceof Error ? error.message : '退出失败') }
    finally { taskSync.resume() }
  }

  return (
    <div className="app-root">
      {mode === 'translator' ? (
        <TranslatorView key={translatorSession} authenticated={identityVerified} tasks={identityVerified ? tasks : []} drafts={identityVerified ? drafts : {}} onDraft={(id, text) => setDrafts((current) => ({ ...current, [id]: text }))} selectedTaskId={selectedTaskId} onSelect={setSelectedTaskId} onSubmit={submit} onClaim={claimTasks} onRegistrationStart={() => taskSync.pause()} onRegistrationEnd={() => taskSync.resume()} onRegistered={() => taskSync.refresh()} onSwitch={() => void enterAdmin()} onLogout={() => void logout()} loading={loading} isDoctor={entry.isDoctor} channel={entry.channel} />
      ) : (
        <AdminView section={adminSection} setSection={setAdminSection} segments={segments} articles={articles} summary={summary} onRefreshArticles={() => adminSync.refresh()} onArticleUpdated={articleUpdated} onReviewChanged={reviewChanged} onImport={importArticle} onExport={exportReport} onSwitch={() => { setIdentityVerified(isDemo); setLoading(!isDemo); setMode('translator') }} />
      )}
      {loadError && <div className="error-banner" role="status">{loadError}</div>}
      {toast && <div className="toast" role="status"><CheckCircle2 size={17} />{toast}</div>}
    </div>
  )
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? 'brand-compact' : ''}`}><span className="brand-mark"><Globe2 size={20} strokeWidth={2.4} /></span><span><b>译链</b>{!compact && <small>众人共译平台</small>}</span></div>
}

function TranslatorView({ authenticated, tasks, drafts, onDraft, selectedTaskId, onSelect, onSubmit, onClaim, onRegistered, onRegistrationStart, onRegistrationEnd, onSwitch, onLogout, loading, isDoctor, channel }: { authenticated: boolean; tasks: Segment[]; drafts: Record<string, string>; onDraft: (key: string, text: string) => void; selectedTaskId: string | null; onSelect: (id: string) => void; onSubmit: (id: string, text: string, expectedRevision: number) => Promise<void>; onClaim: () => Promise<Segment[]>; onRegistered: () => void; onRegistrationStart: () => void; onRegistrationEnd: () => void; onSwitch: () => void; onLogout: () => void; loading: boolean; isDoctor: boolean; channel: WorkspaceChannel }) {
  const [view, setView] = useState<'work' | 'results'>('work')
  const [showProfile, setShowProfile] = useState(false)
  const [registered, setRegistered] = useState(() => localStorage.getItem('zk_registered') === '1')
  const [showRegister, setShowRegister] = useState(false)
  const [registrationMode, setRegistrationMode] = useState<'open' | 'standard' | null>(null)
  const [registrationAttempt, setRegistrationAttempt] = useState(0)
  const [registrationConfigError, setRegistrationConfigError] = useState('')
  const [claiming, setClaiming] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [taskError, setTaskError] = useState('')
  const [phone, setPhone] = useState('')
  const [realName, setRealName] = useState('')
  const [idNumber, setIdNumber] = useState('')
  const [bankCardNo, setBankCardNo] = useState('')
  const [registerError, setRegisterError] = useState('')
  const actionInFlight = useRef(false)
  const task: Segment = tasks.find((item) => item.id === selectedTaskId) || { id: 'empty', no: 0, source: '', ai: '', aiStatus: 'idle', status: '待翻译', language: '', assignees: 0, completed: 0 }
  const draftKey = taskDraftKey(task)
  const text = drafts[draftKey] ?? task.submittedContent ?? ''
  const olderDrafts = Object.entries(drafts).filter(([key, value]) => key.startsWith(`${task.id}:`) && key !== draftKey && value.trim() && value !== task.submittedContent)
  const submitted = task.completed > 0
  const returned = task.reviewStatus === 'returned' && !task.closed
  const editable = taskEditable(task)
  const closed = !!task.closed
  const storedUser = (() => { try { return JSON.parse(localStorage.getItem('zk_user') || 'null') as { realName?: string; name?: string } | null } catch { return null } })()
  const displayName = liveApi ? storedUser?.realName || storedUser?.name || (isDoctor ? '医生' : '译者') : (isDoctor ? '医生协作者' : '林晓雯')
  const completedToday = liveApi ? tasks.filter((item) => item.status === '已采纳' || item.completed > 0).length : 6
  const taskGoal = liveApi ? tasks.length : 8
  const progressPercent = taskGoal ? Math.min(100, Math.round((completedToday / taskGoal) * 100)) : 0
  const pendingTasks = tasks.filter(taskEditable)
  const firstSubmissionCount = pendingTasks.filter((item) => item.completed === 0).length
  const revisionCount = pendingTasks.filter((item) => item.reviewStatus === 'returned').length
  const progressUnit = taskUnitLabel(task.taskUnit)
  const pendingWorkLabel = [firstSubmissionCount ? `${firstSubmissionCount} 个${progressUnit}待首次提交` : '', revisionCount ? `${revisionCount} 个${progressUnit}待重译` : ''].filter(Boolean).join(' · ')

  useEffect(() => {
    if (!loading && !registered && new URLSearchParams(window.location.search).get('register') === '1') setShowRegister(true)
  }, [loading, registered])
  useEffect(() => {
    if (!showRegister) return
    let active = true
    setRegistrationConfigError('')
    void api.registrationConfig().then((config) => { if (active) setRegistrationMode(config.mode) }).catch((error) => { if (active) setRegistrationConfigError(error instanceof Error ? error.message : '注册设置加载失败') })
    return () => { active = false }
  }, [showRegister, registrationAttempt])

  useEffect(() => {
    if (!selectedTaskId && tasks.length) onSelect((tasks.find((item) => item.reviewStatus === 'returned' && !item.closed) || tasks.find(taskEditable) || tasks[0]).id)
  }, [tasks, selectedTaskId, onSelect])

  const claimTask = async () => {
    if (!registered) { setShowRegister(true); return }
    if (actionInFlight.current) return
    actionInFlight.current = true
    setClaiming(true)
    setTaskError('')
    try {
      const claimed = await onClaim()
      if (claimed.length && (task.id === 'empty' || submitted || closed)) onSelect(claimed[0].id)
    } catch (error) { setTaskError(error instanceof Error ? error.message : '领取失败，请稍后重试') }
    finally { actionInFlight.current = false; setClaiming(false) }
  }

  const submitTask = async () => {
    if (!registered) { setShowRegister(true); return }
    if (actionInFlight.current || !editable || task.id === 'empty' || !text.trim()) return
    actionInFlight.current = true
    setSubmitting(true)
    setTaskError('')
    try { await onSubmit(task.id, text.trim(), task.revision || 0) }
    catch (error) { setTaskError(error instanceof Error ? error.message : '提交失败，草稿已保留，请稍后重试') }
    finally { actionInFlight.current = false; setSubmitting(false) }
  }

  const completeRegister = async () => {
    if (actionInFlight.current) return
    if (!registrationMode || registrationConfigError) { setRegisterError('请先确认注册设置后重试'); return }
    if (registrationMode === 'standard' && (!realName.trim() || !phone.trim() || !idNumber.trim() || !bankCardNo.trim())) { setRegisterError('请完整填写姓名、手机号、身份证号和银行卡号'); return }
    actionInFlight.current = true
    setRegistering(true)
    onRegistrationStart()
    setRegisterError('')
    try {
      const result = await api.register({ realName: realName.trim(), phone: phone.trim(), idNumber: idNumber.trim(), bankCardNo: bankCardNo.trim() })
      localStorage.setItem('zk_registered', '1')
      localStorage.setItem('zk_user', JSON.stringify({ id: result.user.id, realName: result.user.realName, name: result.user.name }))
      setRegistered(true)
      setShowRegister(false)
      const url = new URL(window.location.href); url.searchParams.delete('register'); window.history.replaceState(null, '', url)
      setPhone(''); setIdNumber(''); setBankCardNo('')
      onRegistered()
    } catch (error) { setRegisterError(error instanceof Error ? error.message : '注册失败，请稍后重试') }
    finally { actionInFlight.current = false; setRegistering(false); onRegistrationEnd() }
  }
  return <div className="translator-page">
    <div className="mobile-topbar">
      <Brand compact />
      <div className="top-actions">
        {isDoctor && <span className="wechat-entry-chip" title={channel === 'wechat-mini-program' ? '微信小程序入口' : channel === 'wechat-public-account' ? '微信公众号入口' : '医生端网页入口'}><ExternalLink size={13} />医生端</span>}
        <button className="icon-button subtle" onClick={() => setShowProfile((v) => !v)} aria-label="个人中心"><span className="avatar avatar-small">{displayName.slice(0, 1)}</span></button>
        <button className="icon-button subtle" onClick={onSwitch} aria-label="切换后台"><Settings2 size={19} /></button>
      </div>
      {showProfile && <div className="profile-popover"><strong>{displayName}</strong><span>{liveApi ? '累计已提交' : '今日已完成'} {completedToday} 个任务</span><button onClick={onLogout}>退出登录</button></div>}
    </div>
    <main className="translator-content">
      <div className="translator-view-tabs" aria-label="我的工作区"><button className={view === 'work' ? 'active' : ''} aria-pressed={view === 'work'} onClick={() => setView('work')}>翻译任务</button><button className={view === 'results' ? 'active' : ''} aria-pressed={view === 'results'} onClick={() => setView('results')}>我的数据与审核结果{tasks.some((item) => item.reviewStatus === 'returned' && !item.closed) && <i />}</button></div>
      {view === 'results' ? <TaskResults tasks={tasks} onOpen={(id) => { onSelect(id); setView('work'); setTaskError('') }} /> : <>
      <div className="welcome-line"><div><p className="eyebrow">{isDoctor ? '医生协作入口 · ' : ''}{todayLabel}</p><h1>{isDoctor ? '欢迎进入医生端' : `早上好，${displayName}`} <span>👋</span></h1>{isDoctor && <p className="entry-description">从微信菜单进入，登录后即可领取分配给你的翻译任务。</p>}</div><div className="streak"><span>✦</span><b>{liveApi ? '我的任务' : '连续 7 天'}</b><small>{liveApi ? `${completedToday} 个任务已提交` : '+12 积分'}</small></div></div>
      <section className="progress-card">
        <div className="progress-heading"><div><span className="overline">{liveApi ? '按任务去重统计' : '今日任务'}</span><strong>累计提交</strong></div><b>{completedToday} <i>/ {taskGoal} 个任务</i></b></div>
        <div className="progress-track"><span style={{ width: `${progressPercent}%` }} /></div>
        <div className="progress-foot"><span>提交覆盖 {progressPercent}%</span><span>{liveApi ? (pendingWorkLabel || (taskGoal ? '当前无待处理任务' : '领取任务后开始翻译')) : '再完成 2 个任务解锁今日徽章'}</span></div>
      </section>

      <div className="section-title-row"><div><span className="overline">当前任务</span><h2>{task.articleTitle || '众人共译任务'}</h2></div><button className="task-badge claim-button" onClick={() => void claimTask()} disabled={loading || claiming || submitting || pendingTasks.length > 0}><Clock3 size={14} />{claiming ? '领取中…' : loading ? '加载中…' : pendingTasks.length ? `${pendingTasks.length} 个${progressUnit}待完成` : '随机领取 1-2 个任务'}</button></div>
      {tasks.length > 1 && <div className="task-selector"><label htmlFor="current-task">选择任务</label><select id="current-task" value={selectedTaskId || ''} disabled={submitting || claiming} onChange={(event) => { onSelect(event.target.value); setTaskError('') }}>{!tasks.some((item) => item.id === selectedTaskId) && <option value="">请选择任务</option>}{tasks.map((item) => <option key={item.id} value={item.id}>{item.articleTitle || '翻译任务'} · 第 {item.no} {taskUnitLabel(item.taskUnit)} · {item.status}{item.revision ? ` · V${item.revision}` : ''}</option>)}</select></div>}
      {taskError && <p className="form-error" role="alert">{taskError}</p>}
      <section className={`translation-card ${task.id === 'empty' ? 'empty-task-card' : ''}`}>
        <div className="translation-card-top"><span className="segment-number">{taskUnitLabel(task.taskUnit)} {String(task.no).padStart(2, '0')}</span><button className="more-button"><MoreHorizontal size={20} /></button></div>
        {task.id === 'empty' ? <div className="empty-state"><ClipboardCheck size={28} /><strong>{selectedTaskId ? '当前任务已不可用' : '尚未领取任务'}</strong><span>{selectedTaskId ? '请选择其他任务。已有草稿会保留到退出登录。' : authenticated ? '可以主动领取 1～2 个任务，也可以等待管理员分配。' : '注册志愿者后点击上方按钮领取 1～2 个任务。'}</span></div> : <>
        <p className="source-text">{task.source}</p>
        <div className="task-review-state"><span className={`task-state-label ${task.reviewStatus || 'unsubmitted'}`}>{task.status}</span><span>{task.revision ? `V${task.revision}` : '尚未提交'}{task.reviewedAt ? ` · 审核 ${timeLabel(task.reviewedAt)}` : ''}</span></div>
        {task.reviewNote && <div className="task-review-note"><strong>{returned ? '退回原因，请修改后重新提交' : '审核说明'}</strong><p>{task.reviewNote}</p></div>}
        <>{closed ? <div className="task-closed-notice" role="status"><CheckCircle2 size={19} /><div><strong>{task.status === '已采纳' ? '你的译文已被采纳' : task.reviewStatus === 'not_selected' ? `本次译文未被采纳，该${taskUnitLabel(task.taskUnit)}已完成` : `本${taskUnitLabel(task.taskUnit)}已有采纳译文，任务已结束`}</strong><p>{submitted ? '你的提交记录已保留，可以继续领取其他任务。' : '无需再提交。未提交草稿仅保留在当前页面，可以继续领取其他任务。'}</p>{text && <div className="closed-task-content"><span>{submitted ? '你的译文' : '未提交草稿'}</span><p>{text}</p></div>}</div></div> : <><div className="ai-label"><Sparkles size={14} />AI 预翻译 <span>供人工翻译参考</span></div>
        <AiSuggestion task={task} />
        <div className="language-control"><label>翻译为</label><span className="language-select">{task.targetLanguage || task.language.split(' → ').pop() || '管理员指定语种'}</span></div>
        <button className="outline-button apply-suggestion" disabled={!editable || submitting || task.aiStatus !== 'succeeded' || !task.ai.trim()} onClick={() => onDraft(draftKey, task.ai)}>{text.trim() ? '用 AI 译文替换草稿' : '采用 AI 译文'}</button>
        <textarea className="translation-input" aria-label="你的译文" value={text} maxLength={10000} onChange={(event) => onDraft(draftKey, event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void submitTask() } }} placeholder="输入你的译文，AI 暂不可用时也可直接提交…" disabled={!editable || submitting} />
        <div className="input-meta"><span>{text.length} / 10000</span><span>Ctrl / ⌘ + Enter 提交</span></div>
        <button className={`submit-button ${submitted && !returned ? 'submitted' : ''}`} onClick={() => void submitTask()} disabled={!editable || submitting || !text.trim()}>{submitting ? '提交中…' : returned ? <>修改后重新提交 <ArrowRight size={18} /></> : submitted ? <><CheckCircle2 size={18} />已提交，等待审核</> : <>提交译文 <ArrowRight size={18} /></>}</button>{returned && <p className="task-resubmit-note">重新提交将生成 V{(task.revision || 1) + 1}，继续使用当前任务，不重复计入贡献任务数。</p>}</>}</></>}
      </section>
      {task.id !== 'empty' && task.completed > 0 && <RevisionHistory key={`${task.id}:${task.revision}:${task.reviewStatus}`} kind="assignment" id={task.id} />}
      {olderDrafts.length > 0 && <details className="task-version-drafts"><summary>已保留其他版本的本页草稿（{olderDrafts.length} 份）</summary>{olderDrafts.map(([key, content]) => <article key={key}><strong>基于 V{key.split(':').pop()} 的草稿</strong><p>{content}</p>{editable && <button className="text-button" disabled={submitting} onClick={() => onDraft(draftKey, content)}>使用这份草稿</button>}</article>)}</details>}
      <div className="tip-card"><span className="tip-icon">✦</span><div><strong>小提示</strong><p>保持语义准确、表达自然，术语可参考 AI 预翻译。</p></div><button><X size={16} /></button></div>
      <div className="translator-footer"><ShieldCheck size={14} />你的翻译将由管理员审核后采纳</div>
      </>}
    </main>
    <nav className="bottom-nav"><button className={view === 'work' ? 'active' : ''} onClick={() => setView('work')}><ClipboardCheck size={20} /><span>翻译任务</span></button><button className={view === 'results' ? 'active' : ''} onClick={() => setView('results')}><BarChart3 size={20} /><span>我的数据</span></button></nav>
    {!registered && <div className="register-banner"><span>{isDoctor ? '注册医生协作者后可领取翻译任务' : '注册志愿者后可领取翻译任务'}</span><button onClick={() => setShowRegister(true)}>立即注册</button></div>}
    {showRegister && <div className="modal-backdrop"><div className="modal register-modal"><div className="modal-head"><div><h3>{isDoctor ? '注册医生协作者' : '注册志愿者'}</h3><p>{registrationMode === 'open' ? '填写参与资料即可注册，也可以稍后完善。' : '参与资料用于资格核验与后续结算，请完整填写。'}</p></div><button disabled={registering} onClick={() => setShowRegister(false)}><X size={19} /></button></div><div className="form-field"><label>姓名{registrationMode === 'open' && '（可选）'}</label><input value={realName} onChange={(e) => setRealName(e.target.value)} placeholder="请输入姓名" /></div><div className="form-field"><label>手机号{registrationMode === 'open' && '（可选）'}</label><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="请输入手机号" inputMode={registrationMode === 'open' ? 'text' : 'tel'} /></div><div className="form-field"><label>身份证号{registrationMode === 'open' && '（可选）'}</label><input value={idNumber} onChange={(e) => setIdNumber(e.target.value)} placeholder="请输入身份证号" /></div><div className="form-field"><label>银行卡号{registrationMode === 'open' && '（可选）'}</label><input value={bankCardNo} onChange={(e) => setBankCardNo(e.target.value)} placeholder="请输入收款银行卡号" inputMode={registrationMode === 'open' ? 'text' : 'numeric'} /></div>{registrationConfigError && <p className="form-error" role="alert">{registrationConfigError}<button className="text-button" onClick={() => setRegistrationAttempt((value) => value + 1)}>重新加载</button></p>}{registerError && <p className="form-error">{registerError}</p>}<div className="modal-actions"><button className="outline-button" disabled={registering} onClick={() => setShowRegister(false)}>取消</button><button className="primary-button" disabled={registering || !registrationMode || !!registrationConfigError} onClick={() => void completeRegister()}>{registering ? '注册中…' : '完成注册'}</button></div></div></div>}
  </div>
}

function AiSuggestion({ task }: { task: Segment }) {
  let message = 'AI 预译尚未开始，可以先人工翻译。'
  if (task.aiStatus === 'queued') message = 'AI 预译已排队，可以先人工翻译。'
  if (task.aiStatus === 'running') message = 'AI 正在生成预译，可以先人工翻译。'
  if (task.aiStatus === 'retrying') {
    const retryTime = task.aiRetryAt ? new Date(task.aiRetryAt).toLocaleTimeString('zh-CN', { hour12: false }) : ''
    message = `模型服务繁忙，系统将自动重试${retryTime ? `（预计 ${retryTime}）` : ''}。可以先人工翻译。`
  }
  if (task.aiStatus === 'failed') message = task.aiError || 'AI 预译暂不可用，请继续人工翻译。'
  if (task.aiStatus === 'succeeded') message = task.ai || 'AI 未返回有效译文，请继续人工翻译。'
  return <p className={`ai-text ${task.aiStatus === 'failed' ? 'ai-error' : ''}`} role="status" aria-live="polite">{message}</p>
}

function AdminView({ section, setSection, segments, articles, summary, onRefreshArticles, onArticleUpdated, onReviewChanged, onImport, onExport, onSwitch }: { section: AdminSection; setSection: (value: AdminSection) => void; segments: Segment[]; articles: Article[]; summary: ReportSummary | null; onRefreshArticles: () => void; onArticleUpdated: (article: Article) => void; onReviewChanged: () => void; onImport: (title: string, language: string, sourceLanguage?: string, taskUnit?: TaskUnit, slots?: number, file?: File | null) => Promise<void>; onExport: () => Promise<void>; onSwitch: () => void }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const pendingCount = summary?.pending ?? segments.reduce((sum, item) => sum + (item.submissions?.length || 0), 0)
  const navItems: { id: AdminSection; label: string; icon: typeof LayoutDashboard; count?: string }[] = [
    { id: 'overview', label: '工作台', icon: LayoutDashboard },
    { id: 'articles', label: '文章管理', icon: BookOpen, count: articles.length ? String(articles.length) : undefined },
    { id: 'segments', label: '翻译审核', icon: ClipboardCheck, count: pendingCount ? String(pendingCount) : undefined },
    { id: 'reports', label: '数据报表', icon: BarChart3 },
  ]
  return <div className="admin-layout">
    <aside className={`admin-sidebar ${sidebarOpen ? 'open' : ''}`}>
      <div className="sidebar-head"><Brand /><button className="mobile-close" onClick={() => setSidebarOpen(false)}><X size={18} /></button></div>
      <div className="workspace-switch"><span className="workspace-dot">ZK</span><span><b>中康翻译工作室</b><small>管理空间</small></span><ChevronDown size={15} /></div>
      <nav className="admin-nav">{navItems.map((item) => { const Icon = item.icon; return <button key={item.id} className={section === item.id ? 'active' : ''} onClick={() => { setSection(item.id); setSidebarOpen(false) }}><Icon size={18} /><span>{item.label}</span>{item.count && <em>{item.count}</em>}</button> })}</nav>
      <div className="sidebar-bottom"><button><Settings2 size={18} />系统设置</button><div className="admin-user"><span className="avatar">管</span><span><b>管理员</b><small>admin@zhongkang.cn</small></span><MoreHorizontal size={17} /></div></div>
    </aside>
    {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
    <section className="admin-main">
      <header className="admin-topbar"><button className="mobile-menu" onClick={() => setSidebarOpen(true)}><Menu size={21} /></button><div className="breadcrumbs"><span>中康翻译工作室</span><ChevronRight /><b>{navItems.find((item) => item.id === section)?.label}</b></div><div className="topbar-right"><div className="search-box"><Search size={16} /><input placeholder="搜索文章、译者…" /></div><button className="icon-button notification"><Activity size={18} /><i /></button><button className="switch-link" onClick={onSwitch}>切换译者端 <ArrowRight size={15} /></button></div></header>
      {section === 'overview' && <Overview articles={articles} segments={segments} summary={summary} onNavigate={setSection} />}
      {section === 'articles' && <Articles articles={articles} onImport={onImport} onRefresh={onRefreshArticles} onArticleUpdated={onArticleUpdated} />}
      {section === 'segments' && <Review onChanged={onReviewChanged} />}
      {section === 'reports' && <Reports articles={articles} segments={segments} summary={summary} onExport={onExport} />}
    </section>
  </div>
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: React.ReactNode }) {
  return <div className="page-header"><div>{eyebrow && <span className="overline">{eyebrow}</span>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>
}

function Overview({ articles, segments, summary, onNavigate }: { articles: Article[]; segments: Segment[]; summary: ReportSummary | null; onNavigate: (section: AdminSection) => void }) {
  const pending = segments.filter((item) => item.status === '待审核').length
  const total = summary?.sentenceCount ?? articles.reduce((sum, item) => sum + item.segments, 0)
  const translated = summary?.translated ?? (isDemo ? segments.filter((item) => item.completed > 0).length : null)
  const contributors = summary?.contributors ?? null
  const accuracy = summary?.accuracy ?? null
  return <div className="admin-content"><PageHeader eyebrow={`总览 / ${todayLabel}`} title="工作台" description="欢迎回来，管理员。这里是团队翻译项目的最新进展。" action={<button className="primary-button" onClick={() => onNavigate('articles')}><Plus size={17} />导入文章</button>} />
    <div className="stats-grid"><StatCard label="累计翻译任务数" value={translated === null ? '—' : String(translated)} trend="已提交译文" icon={<FileText />} tone="blue" /><StatCard label="待审核译文" value={summary ? String(summary.pending) : isDemo ? String(pending) : '—'} trend="需要你的关注" icon={<ClipboardCheck />} tone="orange" /><StatCard label="活跃贡献者" value={contributors === null ? '—' : String(contributors)} trend="已提交译文的译者" icon={<Users />} tone="purple" /><StatCard label="平均采纳率" value={accuracy === null ? '—' : `${accuracy}%`} trend="已采纳任务单元 / 已提交译文" icon={<CheckCircle2 />} tone="green" /></div>
    <div className="dashboard-grid"><section className="panel chart-panel"><div className="panel-header"><div><h3>翻译进度</h3><p>近 7 天团队完成情况</p></div><button className="select-button">近 7 天 <ChevronDown size={15} /></button></div><div className="chart"><div className="chart-y"><span>40</span><span>30</span><span>20</span><span>10</span><span>0</span></div><div className="chart-body"><div className="grid-line" /><div className="grid-line" /><div className="grid-line" /><div className="grid-line" /><div className="bars">{(liveApi ? [] : [['周一', 38], ['周二', 52], ['周三', 42], ['周四', 68], ['周五', 58], ['周六', 82], ['周日', 72]]).map(([day, value]) => <div className="bar-col" key={day as string}><div className="bar" style={{ height: `${(value as number) * 0.92}%` }}><span>{Math.round((value as number) * .48)}</span></div><small>{day}</small></div>)}</div>{liveApi && <div className="empty-state">暂未提供按日趋势，请查看上方累计统计</div>}</div></div></section><section className="panel activity-panel"><div className="panel-header"><div><h3>最近动态</h3><p>团队最新操作</p></div></div>{liveApi ? <div className="empty-state">最近动态暂未提供</div> : <div className="activity-list"><ActivityItem color="green" title="林晓雯提交了 3 个译文" meta="Digital Health · 2 分钟前" /><ActivityItem color="blue" title="王思远加入了翻译任务" meta="Global Oncology · 18 分钟前" /><ActivityItem color="orange" title="需要审核 12 个译文" meta="Digital Health · 1 小时前" /></div>}</section></div>
    <section className="panel table-panel"><div className="panel-header"><div><h3>进行中的文章</h3><p>共 {articles.filter((a) => a.status === '进行中').length} 篇文章正在协作</p></div><button className="text-button" onClick={() => onNavigate('articles')}>管理文章 <ArrowRight size={14} /></button></div><ArticleTable articles={articles.slice(0, 3)} /></section>
  </div>
}

function StatCard({ label, value, trend, icon, tone }: { label: string; value: string; trend: string; icon: React.ReactNode; tone: string }) { return <div className="stat-card"><div className={`stat-icon ${tone}`}>{icon}</div><span>{label}</span><strong>{value}</strong><small className={tone === 'orange' ? 'warn' : ''}>{trend}</small></div> }
function ActivityItem({ color, title, meta }: { color: string; title: string; meta: string }) { return <div className="activity-item"><span className={`activity-dot ${color}`} /><div><strong>{title}</strong><small>{meta}</small></div><MoreHorizontal size={16} /></div> }

function ArticleTable({ articles, showActions = false }: { articles: Article[]; showActions?: boolean }) { return <div className="table-wrap"><table><thead><tr><th>文章</th><th>语种</th><th>任务单元进度</th><th>状态</th><th>最近更新</th>{showActions && <th />}</tr></thead><tbody>{articles.map((article) => <tr key={article.id}><td><div className="article-cell"><span className="file-icon"><FileText size={17} /></span><div><strong>{article.title}</strong><small>{article.id.toUpperCase()}</small></div></div></td><td><span className="language-pill">{article.sourceLanguage} <ArrowRight size={12} /> {article.targetLanguage}</span></td><td><div className="table-progress"><div><span>{article.done}</span> / {article.segments || '待解析'} {taskUnitLabel(article.taskUnit)}</div><div className="mini-progress"><span style={{ width: `${article.segments ? (article.done / article.segments) * 100 : 0}%` }} /></div></div></td><td><span className={`status-pill ${article.status === '进行中' ? 'progress' : article.status === '已完成' ? 'done' : 'draft'}`}><i />{article.status}</span></td><td className="muted-cell">{article.updatedAt}</td>{showActions && <td><button className="more-button"><MoreHorizontal size={18} /></button></td>}</tr>)}</tbody></table></div> }

function Reports({ articles, segments, summary, onExport }: { articles: Article[]; segments: Segment[]; summary: ReportSummary | null; onExport: () => Promise<void> }) {
  const total = summary?.sentenceCount ?? articles.reduce((sum, item) => sum + item.segments, 0)
  const report: ReportSummary | null = summary || (isDemo ? { sentenceCount: 90, pending: 12, translated: 128, accepted: 103, contributors: 36, accuracy: 92 } : null)
  const contributors = report?.topContributors || []
  return <div className="admin-content"><PageHeader eyebrow="数据中心" title="数据报表" description="查看项目进度、贡献者活跃度与译文采纳情况。" action={<button className="outline-button" onClick={() => void onExport()}><FileText size={16} />导出报表</button>} /><div className="stats-grid report-stats"><StatCard label="总句段数" value={String(total || 0)} trend="当前文章总量" icon={<FileText />} tone="blue" /><StatCard label="已提交" value={report ? String(report.translated) : '—'} trend="同一句可有多人提交" icon={<CheckCircle2 />} tone="green" /><StatCard label="参与人数" value={report ? String(report.contributors) : '—'} trend="已提交译文的译者" icon={<Users />} tone="purple" /><StatCard label="译文采纳率" value={report ? `${report.accuracy}%` : '—'} trend="已采纳句段 / 已提交译文" icon={<Sparkles />} tone="orange" /></div><div className="report-grid"><section className="panel chart-panel large"><div className="panel-header"><div><h3>每日翻译量</h3><p>过去 30 天句段提交趋势</p></div><button className="select-button">近 30 天 <ChevronDown size={15} /></button></div>{isDemo ? <div className="area-chart"><div className="area-fill" /><svg viewBox="0 0 700 180" preserveAspectRatio="none"><path d="M0,156 C35,145 62,158 95,131 S151,141 183,108 S238,117 275,102 S327,133 362,86 S418,93 452,72 S502,95 530,49 S585,82 616,40 S660,62 700,20" /></svg><div className="area-labels"><span>9/1</span><span>9/8</span><span>9/15</span><span>9/22</span><span>9/30</span></div></div> : <div className="empty-state">暂未提供按日趋势，请查看累计统计或导出报表。</div>}</section><section className="panel quality-panel"><div className="panel-header"><div><h3>译文质量分布</h3><p>AI 评分区间</p></div></div>{isDemo ? <div className="donut-wrap"><div className="donut"><div><strong>{report?.accuracy ?? 0}%</strong><span>平均采纳</span></div></div><div className="legend"><span><i className="legend-green" />优秀（90+） <b>—</b></span><span><i className="legend-blue" />良好（80-89） <b>—</b></span><span><i className="legend-gray" />待改进（&lt;80） <b>—</b></span></div></div> : <div className="empty-state">暂未提供质量评分数据，译文以管理员审核结果为准。</div>}</section></div><section className="panel contributor-panel"><div className="panel-header"><div><h3>贡献者排行</h3><p>按采纳译文数排序</p></div></div><div className="ranking-list">{contributors.length ? contributors.map((item, index) => <RankItem key={item.name} rank={String(index + 1).padStart(2, '0')} name={item.name} count={`${item.acceptedCount} 句`} rate={`${item.submittedCount ? Math.round((item.acceptedCount / item.submittedCount) * 100) : 0}%`} avatar={item.name.slice(0, 1)} />) : <div className="empty-state">暂无贡献者数据</div>}</div></section></div>
}
function RankItem({ rank, name, count, rate, avatar }: { rank: string; name: string; count: string; rate: string; avatar: string }) { return <div className="rank-item"><b className="rank-no">{rank}</b><span className="avatar avatar-small">{avatar}</span><strong>{name}</strong><span className="rank-count">{count}</span><span className="rank-rate"><CheckCircle2 size={14} />{rate} 采纳</span><MoreHorizontal size={16} /></div> }

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
