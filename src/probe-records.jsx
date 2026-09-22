import { useEffect, useMemo, useRef, useState } from 'react'
import { CaretDown, ListChecks, MagnifyingGlass, Pause, Play, X } from '@phosphor-icons/react'
import { buildProbeFamilyGroups, buildProbeModelGroups, buildProbeTimeline, summarizeProbeCells, probeResultLabel, probeStatusLabels, probeCurrentStates, summarizeProbeRates, summarizeProbeAvailability, probeRecordSection } from './probe-records-data.js'
import './probe-records.css'
import { Paginated } from './pagination.jsx'
import { PAGE_SIZE } from './pagination-data.js'

const clock = value => new Date(value).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
const timestamp = value => new Date(value).toLocaleString('zh-CN', { hour12: false })
const latency = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
  ? value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms` : '—'
const counts = cell => `成功 ${cell.success} · 失败 ${cell.failed} · 未确认 ${cell.uncertain}`
function Status({ status, reason, current = false }) {
  return <span className={`pr-status ${status}`}><i aria-hidden="true"/>{current && !['error', 'inconclusive'].includes(status)
    ? probeCurrentStates[status]?.label ?? '结果状态未识别' : probeResultLabel({ status, reason })}</span>
}

function HistoryDialog({ history, onClose }) {
  const dialog = useRef(null)
  const scroll = useRef(null)
  const selectedRow = useRef(null)
  const [selected, setSelected] = useState(history.at)
  const cell = history.cells.find(item => item.time === selected)
  const minutes = [...history.cells].reverse()
  const initialPage = Math.floor(Math.max(0, minutes.findIndex(item => item.time === history.at)) / PAGE_SIZE) + 1
  useEffect(() => {
    const element = dialog.current
    const previousOverflow = document.body.style.overflow
    const x = window.scrollX, y = window.scrollY
    element.showModal()
    document.body.style.overflow = 'hidden'
    return () => {
      element.close()
      document.body.style.overflow = previousOverflow
      history.opener?.focus({ preventScroll: true })
      window.scrollTo(x, y)
    }
  }, [history])
  useEffect(() => {
    const row = selectedRow.current, container = scroll.current
    if (row && container) container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top - (container.clientHeight - row.clientHeight) / 2
  }, [selected])

  return <dialog ref={dialog} className="pr-history-dialog" aria-labelledby="pr-history-title" aria-describedby="pr-history-description"
    onCancel={event => { event.preventDefault(); onClose() }} onClick={event => {
      if (event.target !== event.currentTarget) return
      const rect = event.currentTarget.getBoundingClientRect()
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose()
    }}>
    <div className="pr-history-head"><div><span className="pr-overline">分钟历史</span><h2 id="pr-history-title">{history.channelName}</h2><code>{history.modelId}</code></div>
      <button type="button" className="pr-close" onClick={onClose} aria-label="关闭分钟历史"><X size={18}/></button></div>
    <p className="pr-token-identity">{history.tokenName} · #{history.tokenId} · {history.groupName}</p>
    <p id="pr-history-description">最近 60 个完整分钟 · 按请求发起时间归档 · 无记录不代表故障 · 耗时为完整响应时间</p>
    <Paginated items={minutes} initialPage={initialPage} label="分钟历史" always>{rows => <div ref={scroll} className="pr-history-scroll"><table><thead><tr><th scope="col">分钟</th><th scope="col">状态</th><th scope="col">平均耗时</th><th scope="col">成功探测</th></tr></thead>
      <tbody>{rows.map(item => <tr key={item.time} className={selected === item.time ? 'pr-selected-minute' : ''} ref={selected === item.time ? selectedRow : null} data-minute={item.time}>
        <td><button type="button" aria-label={`查看 ${timestamp(item.time)} 的探测明细`} aria-pressed={selected === item.time} onClick={() => setSelected(item.time)}><time dateTime={new Date(item.time).toISOString()}>{clock(item.time)}</time></button></td>
        <td><Status status={item.status} reason={item.entries.length === 1 ? item.entries[0].reason : null}/>{item.failed + item.uncertain > 0 && <small>{item.failed} 失败 · {item.uncertain} 未确认</small>}</td>
        <td>{latency(item.latencyMs)}</td><td>{item.entries.length ? item.success : '—'}{item.entries.length > 0 && <small>共 {item.entries.length} 次</small>}</td>
      </tr>)}</tbody></table></div>}</Paginated>
    {cell && <details className="pr-minute-details" key={selected}><summary>{clock(selected)} · {cell.entries.length ? `${cell.entries.length} 次探测，查看令牌明细` : '该分钟没有探测记录'}</summary>
      <Paginated items={cell.entries} label="分钟探测明细">{entries => entries.map((entry, index) => <div className="pr-minute-entry" key={`${entry.tokenId}-${entry.time}-${index}`}><span>{entry.tokenName} <small>#{entry.tokenId}</small></span><Status status={entry.status} reason={entry.reason}/><span>{latency(entry.latencyMs)}</span>
        {(entry.error || entry.httpStatus) && <p className="pr-entry-reason">{entry.httpStatus ? `HTTP ${entry.httpStatus} · ` : ''}{entry.error || probeResultLabel(entry)}</p>}
        {entry.completedAt && <p className="pr-entry-reason">发起 {clock(entry.time)} · 完成 {clock(Date.parse(entry.completedAt))}{entry.protocol ? ` · ${entry.protocol}` : ''}{entry.timeoutMs ? ` · 超时上限 ${entry.timeoutMs / 1000} 秒` : ''}</p>}
      </div>)}</Paginated>
    </details>}
    <p className="pr-history-foot">{timestamp(history.cells[0].time)} — {clock(history.cells.at(-1).time)} · 打开时的记录快照</p>
  </dialog>
}

function TokenModelRow({ channel, record, modelId, protocolLabel, onHistory, controls, TokenToggle }) {
  const [showTokens, setShowTokens] = useState(false)
  const cells = useMemo(() => buildProbeTimeline([record], controls.now), [record, controls.now])
  const summary = useMemo(() => summarizeProbeCells(cells), [cells])
  const section = probeRecordSection(record)
  const hasIssue = ['abnormal', 'excluded'].includes(section)
  const lastResult = record.revalidatePending ? record.history?.at(-1) : record
  const identity = `${record.tokenName} · #${record.tokenId}`
  const openHistory = (event, at) => onHistory({ modelId, channelName: channel.name, tokenId: record.tokenId,
    tokenName: record.tokenName, groupName: record.groupName, cells, at, opener: event.currentTarget })
  return <article className={`pr-channel${record.currentStatus === 'ok' ? ' pr-channel-available' : ''}`} aria-label={`${modelId} · ${identity}`}>
    <div className="pr-channel-info" aria-label="上游渠道">
      <h5>{channel.name}</h5>
      <span className="pr-provider">{channel.provider === 'newapi' ? 'NewAPI' : 'Sub2API'}</span>
    </div>
    <div className="pr-route-identity" aria-label="线路分组与令牌">
      <h6>{record.groupName}</h6>
      <p className="pr-token-identity"><span title={record.tokenName}>{record.tokenName}</span><b>令牌 #{record.tokenId}</b></p>
      <div className="pr-channel-meta"><button type="button" aria-label={`查看 ${identity} 的令牌详情`} aria-expanded={showTokens} onClick={() => setShowTokens(value => !value)}>令牌详情<CaretDown size={12} className={showTokens ? 'pr-rotated' : ''}/></button></div>
    </div>
    <div className="pr-current" aria-label="当前探测结果">
      <Status status={record.currentStatus} reason={record.reason} current/>
      {probeCurrentStates[record.currentStatus]?.hint && <small className="pr-state-hint">{record.currentStatus === 'cost_blocked' ? record.costBlockReason || probeCurrentStates.cost_blocked.hint : probeCurrentStates[record.currentStatus].hint}</small>}
      <span className="pr-recharge" title={record.pricing.detail}>实际倍率 <b>{summarizeProbeRates([record.pricing])}</b></span>
      <small title={`最近检测：${record.lastProbeAt ? timestamp(record.lastProbeAt) : '尚未检测'}`}>{record.lastProbeAt ? `${clock(record.lastProbeAt)} 检测` : '尚未检测'}</small>
    </div>
    <div className="pr-timeline" aria-label={`${identity} 最近 60 分钟探测状态`}>
      <div className="pr-channel-stats"><span title="最近 60 个完整分钟：成功次数 ÷（成功 + 失败），不代表当前可用状态">历史成功率 <b>{summary.rate}</b></span>
        <span title={`覆盖 ${summary.coverage}/60 分钟${summary.uncertain ? ` · ${summary.uncertain} 次响应未确认` : ''}`}>覆盖 {summary.coverage}/60 分钟</span>
        <span>耗时 <b>{latency(record.latencyMs)}</b></span></div>
      <div className="pr-cells">{cells.map(cell => <button type="button" key={cell.time} className={`pr-cell ${cell.status}`} data-minute={cell.time}
        title={`${timestamp(cell.time)} · ${probeStatusLabels[cell.status]}${cell.entries.length ? ` · ${counts(cell)} · 平均 ${latency(cell.latencyMs)}` : ''}`}
        aria-label={`${clock(cell.time)} ${probeStatusLabels[cell.status]}，查看分钟历史`} onClick={event => openHistory(event, cell.time)}/>)}</div>
      <div className="pr-axis"><time dateTime={new Date(cells[0].time).toISOString()}>{clock(cells[0].time)}</time>
        <button type="button" aria-label={`查看 ${identity} 的分钟历史`} onClick={event => openHistory(event, null)}>每格 1 分钟 · <span>历史</span></button>
        <time dateTime={new Date(cells.at(-1).time).toISOString()}>{clock(cells.at(-1).time)}</time></div>
    </div>
    {hasIssue && <div className="pr-model-paused"><div><p>{section === 'excluded'
      ? `${record.reason === 'model_unsupported' || record.unresolvedExclusion ? '上游曾明确不支持此令牌下的模型' : '模型连续探测失败'}，已隔离，历史记录保留。${record.token.autoRecoverModels ? '后台每 5 分钟复测，成功后自动恢复。' : '重新验证成功后自动恢复展示。'}`
      : `曾连续 ${record.failureCount} 次失败，尚未恢复成功。探测成功后自动恢复展示。`}
      {!record.token.probeEnabled ? '重新验证前请先启用令牌。' : record.token.probePaused ? '请先重新同步令牌。'
        : section === 'abnormal' && !record.revalidatePending ? '后台继续每分钟探测。' : ''}</p>
      {lastResult && <p className="pr-issue-reason">最近原因：{lastResult.httpStatus ? `HTTP ${lastResult.httpStatus} · ` : ''}{lastResult.error || probeResultLabel(lastResult)}</p>}
      {record.revalidatePending && <p role="status">已加入正常探测队列，等待重新验证。</p>}</div>
      <button type="button" className="pr-refresh" disabled={Boolean(controls.busy) || !record.token.probeEnabled || record.token.probePaused || record.revalidatePending || record.protocol === 'unsupported'}
        aria-label={`重新验证 ${identity} 的 ${modelId}`} onClick={() => controls.revalidate(record.token, record)}>{record.revalidatePending ? '等待验证' : '重新验证'}</button></div>}
    {record.revalidatePending && !hasIssue && !record.costBlocked && <p className="pr-model-paused" role="status">已加入正常探测队列，等待重新验证。</p>}
    {showTokens && <div className="pr-token-panel"><div className="pr-endpoint">{channel.provider === 'newapi' ? 'NewAPI' : 'Sub2API'} <span>{channel.endpoint}</span></div>
      <ul><li><div><b>{record.tokenName}</b><span>{protocolLabel(record)}{record.token.upstreamTokenName && ` · 上游令牌名：${record.token.upstreamTokenName}`}</span>
        <span className="pr-token-rate">实际倍率 <b>{summarizeProbeRates([record.pricing])}</b></span>
        <small>{record.pricing.detail}{record.token.groupPricing?.updatedAt && ` 倍率更新：${timestamp(record.token.groupPricing.updatedAt)}`}</small></div>
        <div><Status status={record.currentStatus} reason={record.reason} current/><small>{record.lastProbeAt ? `最近检测 ${timestamp(record.lastProbeAt)}` : '暂无检测记录'}</small></div>
        <TokenToggle token={record.token} controls={controls}/>
        {record.error && <p className="pr-token-error">最近结果：{record.httpStatus ? `HTTP ${record.httpStatus} · ` : ''}{record.error}</p>}</li></ul>
    </div>}
  </article>
}

