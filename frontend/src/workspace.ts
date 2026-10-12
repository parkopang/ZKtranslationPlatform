export type WorkspaceRole = 'admin' | 'translator'

export type WorkspaceChannel = 'web' | 'wechat-public-account' | 'wechat-mini-program'

export type WorkspaceEntry = {
  role: WorkspaceRole
  isDoctor: boolean
  channel: WorkspaceChannel
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
  const isDoctor = entry === 'doctor' || entry === 'official-account' || entry === 'miniprogram' || entry === 'mini-program' || /^\/doctor(?:\/|$)/.test(pathname)
  const resolvedChannel: WorkspaceChannel = channel === 'mini-program' || channel === 'wechat-mini-program' || entry === 'miniprogram' || entry === 'mini-program'
    ? 'wechat-mini-program'
    : channel === 'public-account' || channel === 'wechat-public-account' || entry === 'official-account'
      ? 'wechat-public-account'
      : 'web'
  return { role: workspaceRole(search, null), isDoctor, channel: isDoctor ? resolvedChannel : 'web' }
}
