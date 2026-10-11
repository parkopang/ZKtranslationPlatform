export type WorkspaceRole = 'admin' | 'translator'
export function workspaceRole(search: string, saved: string | null): WorkspaceRole {
  const explicit = new URLSearchParams(search).get('workspace')
  return explicit === 'admin' || explicit === 'translator' ? explicit : saved === 'admin' ? 'admin' : 'translator'
}
