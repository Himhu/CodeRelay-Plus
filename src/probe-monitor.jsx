import { Paginated } from './pagination.jsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowsClockwise, Key, ListChecks } from '@phosphor-icons/react'
import ProbeRecords from './probe-records.jsx'
import { cachedDataLabel, readViewCache, writeViewCache, viewCacheGeneration } from './view-cache.js'

const tokenKey = token => `${token.channelId}/${token.id}`

function TokenToggle({ token, controls }) {
  const saving = controls.busy === tokenKey(token)
  const error = controls.actionError?.key === tokenKey(token) ? controls.actionError.message : ''
  return <div className="pm-token-toggle">
    <button type="button" role="switch" aria-checked={token.probeEnabled === true}
      aria-label={`探测 ${token.name} #${token.id}`} title={token.probeEnabled ? '关闭该令牌的探测' : '启用该令牌的探测'}
      disabled={Boolean(controls.busy) || token.probePaused && !token.probeEnabled}
      className={`probe-toggle ${token.probeEnabled ? 'enabled' : ''}`} onClick={() => controls.toggle(token)}><span/></button>
    <small>{saving ? '保存中…' : token.probePaused ? '需重新同步' : token.probeEnabled ? '已启用' : '已关闭'}</small>
    {token.probeEnabled && token.costBlockedModels > 0 && <small>{token.costBlockedModels} 个模型因成本暂停</small>}
    {error && <span className="pm-token-error">{error}</span>}
  </div>
}