function FoldedIssues({ children, title, reveal, className }) {
  const [open, setOpen] = useState(reveal)
  useEffect(() => setOpen(reveal), [reveal])
  return <details className={`pr-folded-issues ${className}`} open={open} onToggle={event => {
    if (event.target === event.currentTarget && event.currentTarget.open !== open) setOpen(event.currentTarget.open)
  }}><summary><CaretDown size={14}/><span>{title}</span></summary>{open && children}</details>
}

const modelRecords = group => group.channels.flatMap(channel => channel.records)
const modelArchived = group => modelRecords(group).every(record => ['abnormal', 'excluded'].includes(probeRecordSection(record)))
const modelAvailable = group => modelRecords(group).some(record => record.currentStatus === 'ok')

function RouteRows({ entries, renderRow, resetKey }) {
  return <Paginated items={entries} resetKey={resetKey} label="模型令牌线路">{rows => rows.map(renderRow)}</Paginated>
}

function ModelRoutes({ group, open, onToggle, revealIssues, resetKey, ...rowProps }) {
  const availability = summarizeProbeAvailability(modelRecords(group))
  const entries = group.channels.flatMap(channel => channel.records.map(record => ({ channel, record })))
  const normal = entries.filter(({ record }) => !['abnormal', 'excluded'].includes(probeRecordSection(record)))
    .sort((a, b) => Number(b.record.currentStatus === 'ok') - Number(a.record.currentStatus === 'ok'))
  const issues = entries.filter(({ record }) => ['abnormal', 'excluded'].includes(probeRecordSection(record)))
  const excluded = issues.filter(({ record }) => probeRecordSection(record) === 'excluded').length
  const row = ({ channel, record }) => <TokenModelRow key={JSON.stringify([channel.id, record.tokenId])} channel={channel} record={record} modelId={group.id} {...rowProps}/>
  return <details className="pr-model" open={open} onToggle={event => {
    if (event.target === event.currentTarget && event.currentTarget.open !== open) onToggle(group.id, event.currentTarget.open)
  }}>
    <summary><CaretDown size={15} className="pr-model-caret"/><h4>{group.id}</h4>
      <span className={`pr-status pr-model-availability ${availability.status}`} title={availability.detail}><i aria-hidden="true"/>{availability.label}</span>
      <span className="pr-model-count">{group.channels.length} 个上游 · {entries.length} 个令牌</span>
      {availability.breakdown && <span className="pr-model-state-details">{availability.breakdown}</span>}</summary>
    {open && <div className="pr-channels"><div className="pr-line-columns" aria-hidden="true"><span>上游渠道</span><span>线路分组 / 令牌</span><span>当前状态 / 倍率</span><span>最近 60 分钟 · 每个令牌独立记录</span></div>
      <RouteRows entries={normal} renderRow={row} resetKey={resetKey}/>
      {issues.length > 0 && (normal.length ? <FoldedIssues className="pr-folded-lines" reveal={revealIssues} title={`持续异常 ${issues.length - excluded} · 已排除 ${excluded} · 查看原因与重新验证`}>
        <RouteRows entries={issues} renderRow={row} resetKey={resetKey}/>
      </FoldedIssues> : <RouteRows entries={issues} renderRow={row} resetKey={resetKey}/>)}
    </div>}
  </details>
}

