import { useEffect, useRef, useState } from 'react'
import { ArrowsClockwise, CaretRight, CheckSquare, Link, LinkBreak, MagnifyingGlass, PencilSimple, X } from '@phosphor-icons/react'
import { requestJSON as routeRequest } from './console-fetch.js'
import './secondary-sites.css'
import { Paginated } from './pagination.jsx'
import { routeHref } from './route-navigation.js'


const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂无'
const bindingLabels = { confirmed: '已确认关联', changed: '配置变化，待确认', missing: '关联对象已失效', stale: '快照过期，请同步' }
const probeLabels = { ok: '探测通过', error: '探测失败', inconclusive: '结果未确定', stale: '探测已过期',
  unknown: '等待探测', disabled: '探测未启用', excluded: '模型已隔离', unsupported: '协议暂不支持', paused: '探测暂停', missing: '模型或令牌已失效' }

function BindingStatus({ status, source }) {
  return <span className={`rb-status ${status === 'confirmed' ? 'confirmed' : status ? 'review' : ''}`}>{status === 'confirmed' && source === 'automation' ? '自动调度接管' : status === 'confirmed' && source === 'auto' ? '已自动关联' : bindingLabels[status] || '未关联'}</span>
}

function Models({ models }) {
  return <Paginated items={models} label="账号模型">{rows => <div className="table-scroll"><table className="group-rates-table rb-model-table">
    <thead><tr><th>调度站点模型 / 上游模型</th><th>上游直测状态</th><th>近 1 小时成功率</th><th>最近成功 / 检测</th><th>异常信息</th></tr></thead>
    <tbody>{rows.map(model => <tr key={JSON.stringify([model.model, model.protocol])}>
      <td><b>{model.model}</b><span className="group-description">{model.upstreamModel} · {model.protocol}</span></td>
      <td><span className={`rb-status ${model.status}`}>{probeLabels[model.status]}</span>{!model.eligible && <span className="group-description">不计入分组候选</span>}</td>
      <td>{model.successRate == null ? '暂无' : `${model.successRate.toFixed(2)}%`}<span className="group-description">{model.success} 成功 · {model.failed} 失败</span></td>
      <td><span>{time(model.lastSuccessAt)}</span><span className="group-description">检测：{time(model.lastProbeAt)}</span></td>
      <td className="rb-error">{model.error || model.reason || '无'}{model.latencyMs != null && <span className="group-description">{model.latencyMs} ms</span>}</td>
    </tr>)}</tbody>
  </table></div>}</Paginated>
}

function BindingDetail({ title, meta, children, actions, onClose }) {
  const dialog = useRef(null)
  useEffect(() => { const element = dialog.current; element.showModal(); return () => element.close() }, [])
  return <dialog ref={dialog} className="rd-detail rb-detail" aria-labelledby="rb-detail-title" onCancel={event => { event.preventDefault(); onClose() }}>
    <div className="rd-detail-head"><div><span>{meta}</span><h2 id="rb-detail-title">{title}</h2></div>
      <button type="button" className="icon-button" aria-label="关闭详情" title="关闭详情" onClick={onClose}><X size={20}/></button></div>
    <div className="rd-detail-body">{children}</div>
    <div className="rd-detail-footer">{actions}</div>
  </dialog>
}

const routeAvailable = route => route.eligible && route.status === 'ok'
const protocolNames = { responses: 'Responses', chat: 'Chat Completions', messages: 'Anthropic', gemini: 'Gemini' }

function routeUnavailableReason(route, group, account) {
  if (!route.eligible) {
    if (group.status !== 'active') return '分组未启用'
    if (route.bindingStatus !== 'confirmed') return bindingLabels[route.bindingStatus] || '关联尚未确认'
    if (account?.status === 'error') return '调度账号异常'
    if (account?.status && account.status !== 'active') return '调度账号未启用'
    if (account?.schedulable === false) return '账号未开启调度'
    if ([account?.cooldownUntil, account?.rateLimitUntil, account?.overloadUntil].some(at => Date.parse(at) > Date.now())) return '调度账号冷却中'
    return '暂不满足分组调度条件'
  }
  return probeLabels[route.status] || '等待状态确认'
}

