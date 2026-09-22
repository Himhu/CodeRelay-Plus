import { useEffect, useRef, useState } from 'react'
import { ArrowsClockwise, CaretDown, MagnifyingGlass } from '@phosphor-icons/react'
import { requestJSON } from './console-fetch.js'
import './log-center.css'
import { Paginated, Pagination } from './pagination.jsx'
import { PAGE_SIZE, normalizePageSize } from './pagination-data.js'

const categories = { routing: '自动调度', upstream: '上游同步与授权', probes: '探测配置与模型', discovery: '线路识别', funding: '充值兑换', settings: '系统设置', system: '服务运行' }
const levels = { info: '记录', success: '成功', warning: '需关注', error: '失败' }
const actors = { user: '人工操作', system: '后台任务', legacy: '历史记录' }
const detailLabels = { before: '修改前', after: '修改后', modelsBefore: '原模型名单', modelsAfter: '当前模型名单', addedModels: '新增模型', removedModels: '移除模型',
  availableModels: '验证通过的模型', retainedModels: '观察期保留模型', modelResults: '决策时的模型结果', excludedModels: '异常模型', state: '当前状态', previousState: '此前状态', reason: '原因', httpStatus: 'HTTP 状态', latencyMs: '延迟（ms）',
  enabled: '是否启用', groupId: '分组 ID', count: '总数', succeeded: '完成数量', failed: '失败数量', unchanged: '未修改数量', status: '结果', orderId: '订单 ID', requestId: '提交 ID',
  rechargeRate: '充值倍率', lowBalanceThreshold: '最低余额阈值', rateChangeMinPercent: '倍率变化百分比', subscriptionDailyRemainingPercent: '订阅日剩余', subscriptionWeeklyRemainingPercent: '订阅周剩余', subscriptionMonthlyRemainingPercent: '订阅月剩余', subscriptionExpiryDays: '订阅到期天数', ignoreAnnouncements: '静默公告', imported: '迁入历史', error: '错误' }
const states = { healthy: '正常调度', observing: '短暂异常观察', cooldown: '冷却 / 已暂停', recovering: '恢复验证', manual: '保留手动状态', waiting: '等待探针', verifying: '等待验证',
  ok: '通过', error: '失败', unknown: '结果待确认', complete: '完成', partial: '部分完成', success: '成功', rejected: '上游拒绝' }
const time = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
const valueLabel = value => typeof value === 'boolean' ? value ? '是' : '否' : states[value] || String(value)