export default function ProbeMonitor({ channelId, channelName, onClearChannel, tokenTab, onTabChange, TokensView, identifyModel, protocolLabel }) {
  const [cached] = useState(() => readViewCache('/api/probe-tokens'))
  const cacheGeneration = useRef(viewCacheGeneration())
  const [cachedAt, setCachedAt] = useState(cached?.savedAt ?? null)
  const [tokens, setTokens] = useState(cached?.data.probeTokens ?? [])
  const [policy, setPolicy] = useState(cached?.data.policy ?? { intervalSec: 60 })
  const [loading, setLoading] = useState(!cached)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState(null)
  const [batchResult, setBatchResult] = useState(null)
  const [channelSetup, setChannelSetup] = useState(cached?.data.channelSetup ?? [])
  const [syncErrors, setSyncErrors] = useState([])
  const [updatedAt, setUpdatedAt] = useState(cached?.savedAt ?? null)
  const [now, setNow] = useState(Date.now)
  const [busy, setBusy] = useState('')
  const readRequest = useRef(null)
  const etag = useRef(null)
  const mutation = useRef(null)
  const tabs = useRef(null)

  const accept = useCallback(payload => {
    if (!Array.isArray(payload.probeTokens)) throw new Error('探针数据格式无效，已保留上次记录。')
    setTokens(payload.probeTokens)
    if (Array.isArray(payload.channelSetup)) setChannelSetup(payload.channelSetup)
    if (Number.isFinite(payload.policy?.intervalSec) && payload.policy.intervalSec > 0) setPolicy(payload.policy)
    const previous = readViewCache('/api/probe-tokens')?.data
    writeViewCache('/api/probe-tokens', { probeTokens: payload.probeTokens,
      channelSetup: payload.channelSetup ?? previous?.channelSetup ?? [], policy: payload.policy ?? previous?.policy ?? { intervalSec: 60 } }, cacheGeneration.current)
    setCachedAt(null)
    setUpdatedAt(Date.now())
    setNow(Date.now())
    setError('')
  }, [])

  const load = useCallback(async (manual = false) => {
    if (readRequest.current || mutation.current || !manual && document.hidden) return
    const controller = new AbortController()
    readRequest.current = controller
    if (manual) setRefreshing(true)
    try {
      const response = await fetch('/api/probe-tokens', { signal: controller.signal, headers: etag.current ? { 'If-None-Match': etag.current } : undefined })
      if (response.status === 304) { setError(''); setUpdatedAt(Date.now()); return }
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || '无法读取探针记录')
      if (!controller.signal.aborted) { etag.current = response.headers.get('ETag'); accept(payload) }
    } catch (err) { if (!controller.signal.aborted) setError(err.message) }
    finally {
      if (readRequest.current === controller) readRequest.current = null
      if (!controller.signal.aborted) { setLoading(false); setRefreshing(false) }
    }
  }, [accept])

  const change = useCallback(async (key, operation) => {
    if (mutation.current) return
    const controller = new AbortController()
    mutation.current = controller
    etag.current = null
    readRequest.current?.abort()
    readRequest.current = null
    setRefreshing(false)
    setBusy(key)
    setActionError(null)
    setBatchResult(null)
    const request = (path, body) => requestJSON(path, body, controller.signal)
    try {
      const payload = await operation(request)
      if (!controller.signal.aborted) { accept(payload); setBatchResult(payload.batch ?? null) }
    }
    catch (err) {
      if (!controller.signal.aborted) setActionError({ key, message: err.message })
      return false
    }
    finally {
      if (mutation.current === controller) mutation.current = null
      if (!controller.signal.aborted) { setBusy(''); void load() }
    }
    return true
  }, [accept, load])

  const syncAll = useCallback(() => change('sync', async request => {
    setSyncErrors([])
    const payload = await request('/api/upstream-channels')
    if (!Array.isArray(payload.channels)) throw new Error('无法读取上游渠道')
    const failures = []
    await Promise.all(payload.channels.filter(channel => !channel.needsAuthorization && (!channelId || channel.id === channelId)).map(async channel => {
      try {
        const result = await request(`/api/upstream-channels/${encodeURIComponent(channel.id)}/groups/sync`, {})
        const updated = result.channels?.find(item => item.id === channel.id)
        const error = updated?.apiKeys?.error || updated?.userGroups?.error
        if (error) failures.push({ channelId: channel.id, name: channel.name, error })
      } catch (error) {
        if (error.name === 'AbortError') throw error
        failures.push({ channelId: channel.id, name: channel.name, error: error.message })
      }
    }))
    setSyncErrors(failures)
    return request('/api/probe-tokens')
  }), [change, channelId])

  useEffect(() => {
    void load()
    const timer = setInterval(() => { setNow(Date.now()); void load() }, 5000)
    return () => {
      clearInterval(timer)
      readRequest.current?.abort(); readRequest.current = null
      mutation.current?.abort(); mutation.current = null
    }
  }, [load])
  const visibleTokens = useMemo(() => channelId ? tokens.filter(token => token.channelId === channelId) : tokens, [tokens, channelId])
  const visibleSetup = channelId ? channelSetup.filter(item => item.channelId === channelId) : channelSetup
  const selectedChannelName = visibleTokens[0]?.channelName || visibleSetup[0]?.name || channelName || channelId
  const controls = {
    tokens: visibleTokens, policy, loading, refreshing, error, updatedAt, now, load: () => load(true), syncAll, busy, actionError, batchResult,
    toggle: token => change(tokenKey(token), request => request(`/api/probe-tokens/${encodeURIComponent(token.channelId)}/${encodeURIComponent(token.id)}`, { enabled: !token.probeEnabled })),
    revalidate: (token, model) => change(`${tokenKey(token)}/revalidate/${model.id}`, request => request(`/api/probe-tokens/${encodeURIComponent(token.channelId)}/${encodeURIComponent(token.id)}/models/revalidate`, { model: model.id })),
    enableBatch: targets => change('batch-enable', request => request('/api/probe-tokens/batch-enable', {
      tokens: targets.map(token => ({ channelId: token.channelId, id: String(token.id) })),
    })),
    disableBatch: targets => change('batch-disable', request => request('/api/probe-tokens/batch-disable', {
      tokens: targets.map(token => ({ channelId: token.channelId, id: String(token.id) })),
    })),
    createToken: body => change('create-token', request => request('/api/probe-tokens/create', body)),
    removeToken: token => change(tokenKey(token), request => request(`/api/probe-tokens/${encodeURIComponent(token.channelId)}/${encodeURIComponent(token.id)}/delete`, {})),
    channelId,
  }

  return <div className="pm-workspace">
    {cachedAt && <p className="cached-data-note">{cachedDataLabel(cachedAt)}</p>}
    {channelId && <div className="pm-channel-scope" role="region" aria-label="当前探针站点">
      <span>当前站点：<b>{selectedChannelName}</b></span>
      <button type="button" className="text-button" onClick={onClearChannel}>查看全部站点</button>
    </div>}
    <div className="pm-tabs" ref={tabs} role="tablist" aria-label="探针监控视图" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const next = event.key === 'Home' ? false : event.key === 'End' ? true : !tokenTab
      onTabChange(next)
      tabs.current.querySelectorAll('[role="tab"]')[next ? 1 : 0].focus({ preventScroll: true })
    }}>
      <button type="button" id="pm-models-tab" role="tab" aria-selected={!tokenTab} aria-controls="pm-models-panel" tabIndex={tokenTab ? -1 : 0} onClick={() => onTabChange(false)}><ListChecks size={17}/>模型状态</button>
      <button type="button" id="pm-tokens-tab" role="tab" aria-selected={tokenTab} aria-controls="pm-tokens-panel" tabIndex={tokenTab ? 0 : -1} onClick={() => onTabChange(true)}><Key size={17}/>令牌管理</button>
    </div>
    <div className="pm-maintenance"><span>后台自动同步令牌、获取模型并探测</span><div className="pm-maintenance-actions">
      <button type="button" className="pr-refresh" disabled={refreshing || Boolean(busy)} onClick={() => void load(true)}><ArrowsClockwise size={15}/>{refreshing ? '刷新中…' : '刷新记录'}</button>
      <details><summary>手动维护</summary><div><button type="button" className="pr-refresh" disabled={Boolean(busy) || loading} onClick={syncAll}><ArrowsClockwise size={15}/>{busy === 'sync' ? '同步中…' : channelId ? '同步本站令牌' : '同步全部令牌'}</button>
    </div></details></div></div>
    {error && <p className="pm-action-error" role="alert">{error}{updatedAt ? ' · 已保留上次记录' : ''}</p>}
    {actionError && <p className="pm-action-error" role="alert">{actionError.message}</p>}
    {busy && busy !== 'sync' && <p className="site-session-note" role="status">正在处理；同站有任务时会自动排队，完成后更新结果，无需重复点击。</p>}
    {batchResult && <div className="pr-batch-result">
      <p role="status">{'disabled' in batchResult
        ? `已停止 ${batchResult.disabled} 个令牌${batchResult.alreadyDisabled > 0 ? `，${batchResult.alreadyDisabled} 个原已停止` : ''}${batchResult.failures.length ? `，${batchResult.failures.length} 个未停止` : ''}。历史记录保留。`
        : `已启用 ${batchResult.enabled} 个令牌${batchResult.alreadyEnabled > 0 ? `，${batchResult.alreadyEnabled} 个已开启` : ''}${batchResult.failures.length ? `，${batchResult.failures.length} 个未启用` : ''}。`}</p>
      {batchResult.failures.length > 0 && <details><summary>{'disabled' in batchResult ? '未停止' : '未启用'}原因（{batchResult.failures.length}）</summary><Paginated items={batchResult.failures} label="批量操作失败记录">{failures => <ul>{failures.map(item =>
        <li key={JSON.stringify([item.channelId, item.id])}><b>{item.name}</b><span>{item.error}</span></li>)}</ul>}</Paginated></details>}
    </div>}
    {syncErrors.length > 0 && <div className="pm-action-error" role="alert">{syncErrors.length > 5 && <p>共 {syncErrors.length} 个渠道同步失败</p>}<Paginated items={syncErrors} label="渠道同步错误">{errors => errors.map(item => <p key={item.channelId}>{item.name && `${item.name}：`}{item.error}</p>)}</Paginated></div>}
    {visibleSetup.length > 0 && <section className="pm-channel-setup" aria-label="渠道接入状态">
      <div className="pm-setup-head"><h2>接入进度 · {visibleSetup.length} 个站点</h2><a href="#overview">管理上游</a></div>
      <Paginated items={visibleSetup} resetKey={channelId} label="渠道接入状态">{rows => <ul>{rows.map(item => <li key={item.channelId}><b>{item.name}</b><span>{item.detail}</span>{item.status === "unauthorized" && <a href={`#overview?q=${encodeURIComponent(item.name)}`}>去授权</a>}</li>)}</ul>}</Paginated>
    </section>}
    <div id="pm-models-panel" role="tabpanel" aria-labelledby="pm-models-tab" hidden={tokenTab}>
      <ProbeRecords identifyModel={identifyModel} protocolLabel={protocolLabel} controls={controls} TokenToggle={TokenToggle} onManageTokens={() => onTabChange(true)}/>
    </div>
    <div id="pm-tokens-panel" role="tabpanel" aria-labelledby="pm-tokens-tab" hidden={!tokenTab}>
      <TokensView controls={controls} TokenToggle={TokenToggle}/>
    </div>
  </div>
}
import { consoleFetch as fetch, requestJSON } from './console-fetch.js'
