import { useEffect, useRef, useState } from 'react'
import { ArrowsClockwise, CaretRight, Globe, GitBranch, PencilSimple, Plus, X } from '@phosphor-icons/react'
import { requestJSON as request } from './console-fetch.js'
import './secondary-sites.css'
import { Paginated } from './pagination.jsx'
import { RouteBindingEditor } from './route-bindings.jsx'
import RouteWorkspace from './route-workspace.jsx'
import { routeHref } from './route-navigation.js'
import { cachedDataLabel, readViewCache, writeViewCache, viewCacheGeneration } from './view-cache.js'


const time = value => new Date(value).toLocaleString('zh-CN', { hour12: false })

function ConnectionEditor({ initial, onSave, onClose, SecretField }) {
  const dialog = useRef(null)
  const [name, setName] = useState(initial.name || '')
  const [endpoint, setEndpoint] = useState(initial.endpoint || '')
  const [token, setToken] = useState('')
  const [autoPush, setAutoPush] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const element = dialog.current
    element.showModal()
    return () => element.close()
  }, [])
  async function submit(event) {
    event.preventDefault()
    if (saving) return
    setSaving(true); setError('')
    try { await onSave({ name: name.trim(), endpoint: endpoint.trim(), token, provider: 'sub2api', id: initial.id, ...(!initial.id ? { autoPush } : {}) }) }
    catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }
  return <dialog ref={dialog} className="add-modal rate-editor" aria-labelledby="secondary-editor-title" onCancel={event => { event.preventDefault(); if (!saving) onClose() }}>
    <form onSubmit={submit}>
      <div className="modal-head"><div><span className="eyebrow">SUB2API · ADMIN</span><h2 id="secondary-editor-title">{initial.id ? '编辑调度站点' : '添加调度站点'}</h2></div>
        <button type="button" className="icon-button" aria-label="关闭" disabled={saving} onClick={onClose}><X size={18}/></button></div>
      <fieldset className="connection-fields" disabled={saving}>
        <label>调度站点名称<input name="secondary-name" autoFocus required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="输入调度站点名称"/></label>
        <label>调度站点地址<input name="secondary-endpoint" required type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://sub.example.com"/></label>
        <SecretField name="secondary-admin-key" label="Admin API Key" value={token} onChange={event => setToken(event.target.value)} required={!initial.id || endpoint.trim() !== initial.endpoint}
          placeholder={initial.id ? '留空保留当前管理员密钥' : '粘贴 Sub2API 管理员 API Key'}
          hint="使用调度站点系统设置中的管理员 API Key，通常以 admin- 开头；用户模型调用密钥不适用。"/>
        {!initial.id && <label className="auto-probe-option"><input type="checkbox" checked={autoPush} onChange={event=>setAutoPush(event.target.checked)}/><span>自动推送稳定线路<small className="field-hint">按已有分组匹配倍率达标的上游，所有验证正常的线路参与调度；URL / Key 与目标分组匹配的账号统一自动管理。</small></span></label>}
      </fieldset>
      {error && <p className="site-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="cancel-button" disabled={saving} onClick={onClose}>取消</button>
        <button type="submit" className="probe-button" disabled={saving}><ArrowsClockwise size={15}/>{saving ? '正在验证并同步…' : '保存并同步'}</button></div>
    </form>
  </dialog>
}


