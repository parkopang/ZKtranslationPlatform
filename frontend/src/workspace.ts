export type WorkspaceRole = 'admin' | 'translator'

export type WorkspaceChannel = 'web' | 'wechat-public-account' | 'wechat-mini-program'

export type WorkspaceEntry = {
  role: WorkspaceRole
  isDoctor: boolean
  channel: WorkspaceChannel
  /** Stable identifier assigned by an administrator for a public-account or mini-program entry. */
  entryCode?: string
  /** Human-readable label supplied by the administrator and carried in the link. */
  entryName?: string
}

export function workspaceRole(search: string, saved: string | null, pathname = ''): WorkspaceRole {
  const explicit = new URLSearchParams(search).get('workspace')
  if (!explicit && /^\/doctor(?:\/|$)/.test(pathname)) return 'translator'
  return explicit === 'admin' || explicit === 'translator' ? explicit : saved === 'admin' ? 'admin' : 'translator'
}

/**
 * The doctor workspace is a normal web route so WeChat public-account menus
 * and mini-program web-view buttons can share one URL. Keep channel parsing
 * here so the app does not depend on WeChat JavaScript APIs and remains usable
 * in a desktop browser and in an embedded web-view.
 */
export function workspaceEntry(search: string, pathname = ''): WorkspaceEntry {
  const params = new URLSearchParams(search)
  const entry = (params.get('entry') || '').trim().toLowerCase()
  const channel = (params.get('channel') || '').trim().toLowerCase()
  const explicitEntryCode = (params.get('entryCode') || params.get('entry_code') || params.get('source') || '').trim()
  const entryName = (params.get('entryName') || params.get('entry_name') || '').trim().slice(0, 120) || undefined
  const isDoctor = entry === 'doctor' || entry === 'official-account' || entry === 'miniprogram' || entry === 'mini-program' || /^\/doctor(?:\/|$)/.test(pathname)
  const reservedEntries = new Set(['', 'doctor', 'official-account', 'miniprogram', 'mini-program'])
  const entryCode = (explicitEntryCode || (isDoctor && !reservedEntries.has(entry) ? entry : '')).slice(0, 80) || undefined
  const resolvedChannel: WorkspaceChannel = channel === 'mini-program' || channel === 'wechat-mini-program' || entry === 'miniprogram' || entry === 'mini-program'
    ? 'wechat-mini-program'
    : channel === 'public-account' || channel === 'wechat-public-account' || entry === 'official-account'
      ? 'wechat-public-account'
      : 'web'
  return { role: workspaceRole(search, null), isDoctor, channel: isDoctor ? resolvedChannel : 'web', entryCode, entryName }
}
