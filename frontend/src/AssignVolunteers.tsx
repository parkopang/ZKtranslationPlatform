import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowRight, CheckCircle2, ChevronDown, CircleAlert, RefreshCw, Search, UserPlus, Users } from 'lucide-react'
import { taskUnitLabel, type TaskUnit } from './api'
import { allocateArticleVolunteers, filterVolunteers, loadRegisteredVolunteers, MAX_ASSIGNEES, type AllocationResult, type RegisteredVolunteer } from './volunteer-allocation'
import { useLiveSync } from './useLiveSync'
import './assign-volunteers.css'

type AssignVolunteersProps = {
  articleId: string
  articleTitle: string
  remainingSlots: number
  translatorSlots: number
  taskUnit: TaskUnit
  onAssigned: () => void | Promise<void>
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试'

export function AssignVolunteers({ articleId, articleTitle, remainingSlots, translatorSlots, taskUnit, onAssigned }: AssignVolunteersProps) {
  const panelId = useId()
  const countId = useId()
  const [open, setOpen] = useState(false)
  const [volunteers, setVolunteers] = useState<RegisteredVolunteer[]>([])
  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [count, setCount] = useState<1 | 2>(1)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [syncNotice, setSyncNotice] = useState('')
  const [result, setResult] = useState<AllocationResult | null>(null)
  const mounted = useRef(true)
  const operation = useRef(false)
  const onAssignedRef = useRef(onAssigned)
  onAssignedRef.current = onAssigned

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    setSelectedIds([]); setResult(null); setActionError(''); setSyncNotice('')
  }, [articleId])

  const volunteerSync = useLiveSync(open, async ({ signal, isCurrent }) => {
    if (!volunteers.length) setLoading(true)
    try {
      const items = await loadRegisteredVolunteers(signal)
      if (!isCurrent()) return
      setVolunteers(items)
      setSelectedIds((current) => current.filter(id => items.some(volunteer => volunteer.id === id)))
      setLoadError('')
    } catch (error) {
      if (isCurrent()) setLoadError(messageOf(error))
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, articleId)

  const visible = useMemo(() => filterVolunteers(volunteers, search), [volunteers, search])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const requested = selectedIds.length * count
  const choose = (id: string) => {
    setActionError('')
    setSelectedIds((current) => current.includes(id) ? current.filter(item => item !== id) : current.length < MAX_ASSIGNEES ? [...current, id] : current)
  }
  const selectVisible = () => {
    setSelectedIds((current) => [...new Set([...current, ...visible.map(volunteer => volunteer.id)])].slice(0, MAX_ASSIGNEES))
    setActionError('')
  }
  const assign = async () => {
    if (operation.current || !selectedIds.length || remainingSlots <= 0) return
    volunteerSync.pause()
    operation.current = true; setBusy(true); setActionError(''); setSyncNotice(''); setResult(null)
    setLoading(false)
    try {
      const assignment = await allocateArticleVolunteers(articleId, selectedIds, count)
      if (!mounted.current) return
      setResult(assignment); setSelectedIds([])
      try { await onAssignedRef.current() } catch { if (mounted.current) setSyncNotice('任务已分配，文章统计暂时未更新，请稍后刷新。') }
    } catch (error) {
      if (mounted.current) setActionError(`${messageOf(error)}。请查看最新任务统计后再重试。`)
      try { await onAssignedRef.current() } catch { /* Preserve the original operation failure. */ }
    } finally { operation.current = false; if (mounted.current) { setBusy(false); volunteerSync.resume() } }
  }

  return <section className="assign-volunteers" aria-label="文章定向分配">
    <div className="av-heading"><div className="av-heading-copy"><span className="av-icon"><UserPlus size={18} /></span><div><h3>分配给志愿者</h3><p>选择已注册的志愿者，为每人安排 1–2 个{taskUnitLabel(taskUnit)}翻译任务。</p></div></div><button type="button" className="outline-button" disabled={busy} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>{open ? '收起分配' : '选择志愿者'}<ChevronDown size={14} style={{ transform: open ? 'rotate(180deg)' : undefined }} /></button></div>
    {open && <div id={panelId} className="av-body">
        <div className="av-capacity"><span>本篇每{taskUnitLabel(taskUnit)} <b>{translatorSlots}</b> 位志愿者</span><span>当前可分配 <b>{remainingSlots}</b> 个名额</span></div>
      <div className="av-toolbar"><label className="av-search"><Search size={16} /><span className="av-sr-only">搜索志愿者姓名或账号</span><input type="search" value={search} disabled={busy} onChange={(event) => setSearch(event.target.value)} placeholder="搜索姓名或账号编号" /></label><button type="button" className="av-refresh" aria-label="刷新已注册志愿者" disabled={loading || busy} onClick={() => { setLoading(true); volunteerSync.refresh() }}><RefreshCw size={15} className={loading ? 'av-spinning' : ''} />刷新</button></div>
      <div className="av-selection-tools"><span>已注册 <b>{volunteers.length}</b> 人{search.trim() && ` · 筛选 ${visible.length} 人`}</span><div><button type="button" disabled={busy || !visible.length || selectedIds.length >= MAX_ASSIGNEES} onClick={selectVisible}>选择当前列表</button><button type="button" disabled={busy || !selectedIds.length} onClick={() => setSelectedIds([])}>清空选择</button></div></div>
      {loadError && <p className="av-error" role="alert">{loadError}，已有选择保留，可重新刷新。</p>}
      <div className="av-roster" aria-label="已注册志愿者列表" aria-busy={loading}>
        {loading && !volunteers.length ? <div className="av-empty" role="status"><RefreshCw size={21} className="av-spinning" /><p>正在加载志愿者…</p></div> : visible.length ? visible.map(volunteer => <label key={volunteer.id} className={`av-person ${selectedSet.has(volunteer.id) ? 'selected' : ''}`}><input type="checkbox" checked={selectedSet.has(volunteer.id)} disabled={busy || (!selectedSet.has(volunteer.id) && selectedIds.length >= MAX_ASSIGNEES)} onChange={() => choose(volunteer.id)} aria-label={`分配给 ${volunteer.name}，账号 ${volunteer.id}`} /><span className="av-person-avatar">{volunteer.name.slice(0, 1)}</span><span className="av-person-name"><strong>{volunteer.name}</strong><small title={volunteer.id}>账号 {volunteer.id.slice(0, 8)}</small></span><span className="av-person-stats"><span>待完成 <b>{volunteer.activeCount}</b> 个</span><small>{volunteer.assignedCount === 0 ? '尚未分配任务' : `已提交 ${volunteer.submittedCount} 个`}</small></span></label>) : <div className="av-empty"><Users size={24} /><strong>{search.trim() ? '没有匹配的志愿者' : loadError ? '暂时无法加载志愿者' : '还没有已注册志愿者'}</strong><p>{search.trim() ? '试试其他姓名或账号编号。' : '志愿者完成注册后会自动出现在这里。'}</p>{search.trim() && <button type="button" onClick={() => setSearch('')}>清除搜索</button>}</div>}
      </div>
      <div className="av-allocation-controls"><label htmlFor={countId}>每人分配<select id={countId} value={count} disabled={busy} onChange={(event) => setCount(Number(event.target.value) as 1 | 2)}><option value={1}>1 个{taskUnitLabel(taskUnit)}</option><option value={2}>2 个{taskUnitLabel(taskUnit)}</option></select></label><div className="av-planned"><span>已选 <b>{selectedIds.length}</b> 人</span><strong>计划分配 {requested} 个任务</strong></div><button type="button" className="primary-button" disabled={busy || loading || !selectedIds.length || remainingSlots <= 0} onClick={() => void assign()}>{busy ? <><RefreshCw size={15} className="av-spinning" />分配中…</> : <>确认分配<ArrowRight size={15} /></>}</button></div>
      {selectedIds.length >= MAX_ASSIGNEES && <p className="av-notice">每次最多选择 {MAX_ASSIGNEES} 人，其余志愿者可分批安排。</p>}
      {remainingSlots <= 0 ? <p className="av-notice">本篇当前没有可分配名额。可先调整每{taskUnitLabel(taskUnit)}志愿者人数；已采纳任务保持结束状态。</p> : requested > remainingSlots ? <p className="av-notice">计划任务数超过当前名额，将按实际可分配{taskUnitLabel(taskUnit)}安排，并逐人展示结果。</p> : null}
      <p className="av-rules">在「{articleTitle}」中随机安排{taskUnitLabel(taskUnit)}，每人不会重复收到同一{taskUnitLabel(taskUnit)}。遵守每{taskUnitLabel(taskUnit)}人数配置，已采纳的任务不再分配；名额不足时保留已有任务。</p>
      {actionError && <p className="av-error" role="alert">{actionError}</p>}
      {syncNotice && <p className="av-notice" role="status">{syncNotice}</p>}
      {result && <div className="av-results" role="status"><div className="av-result-heading">{result.assignedCount ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}<strong>{result.assignedCount ? `已分配 ${result.assignedCount} 个任务` : '当前没有可新增的任务'}</strong><span>计划 {result.totalRequested} 个</span></div>{result.results.map(row => <div className="av-result-row" key={row.userId}><div><strong>{row.userName}</strong><small>账号 {row.userId.slice(0, 8)}</small></div><span className={row.assignedCount ? 'av-result-success' : 'av-result-empty'}>{row.assignedCount ? `已分配 ${row.assignedCount} 个${taskUnitLabel(taskUnit)}` : '未新增任务'}</span>{row.skippedReason && <p>{row.skippedReason}</p>}</div>)}</div>}
    </div>}
  </section>
}