export default function ProbeRecords({ identifyModel, protocolLabel, controls, TokenToggle, onManageTokens }) {
  const { tokens, policy, loading, error, updatedAt, now, busy, enableBatch, disableBatch } = controls
  const intervalSec = policy.intervalSec
  const [query, setQuery] = useState('')
  const [family, setFamily] = useState('all')
  const [status, setStatus] = useState('all')
  const [expanded, setExpanded] = useState(null)
  const [expandedCategories, setExpandedCategories] = useState({})
  const [history, setHistory] = useState(null)
  const initialView = useRef(null)
  const groups = useMemo(() => buildProbeModelGroups(tokens, now, intervalSec, false), [tokens, now, intervalSec])
  const categories = useMemo(() => buildProbeFamilyGroups(groups, identifyModel), [groups, identifyModel])
  const allRecords = groups.flatMap(group => group.channels.flatMap(channel => channel.records))
  const availableModels = groups.filter(group => group.channels.some(channel => channel.records.some(record => record.currentStatus === 'ok'))).length
  const availableLines = allRecords.filter(record => record.currentStatus === 'ok').length
  const failedLines = allRecords.filter(record => ['error', 'excluded'].includes(record.currentStatus)).length
  const search = query.trim().toLowerCase()
  const filtered = categories.flatMap(category => {
    if (family !== 'all' && category.family !== family) return []
    const models = category.models.flatMap(group => {
      const modelMatches = `${group.id} ${identifyModel(group.id).name} ${category.family}`.toLowerCase().includes(search)
      const channels = group.channels.flatMap(channel => {
        const channelMatches = modelMatches || `${channel.name} ${channel.endpoint}`.toLowerCase().includes(search)
        const records = channel.records.filter(record => (channelMatches || `${record.tokenName} #${record.tokenId} ${record.groupName}`.toLowerCase().includes(search))
          && (status === 'all' || status === record.currentStatus || status === 'abnormal' && probeRecordSection(record) === 'abnormal'))
        return records.length ? [{ ...channel, records }] : []
      })
      return channels.length ? [{ ...group, channels }] : []
    })
    return models.length ? [{ ...category, models }] : []
  })
  const resetKey = JSON.stringify([search, family, status])
  const hasFilters = Boolean(search || family !== 'all' || status !== 'all')
  const batchTokens = [...new Map(filtered.flatMap(category => category.models.flatMap(group => group.channels.flatMap(channel =>
    channel.records.filter(record => !record.token.probeEnabled && record.protocol !== 'unsupported')
      .map(record => [JSON.stringify([record.token.channelId, record.token.id]), record.token]))))).values()]
  const stopTokens = [...new Map([
    ...filtered.flatMap(category => category.models.flatMap(group => group.channels.flatMap(channel => channel.records.map(record => record.token)))),
    // A channel search must also stop enabled tokens whose model catalog has not loaded yet.
    ...tokens.filter(token => !token.probeModels?.length && family === 'all' && status === 'all' &&
      `${token.channelName} ${token.endpoint} ${token.name} #${token.id} ${token.groupName || ''}`.toLowerCase().includes(search)),
  ].filter(token => token.probeEnabled).map(token => [JSON.stringify([token.channelId, token.id]), token])).values()]
  const firstAvailable = categories.flatMap(category => category.models).find(modelAvailable)
  // A restored catalog can lose its default model/category after refresh.
  // Explicit user expansion choices still take precedence below.
  if ((!initialView.current || !groups.some(group => group.id === initialView.current.model)
    || !categories.some(category => category.family === initialView.current.category)) && !loading && categories.length) initialView.current = {
    model: firstAvailable?.id ?? categories[0]?.models.find(group => !modelArchived(group))?.id,
    category: categories.find(category => category.models.some(group => group.id === firstAvailable?.id))?.family,
  }
  const defaultOpen = initialView.current?.model
  const defaultCategory = initialView.current?.category
  const revealIssues = Boolean(search || ['error', 'excluded', 'abnormal'].includes(status))
  const toggle = (id, open) => setExpanded(previous => {
    const next = new Set(previous ?? (defaultOpen ? [defaultOpen] : []))
    if (open) next.add(id); else next.delete(id)
    return next
  })

  return <div className="probe-records-page pr-monitor">
    <div className="pr-metrics" aria-label="探测记录统计">
      <div><span>已发现模型</span><strong>{loading ? '—' : groups.length}</strong><small>{categories.length} 个模型类别</small></div>
      <div><span>有可用线路的模型</span><strong className="pr-success-number">{loading ? '—' : availableModels}</strong><small>至少一个令牌当前探测通过</small></div>
      <div><span>当前可用线路</span><strong className="pr-success-number">{loading ? '—' : availableLines}</strong><small>按模型、令牌分别统计</small></div>
      <div><span>当前失败线路</span><strong className={failedLines ? 'pr-error-number' : ''}>{loading ? '—' : failedLines}</strong><small>包含上游明确不支持的模型</small></div>
    </div>
    <section className="pr-panel" aria-labelledby="pr-panel-title">
      <div className="pr-panel-head"><div><h2 id="pr-panel-title">模型线路状态</h2><p>按模型查看可用令牌 · 每个令牌的每个模型每 {intervalSec} 秒探测</p></div>
        <div className="pr-panel-actions"><button type="button" className="pr-refresh" disabled={loading || Boolean(busy) || !batchTokens.length}
          title={`启用当前${hasFilters ? '筛选结果' : '列表'}对应的 ${batchTokens.length} 个令牌；每个令牌的全部支持模型每 ${intervalSec} 秒分别探测。`}
          onClick={() => void enableBatch(batchTokens)}><Play size={15}/>{busy === 'batch-enable' ? '正在启用…' : `批量启用检测（${batchTokens.length}）`}</button>
          <button type="button" className="pr-refresh pr-stop" disabled={loading || Boolean(busy) || !stopTokens.length}
            title={`停止当前${hasFilters ? '筛选结果' : '列表'}对应的 ${stopTokens.length} 个令牌的全部模型探测；保留历史记录。${[...new Set(stopTokens.map(token => token.channelName))].join('、')}`}
            onClick={() => void disableBatch(stopTokens)}><Pause size={15}/>{busy === 'batch-disable' ? '正在停止…' : `批量停止（${stopTokens.length}）`}</button>
</div></div>
      <div className="pr-toolbar"><label className="pr-search"><MagnifyingGlass size={16}/><input type="search" aria-label="搜索模型、上游、令牌、分组或 Endpoint" placeholder="搜索模型 / 上游 / 令牌 / 分组" value={query} onChange={event => { setQuery(event.target.value); setExpandedCategories({}) }}/></label>
        <select aria-label="模型类别" value={family} onChange={event => { setFamily(event.target.value); setExpandedCategories({}) }}><option value="all">全部模型类别</option>{categories.map(category => <option key={category.family}>{category.family}</option>)}</select>
        <select aria-label="最近探测状态" value={status} onChange={event => { setStatus(event.target.value); setExpandedCategories({}) }}><option value="all">全部当前状态</option>
          {Object.entries(probeCurrentStates).map(([state, info]) => <option key={state} value={state}>{info.label}</option>)}
          <option value="abnormal">持续异常（连续 5 次失败）</option></select>
        <button type="button" className="pr-available-filter" aria-pressed={status === 'ok'} onClick={() => { setStatus(status === 'ok' ? 'all' : 'ok'); setExpandedCategories({}) }}>只看可用</button>
        <span className="pr-filter-count">{filtered.reduce((sum, category) => sum + category.models.length, 0)} / {groups.length} 个模型</span>
      </div>
      <div className="pr-legend" aria-label="时间轴状态图例">{[['ok', '探测通过'], ['error', '全部失败'], ['partial_error', '部分失败'], ['inconclusive', '响应未确认'], ['empty', '无记录'], ['unsupported', '暂不支持']].map(([kind, label]) => <span key={kind}><i className={kind}/>{label}</span>)}<span className="pr-legend-note">每格 1 分钟</span></div>
      {loading ? <div className="pr-empty" role="status">正在读取探测记录…</div> : !groups.length ? <div className="pr-empty"><ListChecks size={24}/><p>{error ? '暂时无法读取探测记录，请重试。' : '暂无模型探测记录'}</p><button type="button" onClick={onManageTokens}>管理令牌</button></div>
        : !filtered.length ? <div className="pr-empty"><MagnifyingGlass size={24}/><p>没有匹配的模型或上游</p><button type="button" onClick={() => { setQuery(''); setFamily('all'); setStatus('all'); setExpandedCategories({}) }}>清除筛选</button></div>
          : <Paginated items={filtered} resetKey={resetKey} label="模型类别" always>{categories => <div className="pr-category-list">{categories.map(category => {
            const categoryOpen = expandedCategories[category.family] ?? (hasFilters || category.family === defaultCategory)
            const channelCount = new Set(category.models.flatMap(group => group.channels.map(channel => channel.id))).size
            const normalModels = category.models.filter(group => !modelArchived(group)).sort((a, b) => Number(modelAvailable(b)) - Number(modelAvailable(a)))
            const archivedModels = category.models.filter(modelArchived)
            const renderModel = group => <ModelRoutes key={group.id} group={group} open={expanded === null ? group.id === defaultOpen : expanded.has(group.id)} onToggle={toggle}
              revealIssues={revealIssues} resetKey={resetKey} protocolLabel={protocolLabel} onHistory={setHistory} controls={controls} TokenToggle={TokenToggle}/>
            return <details className="pr-category" key={category.family} open={categoryOpen} onToggle={event => {
              if (event.target !== event.currentTarget) return
              const open = event.currentTarget.open
              if (open !== categoryOpen) setExpandedCategories(previous => ({ ...previous, [category.family]: open }))
            }}>
              <summary><CaretDown size={16} className="pr-category-caret"/><h3>{category.family}</h3><span className="pr-category-count"><span>{category.models.length} 个模型</span><span>{channelCount} 个上游</span></span></summary>
              <div className="pr-model-list"><Paginated items={normalModels} resetKey={resetKey} label={`${category.family} 模型`}>{models => models.map(renderModel)}</Paginated>
                {archivedModels.length > 0 && <FoldedIssues className="pr-folded-models" reveal={revealIssues} title={`持续异常与已排除的模型（${archivedModels.length}）`}><Paginated items={archivedModels} resetKey={resetKey} label={`${category.family} 异常模型`}>{models => models.map(renderModel)}</Paginated></FoldedIssues>}
              </div>
            </details>
          })}</div>}</Paginated>}
      <div className="pr-footnote"><span>时间轴显示已结束的分钟；当前状态包含本分钟最新结果。未检测分钟不参与成功率。</span><span>{updatedAt ? `最近读取 ${clock(updatedAt)}` : '等待数据'} · 每 5 秒刷新</span></div>
    </section>
    {history && <HistoryDialog history={history} onClose={() => setHistory(null)}/>}
  </div>
}
