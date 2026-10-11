import type { ReviewStatus } from './api'
export const reviewLabels: Record<ReviewStatus, string> = { pending: '待审核', accepted: '已采纳', returned: '退回重译', not_selected: '未采纳' }
export const timeLabel = (value?: string) => {
  if (!value) return '—'
  const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}
