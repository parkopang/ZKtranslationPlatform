import { useMemo, useState } from 'react'
import { Check, CheckCircle2, Clipboard, ExternalLink, Link2, Plus, RefreshCw, Save, X } from 'lucide-react'
import { api, entryChannelLabel, type EntryChannel, type WorkspaceEntryConfig } from './api'
import './entry-management.css'

type EntryForm = Pick<WorkspaceEntryConfig, 'name' | 'code' | 'channel' | 'url' | 'enabled'>

const defaultForm: EntryForm = { name: '', code: '', channel: 'wechat-public-account', url: '', enabled: true }

function defaultEntryUrl(form: Pick<EntryForm, 'channel' | 'code'>): string {
  const channel = form.channel === 'wechat-mini-program' ? 'mini-program' : form.channel === 'wechat-public-account' ? 'public-account' : 'web'
  const base = `${window.location.origin}/doctor`
  return `${base}?entry=${encodeURIComponent(form.code.trim())}&channel=${channel}`
}

function normalizedUrl(form: EntryForm): string {
  return form.url.trim() || (form.code.trim() ? defaultEntryUrl(form) : '')
}

export function EntryManagement({ entries, error, onChanged }: { entries: WorkspaceEntryConfig[]; error?: string; onChanged: (entry: WorkspaceEntryConfig) => void }) {
  const [form, setForm] = useState<EntryForm>(defaultForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [formError, setFormError] = useState('')
  const [copiedId, setCopiedId] = useState('')
  const sorted = useMemo(() => [...entries].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)), [entries])

  const reset = () => { setEditingId(null); setForm(defaultForm); setFormError('') }
  const edit = (entry: WorkspaceEntryConfig) => { setEditingId(entry.id); setForm({ name: entry.name, code: entry.code, channel: entry.channel, url: entry.url, enabled: entry.enabled }); setFormError(''); window.scrollTo({ top: 0, behavior: 'smooth' }) }

  const save = async () => {
    if (busy) return
    if (!form.name.trim() || !form.code.trim()) { setFormError('请填写入口名称和唯一标识'); return }
    setBusy(true); setFormError(''); setNotice('')
    try {
      const payload = { ...form, name: form.name.trim(), code: form.code.trim(), url: normalizedUrl(form) }
      const result = editingId ? await api.updateEntryConfig(editingId, payload) : await api.createEntryConfig(payload)
      onChanged(result)
      setNotice(editingId ? '入口配置已更新' : '入口配置已创建')
      reset()
    } catch (error) { setFormError(error instanceof Error ? error.message : '入口配置保存失败，请稍后重试') }
    finally { setBusy(false) }
  }

  const toggle = async (entry: WorkspaceEntryConfig) => {
    if (busy) return
    setBusy(true); setFormError(''); setNotice('')
    try { onChanged(await api.updateEntryConfig(entry.id, { enabled: !entry.enabled })); setNotice(`${entry.name} 已${entry.enabled ? '停用' : '启用'}`) }
    catch (error) { setFormError(error instanceof Error ? error.message : '入口状态更新失败，请稍后重试') }
    finally { setBusy(false) }
  }

  const copy = async (entry: WorkspaceEntryConfig) => {
    const value = normalizedUrl(entry)
    try {
      await navigator.clipboard.writeText(value)
      setCopiedId(entry.id); window.setTimeout(() => setCopiedId((current) => current === entry.id ? '' : current), 1800)
    } catch { setFormError('当前浏览器不允许复制，请手动选择链接') }
  }

  return <div className="admin-content entry-management">
    <div className="page-header"><div><span className="overline">渠道与入口</span><h1>微信入口管理</h1><p>为多个公众号、小程序分别建立入口标识，管理员可随时启停并复制专属链接。</p></div><button className="outline-button" onClick={reset} disabled={busy}><Plus size={15} />新增入口</button></div>
    <section className="entry-config-grid">
      <div className="panel entry-form-card"><div className="panel-header"><div><h3>{editingId ? '编辑入口' : '创建入口'}</h3><p>志愿者注册和后续任务会记录该入口来源。</p></div>{editingId && <button className="icon-button" aria-label="取消编辑" onClick={reset}><X size={17} /></button>}</div>
        <div className="entry-form-body">
          <label className="entry-field"><span>入口名称</span><input value={form.name} maxLength={80} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：华东医生公众号" /></label>
          <label className="entry-field"><span>唯一标识</span><input value={form.code} maxLength={80} disabled={Boolean(editingId)} onChange={(event) => setForm({ ...form, code: event.target.value.replace(/[^a-zA-Z0-9_-]/g, '') })} placeholder="例如：east-doctor-public" /><small>用于识别注册来源，只能使用字母、数字、下划线和短横线。</small></label>
          <label className="entry-field"><span>入口类型</span><select value={form.channel} onChange={(event) => setForm({ ...form, channel: event.target.value as EntryChannel })}><option value="wechat-public-account">微信公众号菜单</option><option value="wechat-mini-program">微信小程序 web-view</option><option value="web">普通网页登录</option></select></label>
          <label className="entry-field"><span>网页登录地址 <em>可选</em></span><input value={form.url} maxLength={500} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="留空自动生成当前站点的医生端链接" /></label>
          <label className="entry-switch"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /><span><b>启用入口</b><small>停用后新用户仍可查看历史来源，但不能从此入口注册。</small></span></label>
          {formError && <p className="entry-error" role="alert">{formError}</p>}
          <div className="entry-form-actions"><button className="outline-button" onClick={reset} disabled={busy}>清空</button><button className="primary-button" onClick={() => void save()} disabled={busy}>{busy ? <><RefreshCw size={14} className="entry-spin" />保存中…</> : <><Save size={14} />保存入口</>}</button></div>
        </div>
      </div>
      <div className="panel entry-guide-card"><div className="panel-header"><div><h3>接入指引</h3><p>复制链接后，在微信后台配置菜单或业务域名。</p></div><Link2 size={18} /></div><ol><li><strong>公众号</strong><span>将“网页登录地址”配置到自定义菜单，用户点击后会携带入口标识注册。</span></li><li><strong>小程序</strong><span>使用同一地址配置 web-view，并把域名加入业务域名白名单。</span></li><li><strong>核对来源</strong><span>管理员在志愿者审核和报表中可按入口标识区分来源。</span></li></ol></div>
    </section>
    {notice && <p className="entry-notice" role="status"><CheckCircle2 size={15} />{notice}</p>}
    {error && <p className="entry-error" role="alert">入口配置暂时无法同步：{error}</p>}
    <section className="panel entry-list-card"><div className="panel-header"><div><h3>已配置入口</h3><p>共 {entries.length} 个入口 · 仅启用的入口接受新注册</p></div></div><div className="entry-list">{sorted.map((entry) => { const url = normalizedUrl(entry); return <article className={`entry-row ${entry.enabled ? '' : 'disabled'}`} key={entry.id}><div className="entry-row-main"><span className={`entry-channel-icon ${entry.channel}`}><ExternalLink size={16} /></span><div><strong>{entry.name}</strong><span className="entry-code">{entry.code}</span><small>{entryChannelLabel(entry.channel)} · 最近更新 {entry.updatedAt || '—'}</small></div></div><div className="entry-row-url"><input aria-label={`${entry.name}链接`} readOnly value={url} onFocus={(event) => event.currentTarget.select()} /><button className="outline-button" onClick={() => void copy(entry)} disabled={!url}>{copiedId === entry.id ? <><Check size={14} />已复制</> : <><Clipboard size={14} />复制链接</>}</button></div><div className="entry-row-actions"><span className={`entry-state ${entry.enabled ? 'on' : 'off'}`}>{entry.enabled ? '已启用' : '已停用'}</span><button className="text-button" onClick={() => edit(entry)}>编辑</button><button className="text-button" onClick={() => void toggle(entry)} disabled={busy}>{entry.enabled ? '停用' : '启用'}</button></div></article> })}{!entries.length && <div className="entry-empty"><Link2 size={26} /><strong>还没有配置微信入口</strong><p>创建第一个入口后，公众号和小程序可以使用独立链接。</p></div>}</div></section>
  </div>
}