function GroupModelRoutes({ model, group, accounts }) {
  const [open, setOpen] = useState(false)
  const available = model.routes.filter(routeAvailable), other = model.routes.filter(route => !routeAvailable(route))
  const [showOther, setShowOther] = useState(!available.length)
  function renderRoute(route) {
    const ready = routeAvailable(route)
    const reason = ready ? null : routeUnavailableReason(route, group, accounts.find(account => account.id === route.accountId))
    return <li key={route.accountId} className={ready ? 'is-available' : 'is-unavailable'}>
      <div className="rb-route-name"><b>{route.accountName}</b>
        <small>账号 #{route.accountId} · 令牌 #{route.tokenId}</small>
        {route.tokenName && route.tokenName !== route.accountName && <small>上游：{route.tokenName}</small>}</div>
      <div className="rb-route-result"><span className={`rb-status ${ready ? 'ok' : route.status === 'error' ? 'error' : 'review'}`}>{ready ? '可调度' : reason}</span>
        <small>{route.lastProbeAt ? <time dateTime={route.lastProbeAt} title={time(route.lastProbeAt)}>{new Date(route.lastProbeAt).toLocaleTimeString('zh-CN', { hour12: false })} 检测</time> : '尚无探测记录'}
          {route.latencyMs != null && ` · ${Math.round(route.latencyMs)} ms`}</small></div>
      {!ready && <p className="rb-route-reason">{!route.eligible && <>{probeLabels[route.status] || '探测状态未知'}{route.error ? ' · ' : ''}</>}{route.error || (route.eligible ? '复测通过且满足调度条件后可用。' : '')}</p>}
    </li>
  }
  return <details className="rb-group-model" open={open} onToggle={event => {
    if (event.target === event.currentTarget && event.currentTarget.open !== open) setOpen(event.currentTarget.open)
  }}>
    <summary aria-label={`查看 ${model.model} 的上游线路`}>
      <CaretRight size={16} className="rb-model-caret" aria-hidden="true"/>
      <span className="rb-model-title"><b>{model.model}</b><small>{protocolNames[model.protocol] || model.protocol} · {model.routes.length} 条关联线路</small></span>
      <span className="rb-model-availability"><b className={`rb-status ${available.length ? 'ok' : 'review'}`}>{available.length ? `${available.length} 条可用` : '暂无可用线路'}</b>
        {!!available.length && !!other.length && <small>{other.length} 条暂不可用</small>}</span>
    </summary>
    {open && <div className="rb-model-expanded">
      {!!available.length && <><p className="rb-route-list-label">可用线路 <span>{model.independentTokens} 个独立令牌</span></p>
        <Paginated items={available} label={`${model.model} 可用线路`}>{rows => <ul className="rb-model-routes" aria-label={`${model.model} 的上游线路`}>{rows.map(renderRoute)}</ul>}</Paginated></>}
      {!!other.length && <details className="rb-model-other" open={showOther} onToggle={event => {
        if (event.target === event.currentTarget && event.currentTarget.open !== showOther) setShowOther(event.currentTarget.open)
      }}><summary><CaretRight size={14} aria-hidden="true"/><span>暂不可用线路 <b>{other.length}</b></span><small>{showOther ? '收起原因' : '查看原因'}</small></summary>
        {showOther && <Paginated items={other} label={`${model.model} 暂不可用线路`}>{rows => <ul className="rb-model-routes" aria-label={`${model.model} 的${available.length ? '暂不可用' : '上游'}线路`}>{rows.map(renderRoute)}</ul>}</Paginated>}
      </details>}
    </div>}
  </details>
}

function GroupModelStatus({ models, group, accounts }) {
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all')
  const available = models.filter(model => model.routes.some(routeAvailable)).length
  const visible = models.filter(model => model.model.toLowerCase().includes(query.trim().toLowerCase()) &&
    (filter === 'all' || model.routes.some(routeAvailable) === (filter === 'available')))
  return <section className="rb-model-status" aria-label="分组模型状态">
    <h3>模型状态 <span><b>{available}</b> / {models.length} 个模型有可用线路</span></h3>
    <p className="rb-model-help">可用线路需同时满足：探测通过、账号参与调度、关联有效。</p>
    {!!models.length && <div className="rb-model-tools"><label className="rb-model-search"><MagnifyingGlass size={16} aria-hidden="true"/><input type="search" aria-label="搜索分组内模型" placeholder="搜索模型名称" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <div className="rb-model-filters" role="group" aria-label="模型可用性筛选">{[['all', '全部', models.length], ['available', '有可用线路', available], ['unavailable', '暂无可用', models.length - available]].map(([key, label, count]) =>
        <button type="button" key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}<span>{count}</span></button>)}</div></div>}
    <Paginated items={visible} resetKey={JSON.stringify([query, filter])} label="分组模型">{rows => <div className="rb-group-models">{rows.map(model => <GroupModelRoutes key={JSON.stringify([model.model, model.protocol])} model={model} group={group} accounts={accounts}/>)}</div>}</Paginated>
    {!visible.length && <p className="rb-model-empty">{models.length ? '没有符合条件的模型' : '暂无关联模型'}</p>}
  </section>
}

