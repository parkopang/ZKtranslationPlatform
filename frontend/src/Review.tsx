import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowRight, Check, CheckCircle2, ClipboardCheck, MessageSquare, RefreshCw, Search, Users, X } from 'lucide-react'
import { api, groupReviewByVolunteer, taskUnitLabel, type ReviewStatus, type ReviewSubmission } from './api'
import './review.css'
import { reviewLabels, timeLabel } from './review-format'
import { RevisionHistory } from './RevisionHistory'
import { useLiveSync } from './useLiveSync'
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试'

export function Review({ onChanged }: { onChanged: () => void }) {
  const [rows, setRows] = useState<ReviewSubmission[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [article, setArticle] = useState('')
  const [status, setStatus] = useState<ReviewStatus | ''>('pending')
  const [volunteerId, setVolunteerId] = useState('')
  const [submissionId, setSubmissionId] = useState('')
  const [busy, setBusy] = useState(false)
  const [returning, setReturning] = useState<ReviewSubmission | null>(null)
  const [inspected, setInspected] = useState<ReviewSubmission | null>(null)
  const operation = useRef(false)
  const changeRef = useRef(onChanged)
  changeRef.current = onChanged

  const reviewSync = useLiveSync(true, async ({ signal, isCurrent }) => {
    try {
      const result = await api.getReviewSubmissions(signal)
      if (isCurrent()) { setRows(result); setError('') }
    } catch (error) { if (isCurrent()) setError(`${errorText(error)}。将自动重试，当前内容已保留。`) }
    finally { if (isCurrent()) setLoading(false) }
  })

  const articleOptions = [...new Map(rows.map((row) => [row.articleId, row.articleTitle])).entries()]
  const scoped = useMemo(() => rows.filter((row) => !article || row.articleId === article), [rows, article])
  const groups = useMemo(() => groupReviewByVolunteer(scoped).filter((group) =>
    (!search.trim() || `${group.name} ${group.id}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) && (!status || group.counts[status] > 0)
  ), [scoped, search, status])
  const selectedGroup = groups.find((group) => group.id === volunteerId) || groups[0]
  const submissions = selectedGroup?.submissions.filter((row) => !status || row.reviewStatus === status) || []
  const latest = submissions.find((row) => row.id === submissionId) || submissions[0]
  const selected = inspected?.id === latest?.id ? inspected : latest
  const newerVersion = !!selected && !!latest && selected.id === latest.id && selected.revision !== latest.revision
  useEffect(() => {
    if (!latest) return
    setInspected((current) => !current || current.id !== latest.id || (current.revision === latest.revision && current.reviewStatus !== latest.reviewStatus) ? latest : current)
  }, [latest?.id, latest?.revision, latest?.reviewStatus])
  useEffect(() => {
    if (selectedGroup && selectedGroup.id !== volunteerId) setVolunteerId(selectedGroup.id)
    if (selected && selected.id !== submissionId) setSubmissionId(selected.id)
  }, [selectedGroup?.id, selected?.id, volunteerId, submissionId])
  const candidates = selected ? rows.filter((row) => row.sentenceId === selected.sentenceId) : []
  const counts = scoped.reduce((total, row) => ({ ...total, [row.reviewStatus]: total[row.reviewStatus] + 1 }), { pending: 0, accepted: 0, returned: 0, not_selected: 0 })

  const decide = async (row: ReviewSubmission, decision: 'accepted' | 'returned', note = '') => {
    if (operation.current) return
    operation.current = true; reviewSync.pause(); setBusy(true); setError(''); setNotice('')
    try {
      await api.review(row.id, decision, row.revision, note)
      setReturning(null)
      setRows((current) => current.map((item) => item.id === row.id ? { ...item, reviewStatus: decision, reviewNote: note.trim(), reviewedAt: new Date().toISOString() } : decision === 'accepted' && item.sentenceId === row.sentenceId ? { ...item, reviewStatus: 'not_selected' } : item))
      setNotice(decision === 'accepted' ? `译文已采纳，同一${taskUnitLabel(row.taskUnit)}的其他任务已结束。` : '已退回，志愿者可以查看原因并重新提交。')
      changeRef.current()
      setInspected(null)
    } catch (error) {
      const message = errorText(error)
      if ((error as { status?: number }).status === 409) {
        setNotice('这份译文已发生变化，请查看最新版本后再审核。已填写的退回意见仍保留在窗口中。')
      }
      setError(message)
      throw error
    } finally { operation.current = false; setBusy(false); reviewSync.resume() }
  }
  const chooseCandidate = (row: ReviewSubmission) => { setStatus(''); setSearch(''); setVolunteerId(row.userId); setSubmissionId(row.id) }
  return <div className="admin-content review-workbench">
    <div className="page-header"><div><span className="overline">质量中心</span><h1>志愿者译文审核</h1><p>按志愿者查看贡献，逐个任务单元对比候选译文，将修改意见直接反馈给译者。</p></div><button className="outline-button" disabled={loading || busy} onClick={() => reviewSync.refresh()}><RefreshCw size={15} className={loading ? 'review-spin' : ''} />{loading ? '加载中…' : '刷新译文'}</button></div>
    <div className="review-counts" aria-label="审核状态统计">{(Object.keys(reviewLabels) as ReviewStatus[]).map((key) => <button key={key} className={`review-count ${status === key ? 'active' : ''}`} aria-pressed={status === key} onClick={() => { setStatus(key); setSubmissionId('') }}><span>{reviewLabels[key]}</span><strong>{counts[key]}<small>份</small></strong></button>)}</div>
    <div className="review-filters"><label className="review-search"><Search size={16} /><span className="review-sr-only">搜索志愿者</span><input type="search" placeholder="搜索志愿者姓名或账号编号" value={search} onChange={(event) => setSearch(event.target.value)} /></label><label><span className="review-sr-only">审核文章筛选</span><select aria-label="审核文章筛选" value={article} onChange={(event) => { setArticle(event.target.value); setSubmissionId('') }}><option value="">全部文章</option>{articleOptions.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label><label><span className="review-sr-only">审核状态筛选</span><select aria-label="审核状态筛选" value={status} onChange={(event) => { setStatus(event.target.value as ReviewStatus | ''); setSubmissionId('') }}><option value="">全部状态</option>{Object.entries(reviewLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    {error && <p className="review-error" role="alert">{error}</p>}{notice && <p className="review-notice" role="status"><CheckCircle2 size={16} />{notice}</p>}
    {loading && !rows.length ? <div className="review-empty" role="status"><RefreshCw size={25} className="review-spin" />正在加载志愿者译文…</div> : <div className="volunteer-review-layout">
      <aside className="panel volunteer-list" aria-label="志愿者列表"><div className="volunteer-list-heading"><Users size={17} /><strong>志愿者</strong><span>{groups.length} 人</span></div>{groups.map((group) => <button key={group.id} className={`volunteer-row ${selectedGroup?.id === group.id ? 'active' : ''}`} aria-pressed={selectedGroup?.id === group.id} onClick={() => { setVolunteerId(group.id); setSubmissionId('') }}><div className="volunteer-identity"><span className="avatar avatar-small">{group.name.slice(0, 1)}</span><div><strong>{group.name}</strong><small title={group.id}>账号 {group.id.slice(0, 8)}</small></div><b>{group.submissions.length} 份</b></div><div className="volunteer-counts"><span>待审 {group.counts.pending}</span><span>采纳 {group.counts.accepted}</span><span>退回 {group.counts.returned}</span><span>未采纳 {group.counts.not_selected}</span></div></button>)}{!groups.length && <div className="review-empty"><Users size={25} /><p>没有符合条件的志愿者译文。</p><button className="text-button" onClick={() => { setSearch(''); setArticle(''); setStatus('') }}>查看全部译文</button></div>}</aside>
      <section className="panel volunteer-submissions" aria-label="志愿者提交详情">{selectedGroup && selected ? <>
        <div className="volunteer-detail-heading"><div><span className="overline">志愿者提交</span><h2>{selectedGroup.name}</h2><small className="volunteer-full-id">账号 {selectedGroup.id}</small></div><span>{submissions.length} 份译文</span></div>
        <div className="volunteer-submission-picker"><label htmlFor="review-submission">选择该志愿者的译文</label><select id="review-submission" disabled={busy} value={selected.id} onChange={(event) => setSubmissionId(event.target.value)}>{submissions.map((row) => <option key={row.id} value={row.id}>{row.articleTitle} · 第 {row.position} {taskUnitLabel(row.taskUnit)} · V{row.revision} · {reviewLabels[row.reviewStatus]}</option>)}</select></div>
        {newerVersion && <p className="review-error" role="status">译者已提交 V{latest!.revision}。当前保留你正在查看的 V{selected!.revision}，请阅读新版本后再审核。<button className="text-button" disabled={busy} onClick={() => setInspected(latest!)}>查看最新译文</button></p>}
        <div className="review-document-meta"><strong>{selected.articleTitle}</strong><span>第 {selected.position} {taskUnitLabel(selected.taskUnit)} · {selected.sourceLanguage}<ArrowRight size={12} />{selected.targetLanguage}</span></div>
        <div className="review-original"><label>原文</label><p>{selected.sourceText}</p></div>
        <article className="review-current-translation"><div className="review-translation-heading"><span>志愿者译文 <b>V{selected.revision}</b></span><ReviewBadge status={selected.reviewStatus} /></div><p>{selected.content}</p><div className="review-timestamps"><span>提交 {timeLabel(selected.createdAt)}</span>{selected.reviewedAt && <span>审核 {timeLabel(selected.reviewedAt)}</span>}</div>{selected.reviewNote && <div className="review-feedback"><MessageSquare size={16} /><div><strong>{selected.reviewStatus === 'returned' ? '退回原因' : '审核说明'}</strong><p>{selected.reviewNote}</p></div></div>}
          {selected.reviewStatus === 'pending' ? <div className="review-decisions"><button className="outline-button" disabled={busy || loading || newerVersion} onClick={() => setReturning(selected)}><MessageSquare size={15} />退回重译</button><button className="primary-button" disabled={busy || loading || newerVersion} onClick={() => void decide(selected, 'accepted').catch(() => {})}><Check size={16} />{busy ? '处理中…' : '采纳此译文'}</button></div> : <p className="review-result-note">{selected.reviewStatus === 'returned' ? '等待志愿者按意见修改。重新提交后会以新版本进入待审核。' : selected.reviewStatus === 'accepted' ? `此译文已作为该${taskUnitLabel(selected.taskUnit)}的最终译文。` : `该${taskUnitLabel(selected.taskUnit)}已选择其他译文，当前提交作为历史记录保留。`}</p>}
        </article>
        <RevisionHistory key={`${selected.id}:${selected.revision}:${selected.reviewStatus}`} kind="translation" id={selected.id} />
        <section className="review-comparison" aria-label="同任务单元候选对比"><h3>同任务单元候选对比 <span>{candidates.length} 份</span></h3><p>每份译文独立审核；采纳其中一份后，该任务单元结束协作。</p><div className="review-candidate-grid">{candidates.map((row) => <article key={row.id} className={selected.id === row.id ? 'selected' : ''}><div><strong>{row.userName}</strong><ReviewBadge status={row.reviewStatus} /></div><small>账号 {row.userId.slice(0, 8)} · V{row.revision}</small><p>{row.content}</p><button className="text-button" disabled={busy || row.id === selected.id} onClick={() => chooseCandidate(row)}>{row.id === selected.id ? '当前查看' : '查看此译文'}<ArrowRight size={13} /></button></article>)}</div></section>
      </> : <div className="review-empty"><ClipboardCheck size={30} /><strong>从左侧选择一位志愿者</strong><p>这里会显示原文、提交版本、审核记录与候选对比。</p></div>}</section>
    </div>}
    {returning && <ReturnDialog row={returning} busy={busy} onClose={() => setReturning(null)} onSubmit={(note) => decide(returning, 'returned', note)} />}
  </div>
}

function ReviewBadge({ status }: { status: ReviewStatus }) { return <span className={`review-badge ${status}`}>{reviewLabels[status]}</span> }

function ReturnDialog({ row, busy, onClose, onSubmit }: { row: ReviewSubmission; busy: boolean; onClose: () => void; onSubmit: (note: string) => Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; ref.current?.showModal(); return () => { ref.current?.close(); previous?.focus() } }, [])
  return <dialog ref={ref} className="return-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}><form onSubmit={(event) => { event.preventDefault(); if (!note.trim() || busy) return; setError(''); void onSubmit(note).catch((error) => setError(errorText(error))) }}><header><div><h2 id={titleId}>退回重译</h2><p>{row.userName} · 第 {row.position} {taskUnitLabel(row.taskUnit)} · V{row.revision}</p></div><button type="button" className="icon-button" aria-label="关闭退回窗口" disabled={busy} onClick={onClose}><X size={20} /></button></header><label htmlFor="return-reason">修改意见 <span>必填，将展示给志愿者</span></label><textarea autoFocus id="return-reason" required maxLength={1000} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} placeholder="请指出需要修改的内容，例如术语、遗漏信息或表达问题。" /><small>{note.length} / 1000</small>{error && <p className="review-error" role="alert">{error}</p>}<footer><button type="button" className="outline-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || !note.trim()}>{busy ? '提交中…' : '确认退回'}</button></footer></form></dialog>
}