export default function LogCenter({ siteId = '', channelId = '' }) {
  const [filters, setFilters] = useState({ kind: 'operations', hours: '24', category: '', level: '', site: siteId, channel: channelId, q: '' })
  const [search, setSearch] = useState(''), [page, setPage] = useState(1), [pageSize, setPageSize] = useState(PAGE_SIZE), [refresh, setRefresh] = useState(0)
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [auto, setAuto] = useState(true)
  const snapshot = useRef(null), expanded = useRef(new Set())
  const reset = () => { snapshot.current = null; expanded.current.clear(); setPage(1) }
  const change = values => { reset(); setFilters(current => ({ ...current, ...values })) }
  useEffect(() => { reset(); setFilters(current => ({ ...current, site: siteId, channel: channelId })) }, [siteId, channelId])
  useEffect(() => {
    const controller = new AbortController()
    setBusy(true); setError('')
    const params = new URLSearchParams({ ...filters, page: String(page), pageSize: String(pageSize) })
    if (snapshot.current) params.set('until', snapshot.current)
    void (async () => {
      try {
        const payload = await requestJSON(`/api/logs?${params}`, null, controller.signal)
        if (!Array.isArray(payload.items)) throw new Error('日志数据格式无效，已保留上次结果。')
        if (controller.signal.aborted) return
        snapshot.current = payload.until
        const lastPage = Math.max(1, Math.ceil(payload.total / payload.pageSize))
        if (page > lastPage) { setPage(lastPage); return }
        setData(payload)
      } catch (failure) { if (!controller.signal.aborted) setError(failure.message) }
      finally { if (!controller.signal.aborted) setBusy(false) }
    })()
    return () => controller.abort()
  }, [filters, page, pageSize, refresh])
  useEffect(() => {
    if (!auto || page !== 1) return
    const interval = setInterval(() => {
      if (document.hidden || expanded.current.size) return
      snapshot.current = null; setRefresh(value => value + 1)
    }, 15000)
    return () => clearInterval(interval)
  }, [auto, page])
  const reload = () => { reset(); setRefresh(value => value + 1) }
  const items = data?.items ?? [], total = data?.total ?? 0
  const probe = filters.kind === 'probes'
  return <section className="log-center" aria-label="日志记录">
    <div className="lc-heading"><div className="lc-tabs" role="group" aria-label="日志类型">
      <button aria-pressed={!probe} onClick={() => { setSearch(''); change({ kind: 'operations', category: '', level: '', q: '' }) }}>操作记录</button>
      <button aria-pressed={probe} onClick={() => { setSearch(''); change({ kind: 'probes', category: '', level: '', q: '' }) }}>模型探测</button>
    </div><div className="lc-live"><label><input type="checkbox" checked={auto} onChange={event => setAuto(event.target.checked)}/>自动更新</label>
      <button type="button" className="outline-button" disabled={busy} onClick={reload}><ArrowsClockwise size={16}/>刷新</button></div></div>
    <p className="lc-intro">{probe ? '查看每个上游令牌、模型的实际探测结果。每个模型保留最近 1,440 条，移除令牌或模型时同步清理。' : '查看调度决策、推送结果、模型调整、授权同步和人工操作。展开一条记录查看原因与修改详情。'}</p>
    <form className="lc-filters" onSubmit={event => { event.preventDefault(); change({ q: search.trim() }) }}>
      <label>时间范围<select aria-label="时间范围" value={filters.hours} onChange={event => change({ hours: event.target.value })}>
        <option value="1">最近 1 小时</option><option value="24">最近 24 小时</option><option value="168">最近 7 天</option><option value="720">最近 30 天</option><option value="0">全部时间</option></select></label>
      {!probe && <label>记录类型<select aria-label="记录类型" value={filters.category} onChange={event => change({ category: event.target.value })}><option value="">全部类型</option>{Object.entries(categories).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>}
      <label>结果<select aria-label="结果" value={filters.level} onChange={event => change({ level: event.target.value })}><option value="">全部结果</option>{Object.entries(levels).filter(([id]) => !probe || id !== 'info').map(([id, label]) => <option key={id} value={id}>{probe && id === 'warning' ? '待确认' : label}</option>)}</select></label>
      <label>调度站点<select aria-label="调度站点" value={filters.site} onChange={event => change({ site: event.target.value })}><option value="">全部调度站点</option>{(data?.sites ?? []).map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
      <label>上游渠道<select aria-label="上游渠道" value={filters.channel} onChange={event => change({ channel: event.target.value })}><option value="">全部上游渠道</option>{(data?.channels ?? []).map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></label>
      <label className="lc-search">{probe ? '模型 / 令牌 ID' : '搜索记录'}<div><input aria-label={probe ? '模型 / 令牌 ID' : '搜索记录'} type="search" maxLength={200} value={search} onChange={event => setSearch(event.target.value)} placeholder={probe ? '模型名或令牌 ID' : '操作、原因、渠道或模型'}/><button type="submit" aria-label="搜索日志"><MagnifyingGlass size={18}/></button></div></label>
    </form>
    {error && <div className="site-error lc-error" role="alert">{error}<button className="text-button" onClick={() => setRefresh(value => value + 1)}>重试</button></div>}
    {data?.warning && <p className="site-error" role="alert">{data.warning}</p>}
    <div className="lc-meta"><span>{total.toLocaleString('zh-CN')} 条记录{busy ? ' · 更新中…' : ''}</span><span>{data?.until && `截至 ${time(data.until)}`}{auto ? ' · 首页每 15 秒更新，展开时暂停' : ' · 已暂停自动更新'}</span></div>
    <div className="lc-list" aria-busy={busy}>
      <div className="lc-columns" aria-hidden="true"><span>时间</span><span>操作与原因</span><span>关联对象</span><span>结果</span><span/></div>
      {!items.length && <div className="lc-empty">{busy ? '正在读取日志…' : error ? '暂时无法读取日志，请重试。' : '此筛选条件下暂无日志。后续操作会自动记录。'}</div>}
      {items.map(entry => <details className="lc-record" key={entry.id} onToggle={event => {
        if (event.currentTarget.open) expanded.current.add(entry.id); else expanded.current.delete(entry.id)
      }}><summary>
        <time dateTime={entry.at}>{time(entry.at)}<small>{actors[entry.actor] || '后台任务'}</small></time>
        <div className="lc-event"><b>{entry.action}</b><span>{entry.message}</span></div>
        <div className="lc-target"><b>{entry.channelName || entry.accountName || entry.siteName || '监控服务'}</b><span>{entry.model || (entry.tokenId ? `令牌 #${entry.tokenId}` : entry.accountId ? `调度账号 #${entry.accountId}` : categories[entry.category])}</span></div>
        <span className={`lc-level ${entry.level}`}>{levels[entry.level] || '记录'}</span><CaretDown size={15} className="lc-caret"/>
      </summary><div className="lc-detail">
        <dl className="lc-context">{[['记录类型', categories[entry.category]], ['调度站点', entry.siteName || entry.siteId], ['上游渠道', entry.channelName || entry.channelId], ['令牌 ID', entry.tokenId], ['调度账号 ID', entry.accountId], ['调度线路名称', entry.accountName], ['模型', entry.model]].filter(([,value]) => value != null).map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        {Object.entries(entry.details || {}).filter(([key, value]) => detailLabels[key] && value != null).map(([key, value]) => <div className="lc-detail-row" key={key}><b>{detailLabels[key]}</b>{Array.isArray(value) ? <div><Paginated items={value} label={detailLabels[key]}>{models => <div className="lc-models">{models.length ? models.map((model, i) => <span key={i}>{model}</span>) : <span>无</span>}</div>}</Paginated></div> : <span>{valueLabel(value)}</span>}</div>)}
        <div className="lc-links">{entry.channelId && <a href={`#probes?channel=${encodeURIComponent(entry.channelId)}`}>查看该上游探针</a>}{entry.siteId && <a href={`#route-automation?site=${encodeURIComponent(entry.siteId)}`}>查看自动调度</a>}</div>
      </div></details>)}
    </div>
    <Pagination total={total} page={page} pageSize={data?.pageSize || pageSize} disabled={busy} label="日志" onPageChange={next => { expanded.current.clear(); setPage(next) }} onPageSizeChange={size => { expanded.current.clear(); setPage(1); setPageSize(normalizePageSize(size)) }}/>
    <p className="lc-note">操作记录保存在服务器数据库。旧版本仅能迁入当时保留的自动处理记录；每轮无变化的正常核对不重复记入操作记录。充值订单创建成功不代表已付款到账。</p>
  </section>
}