export function AccountRoutes({ site, initialGroupId, onEdit, disabled }) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [groupId, setGroupId] = useState(initialGroupId || '')
  const [selected, setSelected] = useState(null)
  useEffect(() => setGroupId(initialGroupId || ''), [initialGroupId])
  const routes = site.routes
  if (!routes) return null
  const accounts = routes.accounts.filter(account => {
    const text = [account.name, account.id, account.binding?.upstreamName, account.binding?.tokenName].join(' ').toLowerCase()
    return text.includes(search.trim().toLowerCase()) && (!groupId || site.accounts.find(item => item.id === account.id)?.groupIds.includes(Number(groupId))) &&
      (filter === 'all' || (filter === 'unbound' ? !account.binding : filter === 'confirmed' ? account.binding?.status === 'confirmed' : account.binding && account.binding.status !== 'confirmed'))
  })
  const detail = routes.accounts.find(account => account.id === selected)
  const edit = account => { setSelected(null); onEdit({ kind: 'account', accountId: account.id, name: account.name }) }
  return <div className="rb-accounts">
    <h2 className="sr-only">账号关联</h2>
    <p className="rb-detail-meta">同步调度站点后，按 URL 和完整 Key 自动匹配唯一上游令牌；模型状态随探针结果更新。</p>
    <div className="rw-filters"><label className="rw-search"><MagnifyingGlass size={17}/><input type="search" aria-label="搜索账号或令牌" placeholder="搜索账号、上游或令牌" value={search} onChange={event => setSearch(event.target.value)}/></label>
      <select aria-label="按调度站点分组筛选账号" value={groupId} onChange={event => setGroupId(event.target.value)}><option value="">全部分组</option>{site.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select>
      <select aria-label="关联状态" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部状态</option><option value="unbound">未关联</option><option value="confirmed">已确认</option><option value="review">待复核</option></select>
      <span>{accounts.length} / {routes.accounts.length} 个账号</span></div>
    {!routes.accounts.length && <p className="site-message">暂无调度站点账号。</p>}
    {routes.accounts.length > 0 && !accounts.length && <p className="rw-empty">没有匹配的账号</p>}
    <Paginated items={accounts} resetKey={JSON.stringify([site.id, search, filter, groupId])} label="调度账号" always>{rows => !!accounts.length && <div className="table-scroll"><table className="rw-account-table"><thead><tr><th>调度站点账号</th><th>上游 / 令牌</th><th>关联状态</th><th><span className="sr-only">操作</span></th></tr></thead>
      <tbody>{rows.map(account => <tr className="rb-account" key={account.id}>
        <td><button type="button" className="rw-name" title={account.name} onClick={() => setSelected(account.id)}>{account.name}</button></td>
        <td><span className="rw-cell-text" title={account.binding ? account.binding.tokenName : undefined}>
          {account.binding ? account.binding.tokenName : <span className="rb-unbound">尚未关联上游令牌</span>}</span>
          {account.autoMatchReason && <span className="group-description">{account.autoMatchReason}</span>}</td>
        <td><BindingStatus status={account.binding?.status} source={account.binding?.source}/></td>
        <td><button type="button" className="icon-button" title={account.binding ? '编辑关联' : '关联令牌'} disabled={disabled} aria-label={`关联账号 ${account.name}`} onClick={() => edit(account)}><PencilSimple size={16}/></button></td>
      </tr>)}</tbody></table></div>}</Paginated>
    <Paginated items={routes.orphanBindings} label="失效关联">{rows => rows.map(binding => <div className="rb-orphan" key={binding.accountId}>
      <span>已移除账号：{binding.accountName} #{binding.accountId} · {binding.tokenName}</span>
      <button className="outline-button" disabled={disabled} onClick={() => onEdit({ kind: 'account', accountId: binding.accountId, name: binding.accountName, orphan: true })}><LinkBreak size={15}/>清理关联</button>
    </div>)}</Paginated>
    {detail && <BindingDetail title={detail.name} meta={`账号 #${detail.id} · ${detail.platform} · ${detail.type}`} onClose={() => setSelected(null)}
      actions={<button className="probe-button" disabled={disabled} onClick={() => edit(detail)}><PencilSimple size={16}/>{detail.binding ? '编辑关联' : '关联令牌'}</button>}>
      <section><h3>账号状态</h3><p className="rb-detail-meta">{detail.status === 'active' ? '已启用' : '未启用'} · {detail.schedulable === true ? '参与调度' : '未参与调度'}</p></section>
      <section><h3>上游令牌 <BindingStatus status={detail.binding?.status} source={detail.binding?.source}/></h3>
        {detail.binding ? <><p>{detail.binding.tokenName}</p>
          <p className="rb-detail-meta">{detail.binding.endpoint || '上游已移除'}</p><p className="rb-detail-meta">{detail.binding.source === 'auto' ? '匹配依据：URL 与完整 Key 一致。调度站点同步：' : '关联确认：'}{time(detail.binding.confirmedAt)}</p></> : <p className="rb-unbound">尚未关联上游令牌</p>}
        {detail.autoMatchReason && <p className="rb-detail-meta">{detail.autoMatchReason}</p>}</section>
      <section><h3>模型状态 <span>{detail.models.length} 个模型</span></h3>{detail.models.length ? <Models models={detail.models}/> : <p className="rb-unbound">暂无关联模型</p>}</section>
    </BindingDetail>}
  </div>
}

