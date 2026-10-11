import { useEffect, useState } from 'react'
import { ChevronDown, RefreshCw } from 'lucide-react'
import { api, type RevisionRecord } from './api'
import { reviewLabels, timeLabel } from './review-format'

export function RevisionHistory({ kind, id }: { kind: 'assignment' | 'translation'; id: string }) {
  const [open, setOpen] = useState(false)
  const [records, setRecords] = useState<RevisionRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setLoading(true); setError('')
    void api.getRevisionHistory(kind, id, controller.signal).then((items) => { if (!controller.signal.aborted) setRecords(items) }).catch((error) => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '修订记录加载失败') }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [open, id, kind, attempt])
  return <section className="revision-history"><button className="revision-history-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><span>修订与审核记录</span><ChevronDown size={15} style={{ transform: open ? 'rotate(180deg)' : undefined }} /></button>{open && <div className="revision-history-body">{loading && <p role="status"><RefreshCw size={13} className="review-spin" />正在加载历史记录…</p>}{error && <p className="review-error" role="alert">{error}<button className="text-button" onClick={() => setAttempt((value) => value + 1)}>重试</button></p>}{!loading && !error && !records.length && <p>暂无修订记录。</p>}{records.map((record) => <article key={record.revision}><div><strong>V{record.revision}</strong><span className={`review-badge ${record.reviewStatus}`}>{reviewLabels[record.reviewStatus]}</span></div><p>{record.content}</p>{record.reviewNote && <blockquote><strong>审核意见</strong><p>{record.reviewNote}</p></blockquote>}<small>提交 {timeLabel(record.submittedAt)}{record.reviewedAt && ` · 审核 ${timeLabel(record.reviewedAt)}`}</small></article>)}</div>}</section>
}
