import { useState } from 'react'
import { ArrowRight, ClipboardCheck, Search } from 'lucide-react'
import { taskEditable, taskUnitLabel, type Segment, type SegmentStatus } from './api'
import { timeLabel } from './review-format'
import './task-results.css'

const statuses: SegmentStatus[] = ['待翻译', '待审核', '退回重译', '已采纳', '未采纳', '已结束']

export function TaskResults({ tasks, onOpen }: { tasks: Segment[]; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<SegmentStatus | ''>('')
  const [search, setSearch] = useState('')
  const visible = tasks.filter((task) => (!filter || task.status === filter) && (!search.trim() || `${task.articleTitle || ''} ${task.source}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())))
  return <section className="my-task-results" aria-label="我的审核结果">
    <div className="my-results-heading"><span className="overline">我的贡献</span><h1>每一次提交，都有反馈</h1><p>累计提交按任务去重，修改后重提不重复累计。下方按当前状态统计，审核结果会自动同步。</p></div>
    <div className="task-result-counts">{statuses.map((status) => <button key={status} className={filter === status ? 'active' : ''} aria-pressed={filter === status} onClick={() => setFilter(filter === status ? '' : status)}><span>{status}</span><strong>{tasks.filter((task) => task.status === status).length}</strong></button>)}</div>
    <div className="task-result-filters"><button className={filter === '' ? 'active' : ''} onClick={() => setFilter('')}>全部任务 {tasks.length}</button><label><Search size={15} /><span className="review-sr-only">搜索我的文章或原文</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文章或原文" /></label></div>
    <div className="task-results-list">{visible.map((task) => <article key={task.id}><div className="task-result-title"><strong>{task.articleTitle || '翻译任务'}</strong><span className={`task-state-label ${task.reviewStatus || (task.closed ? 'closed' : 'unsubmitted')}`}>{task.status}</span></div><small>第 {task.no} {taskUnitLabel(task.taskUnit)} · {task.targetLanguage || '目标语种'}{task.revision ? ` · V${task.revision}` : ''}</small><p className="task-result-source">{task.source}</p>{task.reviewNote && <div className="task-result-note"><strong>{task.reviewStatus === 'returned' ? '修改意见' : '审核说明'}</strong><p>{task.reviewNote}</p></div>}<div className="task-result-bottom"><span>{task.reviewedAt ? `审核 ${timeLabel(task.reviewedAt)}` : task.submittedAt ? `提交 ${timeLabel(task.submittedAt)}` : task.status === '待审核' ? '等待管理员审核' : '任务记录'}{task.closed && !task.completed ? ' · 无需提交' : ''}</span><button className="text-button" onClick={() => onOpen(task.id)}>{task.reviewStatus === 'returned' && !task.closed ? '修改重提' : taskEditable(task) ? '继续翻译' : '查看记录'}<ArrowRight size={13} /></button></div></article>)}{!visible.length && <div className="task-results-empty"><ClipboardCheck size={28} /><strong>{tasks.length ? '暂时没有符合条件的任务' : '尚未领取翻译任务'}</strong><p>{tasks.length ? '切换状态或搜索其他文章。' : '回到翻译任务领取原文，开始你的第一份贡献。'}</p></div>}</div>
  </section>
}