export function GroupRoutes({ site, initialGroupId }) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [groupId, setGroupId] = useState(initialGroupId || '')
  const [selected, setSelected] = useState(null)
  useEffect(() => setGroupId(initialGroupId || ''), [initialGroupId])
  const groups = site.groups.filter(group => {
    const routes = site.routes?.groups.find(item => item.groupId === group.id)
    const available = routes?.models.some(model => model.passed > 0)
    return (!groupId || String(group.id) === groupId) && group.name.toLowerCase().includes(search.trim().toLowerCase()) &&
      (filter === 'all' || (filter === 'available' ? available : !available))
  })
  const detail = site.groups.find(group => group.id === selected)
  const detailRoutes = site.routes?.groups.find(group => group.groupId === selected)
  return <section className="rw-groups" aria-label="分组状态">
    <h2 className="sr-only">分组状态</h2>
    <div className="rw-filters"><label className="rw-search"><MagnifyingGlass size={17}/><input type="search" aria-label="搜索分组" placeholder="搜索调度站点分组" value={search} onChange={event => setSearch(event.target.value)}/></label>
      <select aria-label="分组线路状态" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部状态</option><option value="available">有可用线路</option><option value="unavailable">暂无可用线路</option></select>
      {groupId && <button className="text-button" onClick={() => { window.location.hash = routeHref('route-bindings', site.id) }}>查看全部分组</button>}
      <span>{groups.length} / {site.groups.length} 个分组</span></div>
    <Paginated items={groups} resetKey={JSON.stringify([site.id, search, filter, groupId])} label="调度分组" always>{rows => <div className="table-scroll"><table className="rw-group-table"><thead><tr><th>调度站点分组 / 倍率</th><th>模型通过</th><th>账号</th><th>线路状态</th><th><span className="sr-only">操作</span></th></tr></thead>
      <tbody>{rows.map(group => {
        const routes = site.routes?.groups.find(item => item.groupId === group.id)
        const available = routes?.models.filter(model => model.passed > 0).length || 0
        return <tr key={group.id}>
          <td><button type="button" className="rw-name" title={group.name} onClick={() => setSelected(group.id)}>{group.name}</button><span className="group-description">{group.platform || "未知平台"} · {group.rate == null ? "倍率未确认" : `${group.rate}×`} · {group.status === "active" ? "已启用" : "已停用"}</span></td>
          <td>{available} / {routes?.models.length || 0}</td>
          <td>{site.accounts.filter(account => account.groupIds.includes(group.id)).length}<span className="group-description">{routes?.unboundAccounts || 0} 未关联 · {routes?.reviewAccounts || 0} 待确认</span></td>
          <td><span className={`rb-status ${available ? 'ok' : 'review'}`}>{available ? '有可用线路' : '暂无可用线路'}</span></td>
          <td><button type="button" className="icon-button" title="查看分组线路" aria-label={`查看分组线路 ${group.name}`} onClick={() => setSelected(group.id)}><CaretRight size={16}/></button></td>
        </tr>
      })}</tbody></table></div>}</Paginated>
    {!groups.length && <p className="rw-empty">没有匹配的分组</p>}
    {detail && <BindingDetail title={detail.name} meta={`分组 #${detail.id} · ${detail.platform || '未知平台'} · ${detail.status === 'active' ? '已启用' : '未启用'}`} onClose={() => setSelected(null)}
      actions={<><a className="outline-button" href={routeHref('route-discovery', site.id, detail.id)} onClick={() => setSelected(null)}><MagnifyingGlass size={16}/>智能选线</a>
        <a className="probe-button" href={routeHref('route-accounts', site.id, detail.id)} onClick={() => setSelected(null)}><Link size={16}/>账号关联</a></>}>
      <section><h3>分组配置</h3><p>分组倍率：{detail.rate == null ? "未提供" : `${detail.rate}×`} · {detail.subscriptionType === "subscription" ? "订阅套餐" : "按量计费"}</p><p className="rb-detail-meta">高峰倍率：{detail.peak ? `${detail.peak.factor}× · ${detail.peak.start}–${detail.peak.end}` : "未启用"}</p></section>
      <section><h3>账号关联</h3><p>{site.accounts.filter(account => account.groupIds.includes(detail.id)).length} 个账号</p>
        <p className="rb-detail-meta">{detailRoutes?.unboundAccounts ?? 0} 未关联 · {detailRoutes?.reviewAccounts ?? 0} 待确认</p></section>
      <GroupModelStatus key={detail.id} models={detailRoutes?.models || []} group={detail} accounts={site.routes?.accounts || []}/>
    </BindingDetail>}
  </section>
}