export default function SecondarySites({ SecretField, page = 'secondary-channels', siteId, groupId }) {
  const [cached] = useState(() => readViewCache('/api/secondary-sites'))
  const cacheGeneration = useRef(viewCacheGeneration())
  const [cachedAt, setCachedAt] = useState(cached?.savedAt ?? null)
  const [sites, setSites] = useState(cached?.data.sites ?? [])
  const sitesRef = useRef(sites)
  const [loading, setLoading] = useState(!cached)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [editing, setEditing] = useState(null)
  const [busy, setBusy] = useState([])
  const [binding, setBinding] = useState(null)
  const requestGeneration = useRef(0)
  function acceptSites(sites) {
    if (!Array.isArray(sites)) throw new Error('调度站点数据格式无效，已保留上次结果。')
    sitesRef.current = sites
    setSites(sites); setCachedAt(null)
    writeViewCache('/api/secondary-sites', { sites }, cacheGeneration.current)
  }
  useEffect(() => {
    const controller = new AbortController()
    const generation = ++requestGeneration.current
    setError('')
    request('/api/secondary-sites', null, controller.signal).then(data => { if (!controller.signal.aborted && generation === requestGeneration.current) acceptSites(data.sites) })
      .catch(err => { if (!controller.signal.aborted) setError(err.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [reload])
  useEffect(() => {
    if (editing || binding || page === 'route-discovery' || busy.length) return
    const controller = new AbortController()
    let timer
    async function refresh() {
      // Compare with the generation at request start. Capturing it when the
      // effect mounts would discard every later poll after an automation edit.
      const generation = requestGeneration.current
      try {
        const data = await request('/api/secondary-sites', null, controller.signal)
        if (!controller.signal.aborted && generation === requestGeneration.current) { acceptSites(data.sites); setError('') }
      } catch (err) { if (!controller.signal.aborted) setError(err.message) }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 15000)
    }
    timer = setTimeout(refresh, 15000)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [editing, binding, page, busy, reload])
  function update(site) {
    requestGeneration.current++
    const current = sitesRef.current
    acceptSites(current.some(item => item.id === site.id) ? current.map(item => item.id === site.id ? site : item) : [...current, site])
  }
  async function sync(site) {
    setBusy(current => [...current, site.id])
    try { update((await request(`/api/secondary-sites/${site.id}/sync`, {})).site) }
    catch (err) { setSites(current => current.map(item => item.id === site.id ? { ...item, error: err.message } : item)) }
    finally { setBusy(current => current.filter(id => id !== site.id)) }
  }
  return <div className="site-page secondary-sites-page">
    {page === 'secondary-channels' && <div className="site-toolbar"><div><h2>调度站点连接</h2><p>Sub2API · 管理员</p></div>
      <button className="probe-button" onClick={() => setEditing({})}><Plus size={16}/>添加调度站点</button></div>}
    {loading && <p className="site-message" role="status">正在读取调度站点…</p>}
    {cachedAt && <p className="cached-data-note">{cachedDataLabel(cachedAt)}</p>}
    {error && <div className="site-error" role="alert">{error}<button onClick={() => setReload(value => value + 1)}>重试</button></div>}
    {page !== 'secondary-channels' && (!loading || sites.length > 0) && <RouteWorkspace sites={sites} page={page} siteId={siteId} groupId={groupId}
      onChange={update} busy={busy.includes(siteId || sites[0]?.id)} onSync={sync} onEdit={selection => setBinding({ siteId: siteId || sites[0]?.id, ...selection })}
      onUse={(row, account) => setBinding({ siteId: siteId || sites[0]?.id, kind: 'account', accountId: account.id, name: account.name,
        recommendation: { upstreamId: row.upstreamId, tokenId: row.tokenId } })}/>}
    {page === 'secondary-channels' && !loading && !error && !sites.length && <div className="site-empty"><Globe size={34}/><h3>还没有调度站点</h3><p>暂无 Sub2API 调度站点连接</p></div>}
    {page === 'secondary-channels' && <Paginated items={sites} label="调度站点" always>{rows => rows.map(site => <section className="secondary-site" key={site.id} aria-label={site.name}>
      <div className="site-heading"><div className="site-identity"><div className="provider-icon cyan">S</div>
        <div><h3>{site.name}<span>Sub2API</span></h3><p>{site.endpoint}</p></div></div>
        <div className="site-actions"><a className="outline-button" href={routeHref('route-automation', site.id)}><GitBranch size={15}/>线路管理</a><button className="outline-button" disabled={busy.includes(site.id)} onClick={() => setEditing(site)}><PencilSimple size={15}/>编辑连接</button>
          <button className="outline-button" disabled={busy.includes(site.id)} onClick={() => sync(site)}><ArrowsClockwise size={15}/>{busy.includes(site.id) ? '同步中…' : '同步调度站点'}</button></div></div>
      <div className="site-meta"><a className={`site-automation-link${site.automation?.enabled ? ' enabled' : ''}`} href={routeHref('route-automation', site.id)}
        aria-label={`自动调度：${site.automation?.enabled ? '已开启' : '未开启'}，查看调度设置`}>
        <span>自动调度</span><span className="site-automation-state"><i aria-hidden="true"/>{site.automation?.enabled ? '已开启' : '未开启'}</span><CaretRight size={13} aria-hidden="true"/>
      </a><span>{site.groups.length} 个分组</span><span>{site.accountsSyncedAt ? `${site.accounts.length} 个账号` : '账号尚未同步'}</span>
        <span>{site.syncedAt ? `分组同步：${time(site.syncedAt)}` : '分组尚未同步'}</span>
        {site.accountsSyncedAt && <span>账号同步：{time(site.accountsSyncedAt)}</span>}</div>
      {site.error && <p className="site-error" role="alert">{site.error}{site.syncedAt && ' 保留上次分组快照，可在线路管理中查看。'}</p>}
      {site.accountsError && <p className="site-error" role="alert">账号同步未完成：{site.accountsError}{site.accountsSyncedAt && ' 保留上次账号快照，可在高级维护中查看。'}</p>}
      <div className="site-next-step"><p>{site.automation?.enabled ? '后台自动匹配分组，全部达标线路参与调度，异常隔离后持续复测。' : '自动推送未开启，上游探测可独立运行。'}</p><a href={routeHref('route-bindings', site.id)}>查看分组倍率与模型状态<CaretRight size={15}/></a></div>
    </section>)}</Paginated>}
    {editing && <ConnectionEditor key={editing.id || 'new'} initial={editing} SecretField={SecretField} onClose={() => setEditing(null)} onSave={async values => {
      update((await request('/api/secondary-sites', values)).site)
      setEditing(null)
    }}/>}
    {binding && <RouteBindingEditor site={sites.find(site => site.id === binding.siteId)} selection={binding} onClose={() => setBinding(null)} onSave={async input => {
      update((await request(`/api/secondary-sites/${binding.siteId}/bindings`, input)).site)
      setBinding(null)
    }}/>}
  </div>
}
