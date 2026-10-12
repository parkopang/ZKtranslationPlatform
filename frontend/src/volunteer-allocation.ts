import { getAdminKey, request } from './api'

export const MAX_ASSIGNEES = 50
export type RegisteredVolunteer = {
  id: string
  name: string
  entryCode?: string
  entryName?: string
  entryChannel?: string
  assignedCount: number
  activeCount: number
  submittedCount: number
  acceptedCount: number
}
export type VolunteerAllocation = {
  userId: string
  userName: string
  assignedCount: number
  skippedReason: string | null
}
export type AllocationResult = {
  results: VolunteerAllocation[]
  assignedCount: number
  totalRequested: number
}

const nonnegativeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

export function readVolunteers(payload: unknown): RegisteredVolunteer[] {
  if (!payload || typeof payload !== 'object' || !('volunteers' in payload) || !Array.isArray(payload.volunteers)) throw new Error('志愿者列表加载异常，请重试')
  const ids = new Set<string>()
  return payload.volunteers.map((row) => {
    if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id) || typeof row.name !== 'string') throw new Error('志愿者资料格式异常，请重新加载')
    ids.add(row.id)
    for (const field of ['assignedCount', 'activeCount', 'submittedCount', 'acceptedCount']) {
      if (!nonnegativeInteger(row[field])) throw new Error('志愿者任务统计异常，请重新加载')
    }
    // Project only the fields needed for allocating work. Identity and banking
    // details must never enter this component's state or rendered markup.
    return { id: row.id, name: row.name || '志愿者', entryCode: typeof row.entryCode === 'string' ? row.entryCode : undefined, entryName: typeof row.entryName === 'string' ? row.entryName : undefined, entryChannel: typeof row.entryChannel === 'string' ? row.entryChannel : undefined, assignedCount: row.assignedCount, activeCount: row.activeCount, submittedCount: row.submittedCount, acceptedCount: row.acceptedCount }
  })
}

export function filterVolunteers(volunteers: RegisteredVolunteer[], search: string) {
  const query = search.trim().toLocaleLowerCase()
  return query ? volunteers.filter((volunteer) => `${volunteer.name} ${volunteer.id} ${volunteer.entryCode || ''} ${volunteer.entryName || ''}`.toLocaleLowerCase().includes(query)) : volunteers
}

export function validateAllocationSelection(userIds: string[], count: number): void {
  if (!userIds.length) throw new Error('请先选择志愿者')
  if (userIds.length > MAX_ASSIGNEES) throw new Error(`每次最多分配给 ${MAX_ASSIGNEES} 位志愿者`)
  if (new Set(userIds).size !== userIds.length || userIds.some(id => !id)) throw new Error('志愿者选择重复，请重新选择')
  if (count !== 1 && count !== 2) throw new Error('每位志愿者只能分配 1 或 2 句')
}

export function readAllocationResult(payload: unknown, userIds: string[], count: 1 | 2): AllocationResult {
  validateAllocationSelection(userIds, count)
  const invalid = () => new Error('未能确认完整分配结果，请刷新任务统计后查看')
  if (!payload || typeof payload !== 'object' || !('results' in payload) || !Array.isArray(payload.results)) throw invalid()
  const expectedIds = new Set(userIds)
  if (payload.results.length !== expectedIds.size) throw invalid()
  const results: VolunteerAllocation[] = payload.results.map((row) => {
    if (!row || !expectedIds.delete(row.userId) || typeof row.userName !== 'string' || !nonnegativeInteger(row.assignedCount) || row.assignedCount > count || !Array.isArray(row.assignments) || row.assignments.length !== row.assignedCount || (row.skippedReason != null && typeof row.skippedReason !== 'string')) throw invalid()
    return { userId: row.userId, userName: row.userName || '志愿者', assignedCount: row.assignedCount, skippedReason: row.skippedReason || (row.assignedCount < count ? '当前符合条件的句子不足，已有任务保持不变。' : null) }
  })
  const assignedCount = results.reduce((total, row) => total + row.assignedCount, 0)
  if (!('assignedCount' in payload) || payload.assignedCount !== assignedCount || !('totalRequested' in payload) || payload.totalRequested !== userIds.length * count) throw invalid()
  return { results, assignedCount, totalRequested: payload.totalRequested }
}

export async function loadRegisteredVolunteers(signal?: AbortSignal): Promise<RegisteredVolunteer[]> {
  return readVolunteers(await request('/api/admin/volunteers', { signal, headers: { 'X-Admin-Key': getAdminKey() } }))
}

export async function allocateArticleVolunteers(articleId: string, userIds: string[], count: 1 | 2): Promise<AllocationResult> {
  validateAllocationSelection(userIds, count)
  const result = await request(`/api/admin/articles/${encodeURIComponent(articleId)}/assign`, {
    method: 'POST', headers: { 'X-Admin-Key': getAdminKey() }, body: JSON.stringify({ userIds, count }),
  })
  return readAllocationResult(result, userIds, count)
}
