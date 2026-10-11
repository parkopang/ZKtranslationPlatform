import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, BookOpen, CheckCircle2, ChevronLeft, ChevronRight, FileText, RefreshCw, Search, Settings2, UploadCloud, Users, X } from 'lucide-react'
import { api, taskUnitLabels, taskUnitLabel, type Article, type ArticleDetail, type TaskUnit } from './api'
import './articles.css'
import { useLiveSync } from './useLiveSync'
import { AssignVolunteers } from './AssignVolunteers'

type ArticlesProps = {
  articles: Article[]
  onRefresh: () => void
  onArticleUpdated: (article: Article) => void
  onImport: (title: string, language: string, sourceLanguage?: string, taskUnit?: TaskUnit, slots?: number, file?: File | null) => Promise<void>
}
type StatusFilter = '全部文章' | Article['status']
const pageSize = 12
const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试'
const number = (value: number) => value.toLocaleString('zh-CN')
// SQLite CURRENT_TIMESTAMP has no timezone suffix but represents UTC.
const dateFromApi = (value: string) => new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value)
const dateLabel = (value: string) => {
  const date = dateFromApi(value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}
const ratio = (article: Article) => article.segments ? Math.round(article.done / article.segments * 100) : 0

export function Articles({ articles, onRefresh, onArticleUpdated, onImport }: ArticlesProps) {
  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }) }, [])
  const [status, setStatus] = useState<StatusFilter>('全部文章')
  const [search, setSearch] = useState('')
  const [language, setLanguage] = useState('')
  const [sort, setSort] = useState('newest')
  const [page, setPage] = useState(1)
  const [showImport, setShowImport] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const languages = [...new Set(articles.map((article) => article.targetLanguage))].sort()
  const filtered = useMemo(() => articles.filter((article) =>
    (status === '全部文章' || article.status === status) && (!language || article.targetLanguage === language) &&
    (!search.trim() || article.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  ).sort((a, b) => sort === 'progress' ? ratio(a) - ratio(b) : sort === 'slots' ? b.remainingSlots - a.remainingSlots :
    (dateFromApi(b.createdAt).getTime() || 0) - (dateFromApi(a.createdAt).getTime() || 0)), [articles, status, language, search, sort])
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, pages)
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const totals = articles.reduce((value, article) => ({ sentences: value.sentences + article.segments, pending: value.pending + article.pendingTranslationCount, remaining: value.remaining + article.remainingSlots }), { sentences: 0, pending: 0, remaining: 0 })

  const clearFilters = () => { setStatus('全部文章'); setSearch(''); setLanguage(''); setPage(1) }

  return <div className="admin-content articles-page">
    <div className="page-header"><div><span className="overline">内容中心</span><h1>文章管理</h1><p>导入后按句子、段落或章节分派任务，同一任务单元可由多位志愿者协作翻译。</p></div><div className="article-header-actions"><button className="outline-button" onClick={onRefresh}><RefreshCw size={15} />刷新</button><button className="primary-button" onClick={() => setShowImport(true)}><UploadCloud size={17} />导入文章</button></div></div>
    <div className="article-metrics" aria-label="全部文章汇总">
      <Metric label="文章总数" value={articles.length} unit="篇" note="统一管理协作内容" />
      <Metric label="原文总任务单元" value={totals.sentences} unit="个" note="每个任务单元可由多位志愿者翻译" />
      <Metric label="待审核译文" value={totals.pending} unit="份" note="等待择优采纳" />
      <Metric label="可领取名额" value={totals.remaining} unit="个" note="已扣除占用及已采纳句" />
    </div>
    <section className="panel article-library" aria-label="文章列表">
      <div className="article-filter-tabs" aria-label="按状态筛选">{(['全部文章', '进行中', '已完成', '草稿'] as StatusFilter[]).map((item) => <button key={item} aria-pressed={status === item} className={status === item ? 'active' : ''} onClick={() => { setStatus(item); setPage(1) }}>{item}<span>{item === '全部文章' ? articles.length : articles.filter((article) => article.status === item).length}</span></button>)}</div>
      <div className="article-toolbar">
        <label className="article-search"><Search size={17} /><span className="article-sr-only">搜索文章标题</span><input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1) }} placeholder="搜索文章标题" /></label>
        <label className="article-select"><span className="article-sr-only">目标语种筛选</span><select value={language} onChange={(event) => { setLanguage(event.target.value); setPage(1) }}><option value="">全部目标语种</option>{languages.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label className="article-select"><span className="article-sr-only">文章排序</span><select value={sort} onChange={(event) => { setSort(event.target.value); setPage(1) }}><option value="newest">最新导入优先</option><option value="progress">采纳进度从低到高</option><option value="slots">可领取名额优先</option></select></label>
      </div>
      <div className="article-list-heading" aria-hidden="true"><span>文章与语种</span><span>协作配置</span><span>任务进展</span><span>采纳进度</span><span>管理</span></div>
      {visible.length ? <div className="article-list">{visible.map((article) => <article className="article-item" key={article.id}>
        <div className="article-name"><span className="file-icon"><FileText size={20} /></span><div><button className="article-title-button" onClick={() => setSelectedId(article.id)}>{article.title}</button><span className="article-language">{article.sourceLanguage}<ArrowRight size={11} />{article.targetLanguage}<i />{number(article.segments)} {taskUnitLabel(article.taskUnit)}</span><small>导入于 {dateLabel(article.createdAt)}</small></div></div>
        <div className="article-allocation"><span className="article-ratio">1 <em>:</em> {article.translatorSlots}</span><small>每{taskUnitLabel(article.taskUnit)} {article.translatorSlots} 位志愿者</small><small>可领取 <b>{number(article.remainingSlots)}</b> 个名额</small></div>
        <div className="article-task-counts"><span>已分配 <b>{number(article.assignmentCount)}</b> 个任务</span><span>已提交 <b>{number(article.translationCount)}</b> 份译文</span><small>{article.pendingTranslationCount > 0 ? `${number(article.pendingTranslationCount)} 份待审核` : '暂无待审核译文'}</small></div>
        <div className="article-acceptance"><span className={`status-pill ${article.status === '已完成' ? 'done' : article.status === '草稿' ? 'draft' : 'progress'}`}><i />{article.status}</span><span><b>{article.done}</b> / {article.segments} 句已采纳</span><div className="mini-progress" role="progressbar" aria-label={`${article.title}采纳进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={ratio(article)}><span style={{ width: `${ratio(article)}%` }} /></div></div>
        <button className="article-detail-button" onClick={() => setSelectedId(article.id)} aria-label={`管理文章：${article.title}`}>管理文章<ChevronRight size={15} /></button>
      </article>)}</div> : <div className="article-empty"><BookOpen size={30} /><strong>{articles.length ? '没有符合条件的文章' : '从第一篇文章开始协作'}</strong><p>{articles.length ? '试试其他标题、状态或目标语种。' : '导入 Word 或 TXT 文档，选择按句子、段落或章节分派，再设置志愿者人数。'}</p><button className="outline-button" onClick={articles.length ? clearFilters : () => setShowImport(true)}>{articles.length ? '清除筛选' : '导入文章'}</button></div>}
      <div className="article-list-footer"><span>共 {filtered.length} 篇{filtered.length !== articles.length && `，全部 ${articles.length} 篇`} · 人数按任务单元独立配置</span>{pages > 1 && <Pagination page={currentPage} pages={pages} onChange={setPage} />}</div>
    </section>
    <p className="article-page-note"><Users size={15} />每篇文章按已选任务单元协作；同一任务单元支持多位志愿者独立翻译，同一人不会重复领取。采纳后该任务结束，已有记录保留。</p>
    {showImport && <ImportDialog onClose={() => setShowImport(false)} onImport={async (...args) => { await onImport(...args); clearFilters(); setSort('newest') }} />}
    {selectedId && <ArticleDialog id={selectedId} onClose={() => setSelectedId(null)} onArticleUpdated={onArticleUpdated} onAssigned={onRefresh} />}
  </div>
}

function Metric({ label, value, unit, note }: { label: string; value: number; unit: string; note: string }) {
  return <div className="article-metric"><span>{label}</span><strong>{number(value)}<small>{unit}</small></strong><p>{note}</p></div>
}

function Pagination({ page, pages, onChange }: { page: number; pages: number; onChange: (page: number) => void }) {
  return <nav className="article-pagination" aria-label="分页"><button aria-label="上一页" disabled={page <= 1} onClick={() => onChange(page - 1)}><ChevronLeft size={17} /></button><span>{page} / {pages}</span><button aria-label="下一页" disabled={page >= pages} onClick={() => onChange(page + 1)}><ChevronRight size={17} /></button></nav>
}

function Dialog({ children, title, description, wide = false, busy = false, onClose }: { children: ReactNode; title: string; description: string; wide?: boolean; busy?: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  useEffect(() => {
    const dialog = dialogRef.current
    const previouslyFocused = document.activeElement as HTMLElement | null
    dialog?.showModal()
    titleRef.current?.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { dialog?.close(); document.body.style.overflow = previousOverflow; previouslyFocused?.focus() }
  }, [])
  return <dialog ref={dialogRef} className={`article-dialog ${wide ? 'article-dialog-wide' : ''}`} aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}>
    <div className="article-dialog-header"><div><h2 id={titleId} tabIndex={-1} ref={titleRef}>{title}</h2><p id={descriptionId}>{description}</p></div><button className="article-close" aria-label="关闭窗口" disabled={busy} onClick={onClose}><X size={20} /></button></div>
    {children}
  </dialog>
}

function SlotControl({ value, onChange, disabled = false, id }: { value: string; onChange: (value: string) => void; disabled?: boolean; id: string }) {
  const count = Number(value)
  return <div className="article-slot-control"><button type="button" aria-label="减少每个任务单元的志愿者人数" disabled={disabled || count <= 1 || !Number.isFinite(count)} onClick={() => onChange(String(Math.max(1, count - 1)))}>−</button><input id={id} aria-label="每个任务单元的志愿者人数" type="number" inputMode="numeric" min={1} max={20} step={1} required disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)} /><button type="button" aria-label="增加每个任务单元的志愿者人数" disabled={disabled || count >= 20 || !Number.isFinite(count)} onClick={() => onChange(String(Math.min(20, count + 1)))}>＋</button></div>
}

function ArticleDialog({ id, onClose, onArticleUpdated, onAssigned }: { id: string; onClose: () => void; onArticleUpdated: (article: Article) => void; onAssigned: () => void }) {
  const [detail, setDetail] = useState<ArticleDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [notice, setNotice] = useState('')
  const [slots, setSlots] = useState('')
  const [saving, setSaving] = useState(false)
  const [sentenceSearch, setSentenceSearch] = useState('')
  const [sentenceFilter, setSentenceFilter] = useState('all')
  const [sentencePage, setSentencePage] = useState(1)
  const saveBusy = useRef(false)
  const slotsDirty = useRef(false)
  const detailSync = useLiveSync(true, async ({ signal, isCurrent }) => {
    try {
      const result = await api.getArticle(id, signal)
      if (isCurrent()) {
        setDetail(result)
        if (!slotsDirty.current) setSlots(String(result.article.translatorSlots))
        setError('')
      }
    } catch (error) { if (isCurrent()) setError(`${messageOf(error)}。将自动重试，未保存的配置已保留。`) }
    finally { if (isCurrent()) setLoading(false) }
  }, id)
  const count = Number(slots)
  const valid = slots.trim() !== '' && Number.isInteger(count) && count >= 1 && count <= 20
  const changed = !!detail && count !== detail.article.translatorSlots
  const nextRemaining = detail && valid ? detail.sentences.reduce((sum, sentence) => sum + (sentence.acceptedCount ? 0 : Math.max(count - sentence.assignmentCount, 0)), 0) : 0
  const delta = detail ? nextRemaining - detail.article.remainingSlots : 0
  const overCapacity = detail && valid ? detail.sentences.filter((sentence) => sentence.assignmentCount > count).length : 0
  const sentences = detail?.sentences.filter((sentence) =>
    (!sentenceSearch.trim() || sentence.sourceText.toLocaleLowerCase().includes(sentenceSearch.trim().toLocaleLowerCase())) &&
    (sentenceFilter === 'all' || (sentenceFilter === 'accepted' && sentence.acceptedCount > 0) || (sentenceFilter === 'pending' && sentence.pendingTranslationCount > 0) || (sentenceFilter === 'available' && sentence.remainingSlots > 0))
  ) || []
  const sentencePages = Math.max(1, Math.ceil(sentences.length / 20))
  const currentSentencePage = Math.min(sentencePage, sentencePages)

  const save = async () => {
    if (!detail || !valid || !changed || saveBusy.current) return
    saveBusy.current = true
    detailSync.pause()
    setSaving(true)
    setSaveError('')
    setNotice('')
    try {
      const article = await api.updateArticleConfig(id, count)
      onArticleUpdated(article)
      slotsDirty.current = false
      setSlots(String(article.translatorSlots))
      setDetail((current) => current ? { article, sentences: current.sentences.map((sentence) => ({ ...sentence, translatorSlots: count, remainingSlots: sentence.acceptedCount ? 0 : Math.max(count - sentence.assignmentCount, 0) })) } : current)
      setNotice(`已保存为 1 : ${count}。后续领取立即使用新配置，已有任务和译文已保留。`)
    } catch (error) { setSaveError(messageOf(error)) }
    finally { saveBusy.current = false; setSaving(false); detailSync.resume() }
  }

  return <Dialog wide title={detail?.article.title || '文章详情'} description="查看任务单元进展，动态调整这篇文章的协作配置。" busy={saving} onClose={onClose}>
    {loading && !detail && <div className="article-empty" role="status"><RefreshCw className="article-spinning" size={25} /><p>正在加载文章详情…</p></div>}
    {error && <div className="article-error" role="alert">{error}<button className="text-button" disabled={loading || saving} onClick={() => detailSync.refresh()}>{loading ? '加载中…' : '重新加载'}</button></div>}
    {detail && <>
      <div className="article-detail-meta"><span className="language-pill">{detail.article.sourceLanguage}<ArrowRight size={12} />{detail.article.targetLanguage}</span><span>{number(detail.article.segments)} {taskUnitLabel(detail.article.taskUnit)}原文</span><span>任务方式：{taskUnitLabels[detail.article.taskUnit].action.replace('按', '')}</span><span>配置更新 {dateLabel(detail.article.updatedAt)}</span><button className="text-button" disabled={loading || saving} onClick={() => { setNotice(''); detailSync.refresh() }}><RefreshCw size={13} />{loading ? '刷新中' : '刷新详情'}</button></div>
      <section className="article-config" aria-labelledby="article-config-heading"><div className="article-config-heading"><Settings2 size={19} /><div><h3 id="article-config-heading">协作比例</h3><p>1 个{taskUnitLabel(detail.article.taskUnit)} : N 位志愿者，每位独立提交一份译文。</p></div><span>当前 1 : {detail.article.translatorSlots}</span></div>
        <div className="article-config-body"><div className="article-config-input"><label htmlFor="detail-slots">每{taskUnitLabel(detail.article.taskUnit)}志愿者人数</label><SlotControl id="detail-slots" value={slots} onChange={(value) => { slotsDirty.current = true; setSlots(value); setNotice(''); setSaveError('') }} disabled={saving || loading} /><small>支持 1–20 人，对本篇全部{taskUnitLabel(detail.article.taskUnit)}生效</small></div><div className="article-config-preview" aria-live="polite"><span>调整后可领取名额</span><strong>{valid ? number(nextRemaining) : '—'}<small>个</small></strong><p>{valid && changed ? `当前 ${number(detail.article.remainingSlots)} 个，${delta > 0 ? '新增' : delta < 0 ? '减少' : '变化'} ${number(Math.abs(delta))} 个` : `按当前${taskUnitLabel(detail.article.taskUnit)}状态与已分配任务计算`}</p></div><div className="article-config-action"><button className="primary-button" disabled={!valid || !changed || saving || loading} onClick={() => void save()}>{saving ? '保存中…' : '保存配置'}</button><small>保存后即刻生效</small></div></div>
        {!valid && <p className="article-error" role="alert">请输入 1–20 的整数。</p>}
        <div className="article-allocation-rules"><p>调低人数不会撤回已领取任务，已有任务仍可提交。采纳后该{taskUnitLabel(detail.article.taskUnit)}任务结束，已有记录保留。</p>{valid && overCapacity > 0 && <p className="article-capacity-notice">{overCapacity} 个{taskUnitLabel(detail.article.taskUnit)}已有任务数超过{changed ? '调整后' : '当前'}人数，将保留这些任务，且不会继续分配。</p>}<p>计划名额为 {valid ? number(detail.article.segments * count) : '—'} 个（总{taskUnitLabel(detail.article.taskUnit)}数 × 每个{taskUnitLabel(detail.article.taskUnit)}人数），不代表实际参与人数。</p></div>
        {saveError && <p className="article-error" role="alert">{saveError}</p>}{notice && <p className="article-success" role="status"><CheckCircle2 size={15} />{notice}</p>}
      </section>
      <AssignVolunteers key={id} articleId={id} articleTitle={detail.article.title} remainingSlots={detail.article.remainingSlots} translatorSlots={detail.article.translatorSlots} taskUnit={detail.article.taskUnit} onAssigned={() => { detailSync.refresh(); onAssigned() }} />
      <div className="article-detail-stats"><span>已分配任务 <b>{number(detail.article.assignmentCount)}</b></span><span>已提交译文 <b>{number(detail.article.translationCount)}</b></span><span>待审核译文 <b>{number(detail.article.pendingTranslationCount)}</b></span><span>已采纳原文 <b>{detail.article.done} / {detail.article.segments}</b></span></div>
      <section className="article-sentences" aria-labelledby="article-sentences-heading"><div className="article-sentence-heading"><h3 id="article-sentences-heading">逐{taskUnitLabel(detail.article.taskUnit)}进展 <span>{sentences.length} 个</span></h3><label className="article-select"><span className="article-sr-only">任务单元状态筛选</span><select value={sentenceFilter} onChange={(event) => { setSentenceFilter(event.target.value); setSentencePage(1) }}><option value="all">全部任务</option><option value="available">可领取</option><option value="pending">待审核</option><option value="accepted">已采纳</option></select></label></div>
        <label className="article-search article-sentence-search"><Search size={15} /><span className="article-sr-only">搜索任务原文</span><input type="search" value={sentenceSearch} onChange={(event) => { setSentenceSearch(event.target.value); setSentencePage(1) }} placeholder={`搜索${taskUnitLabel(detail.article.taskUnit)}原文`} /></label>
        <div className="article-sentence-list">{sentences.slice((currentSentencePage - 1) * 20, currentSentencePage * 20).map((sentence) => <article className="article-sentence" key={sentence.id}><span className="article-sentence-no">{String(sentence.position).padStart(2, '0')}</span><div className="article-sentence-body"><p>{sentence.sourceText}</p><div className="article-sentence-counts"><span>每{taskUnitLabel(detail.article.taskUnit)} <b>{sentence.translatorSlots}</b> 人</span><span>已分配 <b>{sentence.assignmentCount}</b></span><span>已提交 <b>{sentence.translationCount}</b></span><span>待审核 <b>{sentence.pendingTranslationCount}</b></span><span>可领取 <b>{sentence.remainingSlots}</b></span></div></div><span className={`status-pill ${sentence.acceptedCount ? 'done' : sentence.pendingTranslationCount ? 'review' : 'progress'}`}><i />{sentence.acceptedCount ? '已采纳' : sentence.pendingTranslationCount ? '待审核' : sentence.assignmentCount ? '协作中' : '待领取'}</span></article>)}</div>
        {!sentences.length && <div className="article-empty"><p>没有符合条件的任务单元。</p></div>}
        {sentencePages > 1 && <div className="article-sentence-pagination"><Pagination page={currentSentencePage} pages={sentencePages} onChange={setSentencePage} /></div>}
      </section>
    </>}
  </Dialog>
}

function ImportDialog({ onClose, onImport }: { onClose: () => void; onImport: ArticlesProps['onImport'] }) {
  const [title, setTitle] = useState('')
  const [sourceLanguage, setSourceLanguage] = useState('英语')
  const [targetLanguage, setTargetLanguage] = useState('中文')
  const [taskUnit, setTaskUnit] = useState<TaskUnit>('sentence')
  const [slots, setSlots] = useState('2')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)
  const busy = useRef(false)
  const count = Number(slots)
  const validSlots = slots.trim() !== '' && Number.isInteger(count) && count >= 1 && count <= 20
  const normalizedLanguage = (value: string) => ({ 英语: 'en', English: 'en', 中文: 'zh', 日语: 'ja', 日本語: 'ja' })[value] || value
  const sameLanguage = normalizedLanguage(sourceLanguage) === normalizedLanguage(targetLanguage)
  const selectFile = (selected: File | null) => {
    if (!selected) return
    if (!/\.(docx|txt)$/i.test(selected.name)) { setError('仅支持 .docx 或 .txt 文件，请重新选择。'); setFile(null); return }
    if (!selected.size || selected.size > 20 * 1024 * 1024) { setError('文件不能为空，且大小不能超过 20 MB。'); setFile(null); return }
    setFile(selected)
    setError('')
    if (!title.trim()) setTitle(selected.name.replace(/\.(docx|txt)$/i, '').slice(0, 200))
  }
  const submit = async () => {
    if (busy.current) return
    if (!file) { setError('请选择要导入的文章文件。'); return }
    if (!title.trim()) { setError('请填写文章标题。'); return }
    if (!validSlots || sameLanguage) return
    busy.current = true
    setImporting(true)
    setError('')
    try { await onImport(title.trim(), targetLanguage, sourceLanguage, taskUnit, count, file); onClose() }
    catch (error) { setError(messageOf(error)) }
    finally { busy.current = false; setImporting(false) }
  }
  return <Dialog title="导入文章" description="先选择任务单元，再导入文档。志愿者将按这个粒度领取和提交译文。" busy={importing} onClose={onClose}>
    <form className="article-import-form" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="article-upload"><UploadCloud size={28} /><strong>{file ? file.name : '选择需要翻译的文档'}</strong><p>{file ? `${(file.size / 1024).toFixed(1)} KB · 已选择` : '支持 Word（.docx）或 TXT，最大 20 MB'}</p><label className="outline-button file-picker">{file ? '重新选择' : '选择文件'}<input aria-label="选择文章文件" type="file" accept=".docx,.txt" disabled={importing} onChange={(event) => { selectFile(event.target.files?.[0] || null); event.target.value = '' }} /></label></div>
      <div className="form-field"><label htmlFor="article-title">文章标题 <span>必填</span></label><input id="article-title" value={title} maxLength={200} required disabled={importing} onChange={(event) => setTitle(event.target.value)} placeholder="请输入文章标题" /><small>{title.length} / 200 字</small></div>
      <div className="form-row"><div className="form-field"><label htmlFor="article-source-language">原文语种</label><select id="article-source-language" disabled={importing} value={sourceLanguage} onChange={(event) => setSourceLanguage(event.target.value)}><option>英语</option><option>中文</option><option>日语</option></select></div><div className="form-field"><label htmlFor="article-target-language">目标语种</label><select id="article-target-language" disabled={importing} value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value)}><option>中文</option><option>English</option><option>日本語</option></select></div></div>
      {sameLanguage && <p className="article-error" role="alert">原文与目标语种不能相同。</p>}
      <fieldset className="task-unit-picker"><legend>任务分派方式</legend><div className="task-unit-options">{(Object.keys(taskUnitLabels) as TaskUnit[]).map((unit) => <label key={unit} className={taskUnit === unit ? 'selected' : ''}><input type="radio" name="task-unit" value={unit} checked={taskUnit === unit} disabled={importing} onChange={() => setTaskUnit(unit)} /><span><strong>{taskUnitLabels[unit].action}</strong><small>{taskUnitLabels[unit].description}</small></span></label>)}</div><p className="task-unit-hint">章节模式会识别“第 X 章 / Chapter X / 标题行”等章节标题；未识别到标题时按自然段创建任务。</p></fieldset>
      <div className="article-import-slots"><div><label htmlFor="import-slots">每{taskUnitLabel(taskUnit)}志愿者人数</label><p>1 个{taskUnitLabel(taskUnit)} : {validSlots ? count : 'N'} 位志愿者</p></div><SlotControl id="import-slots" value={slots} onChange={setSlots} disabled={importing} /></div>
      {!validSlots && <p className="article-error" role="alert">请输入 1–20 的整数。</p>}
      <p className="article-import-note">导入后可以调整每个任务单元的志愿者人数；任务分派方式与目标语种在导入后固定，避免已有任务错配。</p>
      {error && <p className="article-error" role="alert">{error}</p>}
      <div className="article-import-actions"><button className="outline-button" type="button" disabled={importing} onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={importing || !file || !title.trim() || !validSlots || sameLanguage}>{importing ? '正在导入…' : '确认导入'}<ArrowRight size={15} /></button></div>
    </form>
  </Dialog>
}