export function RouteBindingEditor({ site, selection, onSave, onClose }) {
  const dialog = useRef(null)
  const [options, setOptions] = useState(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [reload, setReload] = useState(0)
  const [upstreamId, setUpstreamId] = useState('')
  const [tokenId, setTokenId] = useState('')
  const [models, setModels] = useState([])
  const [search, setSearch] = useState('')
  useEffect(() => { const element = dialog.current; element.showModal(); return () => element.close() }, [])
  useEffect(() => {
    const controller = new AbortController()
    setError(''); setOptions(null)
    routeRequest(`/api/secondary-sites/${site.id}/bindings`, null, controller.signal).then(data => {
      if (controller.signal.aborted) return
      setOptions(data)
      const account = data.routes.accounts.find(item => item.id === selection.accountId)
      const preferred = selection.recommendation || account?.binding
      setUpstreamId(preferred?.upstreamId || ''); setTokenId(preferred?.tokenId || '')
      const suggestedToken = selection.recommendation && data.upstreams.find(item => item.id === preferred.upstreamId)?.tokens.find(item => item.id === preferred.tokenId)
      setModels(suggestedToken ? suggestedToken.models.filter(model => model.protocol !== 'unsupported').map(model => ({ model: model.id, upstreamModel: model.id }))
        : (account?.models ?? []).map(({ model, upstreamModel }) => ({ model, upstreamModel })))
    }).catch(err => { if (!controller.signal.aborted) setError(err.message) })
    return () => controller.abort()
  }, [site.id, selection.accountId, reload])
  const upstream = options?.upstreams.find(item => item.id === upstreamId)
  const token = upstream?.tokens.find(item => item.id === tokenId)
  const availableModels = token?.models ?? []
  const visibleModels = [...availableModels, ...models.filter(item => !availableModels.some(model => model.id === item.upstreamModel))
    .map(item => ({ id: item.upstreamModel, protocol: '已移除' }))].filter(model => model.id.toLowerCase().includes(search.toLowerCase()))
  const hasBinding = options?.routes.accounts.some(account => account.id === selection.accountId && account.binding)
    || options?.routes.orphanBindings.some(binding => binding.accountId === selection.accountId)
  const boundAccount = options?.routes.accounts.find(account => account.id === selection.accountId)
  async function save(remove = false, automatic = false) {
    if (saving || !options) return
    if (!remove && !automatic && models.some(item => !item.model.trim() || item.model.length > 256)) {
      setError('请填写全部已选模型的调度站点模型名（1–256 字符），包括其他页中的模型。'); return
    }
    setSaving(true); setError('')
    try {
      await onSave({ kind: 'account', accountId: selection.accountId, version: options.version,
        context: options.context, remove, automatic, upstreamId, tokenId, models })
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }
  return <dialog ref={dialog} className="add-modal rate-editor rb-editor" aria-labelledby="binding-title" onCancel={event => { event.preventDefault(); if (!saving) onClose() }}>
    <form onSubmit={event => { event.preventDefault(); save() }}>
      <div className="modal-head"><div><span className="eyebrow">{site.name} · #{selection.accountId}</span><h2 id="binding-title">关联上游令牌</h2><p>{selection.name}</p></div>
        <button type="button" className="icon-button" disabled={saving} onClick={onClose} aria-label="关闭"><X size={18}/></button></div>
      {!options && !error && <p role="status">正在读取可关联线路…</p>}
      {options && !selection.orphan && <fieldset className="connection-fields" disabled={saving}>
        <>
          <label>上游站点<select aria-label="上游站点" required value={upstreamId} onChange={event => { setUpstreamId(event.target.value); setTokenId(''); setModels([]) }}>
            <option value="">选择上游站点</option>{options.upstreams.map(item => <option key={item.id} value={item.id}>{item.name} · {item.endpoint}</option>)}
            {upstreamId && !upstream && <option value={upstreamId}>原上游已移除</option>}</select></label>
          <label>上游令牌<select aria-label="上游令牌" required value={tokenId} onChange={event => { setTokenId(event.target.value); setModels([]) }}>
            <option value="">选择具体令牌</option>{upstream?.tokens.map(item => <option key={item.id} value={item.id}>{item.name} · {item.groupName || '未分组'} · #{item.id}</option>)}
            {tokenId && !token && <option value={tokenId}>原令牌已移除</option>}</select></label>
          {token && <>
            <div className="rb-selection-head"><b>模型映射 · 已选 {models.length}</b><button type="button" className="text-button" onClick={() => setModels(availableModels.filter(model => model.protocol !== 'unsupported')
              .map(item => models.find(model => model.upstreamModel === item.id) || { model: item.id, upstreamModel: item.id }))}><CheckSquare size={15}/>全选模型</button></div>
            <input type="search" aria-label="搜索上游模型" placeholder="搜索模型" value={search} onChange={event => setSearch(event.target.value)}/>
            <Paginated items={visibleModels} resetKey={JSON.stringify([upstreamId, tokenId, search])} label="模型映射">{rows => <div className="rb-model-options">{rows.map(model => {
              const selected = models.find(item => item.upstreamModel === model.id)
              return <div key={model.id} className="rb-model-option"><label><input type="checkbox" checked={Boolean(selected)} disabled={model.protocol === 'unsupported'}
                onChange={event => setModels(current => event.target.checked ? [...current, { model: model.id, upstreamModel: model.id }] : current.filter(item => item.upstreamModel !== model.id))}/>
                <span>{model.id}<small>{model.protocol} · {probeLabels[model.status] || '待重新选择'}</small></span></label>
                {selected && <label>调度站点模型名<input required maxLength={256} value={selected.model} onChange={event => setModels(current => current.map(item => item.upstreamModel === model.id ? { ...item, model: event.target.value } : item))}/></label>}
              </div>
            })}{!visibleModels.length && <p className="site-message">{availableModels.length ? '没有匹配模型' : '令牌尚无模型，请先在探针监控中同步。'}</p>}</div>}</Paginated>
          </>}
        </>
        <label className="rb-confirm"><input type="checkbox" required/>确认所选令牌及模型与调度站点账号配置一致</label>
      </fieldset>}
      {selection.orphan && <p className="site-message">关联对象已从调度站点移除。</p>}
      {error && <div className="site-error" role="alert">{error}<button type="button" disabled={saving} onClick={() => setReload(value => value + 1)}><ArrowsClockwise size={14}/>重新读取配置</button></div>}
      <div className="modal-actions">{hasBinding && <button type="button" className="rb-remove" disabled={saving} onClick={() => save(true)}><LinkBreak size={15}/>解除关联</button>}
        {(boundAccount?.autoBindingDisabled || boundAccount?.binding?.source === 'manual') && <button type="button" className="text-button" disabled={saving} onClick={() => save(false, true)}>恢复自动关联</button>}
        <button type="button" className="cancel-button" disabled={saving} onClick={onClose}>取消</button>
        {!selection.orphan && <button type="submit" className="probe-button" disabled={saving || !options || (!token || !models.length)}><Link size={15}/>{saving ? '保存中…' : '保存关联'}</button>}</div>
    </form>
  </dialog>
}
